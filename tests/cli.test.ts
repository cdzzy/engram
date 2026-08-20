/**
 * Tests for the engram CLI (v0.6.0).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { main, CliError } from '../src/cli.js';
import { MemoryManager } from '../src/memory-manager.js';
import { FileStore } from '../src/storage/file-store.js';

function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const chunks: string[] = [];
  const errChunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  (process.stdout as unknown as { write: unknown }).write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  (process.stderr as unknown as { write: unknown }).write = (chunk: string | Uint8Array) => {
    errChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };

  function restore(): void {
    (process.stdout as unknown as { write: unknown }).write = origWrite;
    (process.stderr as unknown as { write: unknown }).write = origErr;
  }

  return fn().then(
    code => {
      restore();
      return { code, out: chunks.join(''), err: errChunks.join('') };
    },
    err => {
      restore();
      if (err instanceof CliError) {
        errChunks.unshift(`engram: ${err.message}\n`);
        return { code: err.exitCode, out: chunks.join(''), err: errChunks.join('') };
      }
      throw err;
    },
  );
}

describe('engram CLI', () => {
  let dir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-cli-'));
    const store = new FileStore(dir);
    await store.init();
    manager = new MemoryManager({}, store);
    manager.createSpace({ name: 'other', maxCapacity: 0, acl: { 'agent-2': ['write'] }, shared: false, consolidationInterval: 0 });
    await manager.encode({ content: 'User prefers dark mode', type: 'semantic', importance: 'high', source: 'agent-1', tags: ['preference'] });
    await manager.encode({ content: 'Meeting notes from standup', type: 'episodic', importance: 'medium', source: 'agent-1' });
    await manager.encode({ content: 'Weather was rainy today', type: 'episodic', importance: 'trivial', source: 'agent-2', namespace: 'other' });
    await store.flush();  // force _index.json so a second FileStore instance sees the data
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stats reports memory counts', async () => {
    const { code, out } = await capture(() => main(['node', 'engram', 'stats', '--storage', dir]));
    expect(code).toBe(0);
    expect(out).toContain('Memory statistics');
    expect(out).toContain('active:');
  });

  it('list shows memories', async () => {
    const { code, out } = await capture(() => main(['node', 'engram', 'list', '--storage', dir]));
    expect(code).toBe(0);
    expect(out).toContain('User prefers dark mode');
    expect(out).toContain('Meeting notes');
  });

  it('list filters by namespace', async () => {
    const { out } = await capture(() => main(['node', 'engram', 'list', '--storage', dir, '--namespace', 'other']));
    expect(out).toContain('Weather was rainy');
    expect(out).not.toContain('dark mode');
  });

  it('search finds matching memories', async () => {
    const { code, out } = await capture(() => main(['node', 'engram', 'search', 'dark mode', '--storage', dir]));
    expect(code).toBe(0);
    expect(out).toContain('dark mode');
  });

  it('show prints memory detail via short ID', async () => {
    const list = await capture(() => main(['node', 'engram', 'list', '--storage', dir, '--limit', '10']));
    const shortId = list.out.match(/^\s+([0-9a-f]{8})\s/m)?.[1];
    expect(shortId).toBeTruthy();
    const { code, out } = await capture(() => main(['node', 'engram', 'show', shortId!, '--storage', dir]));
    expect(code).toBe(0);
    expect(out).toContain('Memory ');
    expect(out).toContain('importance:');
    expect(out).toContain('namespace:');
  });

  it('forget requires --yes', async () => {
    const list = await capture(() => main(['node', 'engram', 'list', '--storage', dir, '--limit', '10']));
    const shortId = list.out.match(/^\s+([0-9a-f]{8})\s/m)?.[1];
    const { out } = await capture(() => main(['node', 'engram', 'forget', shortId!, '--storage', dir]));
    expect(out).toContain('--yes');

    const { code } = await capture(() => main(['node', 'engram', 'forget', shortId!, '--storage', dir, '--yes']));
    expect(code).toBe(0);
    // The CLI deletes the memory file immediately; the index flush is debounced,
    // so count memory files on disk rather than relying on a fresh index.
    const memoryFiles = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_index.json');
    expect(memoryFiles).toHaveLength(2);
  });

  it('help exits cleanly', async () => {
    const { code, out } = await capture(() => main(['node', 'engram', 'help']));
    expect(code).toBe(0);
    expect(out).toContain('Usage:');
  });

  it('unknown command fails', async () => {
    const { code, err } = await capture(() => main(['node', 'engram', 'bogus']));
    expect(code).toBe(1);
    expect(err).toContain('unknown command');
  });
});
