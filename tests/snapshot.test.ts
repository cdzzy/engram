/**
 * Tests for snapshot export/import (v0.7.0) — MemoryManager API + CLI commands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemoryManager } from '../src/memory-manager.js';
import { InMemoryStore } from '../src/storage/in-memory.js';
import { FileStore } from '../src/storage/file-store.js';
import { main, CliError } from '../src/cli.js';

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
    code => { restore(); return { code, out: chunks.join(''), err: errChunks.join('') }; },
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

describe('MemoryManager snapshots', () => {
  it('exports and imports a lossless round-trip', async () => {
    const source = new MemoryManager({}, new InMemoryStore());
    const m1 = await source.encode({ content: 'User prefers dark mode', type: 'semantic', importance: 'high', source: 'a1', tags: ['pref'] });
    const m2 = await source.encode({ content: 'Meeting notes', type: 'episodic', source: 'a1' });

    const snapshot = await source.exportSnapshot();
    expect(snapshot.count).toBe(2);
    expect(snapshot.memories.length).toBe(2);

    // Restore into a fresh store
    const target = new MemoryManager({}, new InMemoryStore());
    const result = await target.importSnapshot(snapshot);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);

    // Full fidelity: same ids, content, timestamps, strength
    const restored1 = await target.get(m1.id);
    expect(restored1).not.toBeNull();
    expect(restored1!.content).toBe(m1.content);
    expect(restored1!.createdAt).toBe(m1.createdAt);
    expect(restored1!.strength).toBe(m1.strength);
    expect(restored1!.tags).toEqual(m1.tags);
    const restored2 = await target.get(m2.id);
    expect(restored2!.content).toBe(m2.content);
  });

  it('round-trips through a file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-snap-'));
    try {
      const file = path.join(dir, 'snapshot.json');
      const source = new MemoryManager({}, new InMemoryStore());
      await source.encode({ content: 'persistent fact', type: 'semantic', source: 'a1' });
      await source.exportSnapshot(file);

      const target = new MemoryManager({}, new InMemoryStore());
      const result = await target.importSnapshot(file);
      expect(result.imported).toBe(1);

      const results = await target.query({ text: 'persistent fact' });
      expect(results.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips duplicates by default, overwrites with overwrite option', async () => {
    const source = new MemoryManager({}, new InMemoryStore());
    await source.encode({ content: 'fact one', type: 'semantic', source: 'a1' });

    const snapshot = await source.exportSnapshot();
    const target = new MemoryManager({}, new InMemoryStore());

    const first = await target.importSnapshot(snapshot);
    expect(first.imported).toBe(1);

    // Same snapshot again → skipped (ids exist)
    const second = await target.importSnapshot(snapshot);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);

    // With overwrite → re-imported
    const third = await target.importSnapshot(snapshot, { overwrite: true });
    expect(third.imported).toBe(1);
  });

  it('rejects invalid snapshots', async () => {
    const target = new MemoryManager({}, new InMemoryStore());
    await expect(target.importSnapshot({ version: 1 } as never)).rejects.toThrow(/memories/);
  });
});

describe('engram CLI export/import', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-snapcli-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exports and imports through the CLI', async () => {
    const filesDir = path.join(dir, 'files');
    fs.mkdirSync(filesDir);
    const seedFile = path.join(filesDir, 'seed.json');
    const snapFile = path.join(filesDir, 'snapshot.json');

    // Seed a source store and export
    const source = new MemoryManager({}, new InMemoryStore());
    await source.encode({ content: 'exported memory', type: 'semantic', source: 'a1' });
    await source.exportSnapshot(seedFile);

    // CLI import into the store dir
    const imp = await capture(() => main(['node', 'engram', 'import', seedFile, '--storage', dir]));
    expect(imp.code).toBe(0);
    expect(imp.out).toContain('Imported 1');

    // CLI export back out
    const exp = await capture(() => main(['node', 'engram', 'export', snapFile, '--storage', dir]));
    expect(exp.code).toBe(0);
    expect(exp.out).toContain('Exported 1');

    // The round-tripped snapshot contains the memory
    const data = JSON.parse(fs.readFileSync(snapFile, 'utf-8'));
    expect(data.count).toBe(1);
    expect(data.memories[0].content).toBe('exported memory');
  });

  it('import requires a file argument', async () => {
    const { code, err } = await capture(() => main(['node', 'engram', 'import', '--storage', dir]));
    expect(code).toBe(1);
    expect(err).toContain('requires a snapshot FILE');
  });
});
