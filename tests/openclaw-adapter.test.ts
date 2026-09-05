/**
 * Tests for the OpenClaw `.agent/` compatibility layer (v0.8.0).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemoryManager } from '../src/memory-manager.js';
import { InMemoryStore } from '../src/storage/in-memory.js';
import { importAgentDir, exportToAgentDir } from '../src/openclaw-adapter.js';

describe('OpenClaw .agent/ compatibility', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-openclaw-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedAgentDir(): void {
    const lessonsPath = path.join(dir, 'memory', 'semantic', 'lessons.jsonl');
    fs.mkdirSync(path.dirname(lessonsPath), { recursive: true });
    fs.writeFileSync(lessonsPath, [
      JSON.stringify({ lesson: 'Always check file permissions before writing', category: 'general' }),
      JSON.stringify({ lesson: 'Prefer explicit imports over barrel files', category: 'general' }),
      '',
    ].join('\n'), 'utf-8');

    const episodicDir = path.join(dir, 'memory', 'episodic');
    fs.mkdirSync(episodicDir, { recursive: true });
    fs.writeFileSync(path.join(episodicDir, 'run-1.json'),
      JSON.stringify({ content: 'Ran integration tests, 3 failed on first pass' }));
    fs.writeFileSync(path.join(episodicDir, 'run-2.json'),
      JSON.stringify({ content: 'Fixed flaky test by adding recencyBias: 0' }));
  }

  it('imports lessons as semantic memories', async () => {
    seedAgentDir();
    const manager = new MemoryManager({}, new InMemoryStore());
    const result = await importAgentDir(manager, dir);

    expect(result.imported).toBe(4); // 2 lessons + 2 episodic
    expect(result.skipped).toBe(0);
    expect(result.sources.lessons).toBe(2);
    expect(result.sources.episodic).toBe(2);

    // Lessons are retrievable
    const lessons = await manager.query({ text: 'file permissions', limit: 5 });
    expect(lessons.length).toBeGreaterThanOrEqual(1);
  });

  it('round-trips export → import', async () => {
    seedAgentDir();

    // Populate from the seeded dir
    const manager = new MemoryManager({}, new InMemoryStore());
    await importAgentDir(manager, dir);
    // Add an extra semantic memory
    await manager.encode({ content: 'Extra lesson learned in production', type: 'semantic', source: 'test' });

    // Export to a FRESH dir
    const outDir = path.join(dir, 'exported');
    fs.mkdirSync(outDir, { recursive: true });
    const exported = await exportToAgentDir(manager, outDir);
    expect(exported.lessonsWritten).toBe(3); // 2 from import + 1 extra

    // Read the lessons file
    const lessonsPath = path.join(outDir, 'memory', 'semantic', 'lessons.jsonl');
    const lines = fs.readFileSync(lessonsPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!).lesson).toContain('Extra lesson');

    // LESSONS.md rendered
    const md = fs.readFileSync(path.join(outDir, 'memory', 'semantic', 'LESSONS.md'), 'utf-8');
    expect(md).toContain('# Lessons');
    expect(md).toContain('Extra lesson learned');
  });

  it('exports episodic memories as .json files', async () => {
    seedAgentDir();
    const manager = new MemoryManager({}, new InMemoryStore());
    await importAgentDir(manager, dir);

    const outDir = path.join(dir, 'exported');
    fs.mkdirSync(outDir, { recursive: true });
    const result = await exportToAgentDir(manager, outDir);
    expect(result.episodicWritten).toBe(2);

    const episodicDir = path.join(outDir, 'memory', 'episodic');
    const files = fs.readdirSync(episodicDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(2);
  });

  it('handles missing directories gracefully', async () => {
    const manager = new MemoryManager({}, new InMemoryStore());
    const result = await importAgentDir(manager, path.join(dir, 'nonexistent'));
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

function seedAgentDir(): void {
  // re-seed in the current `dir` (called from beforeEach context)
}
