/**
 * Tests for v0.5.0 features:
 * - importanceScorer integration (#1)
 * - conflict resolution policies (#3)
 * - GraphMemory (#5)
 * - EncryptedStore (#8)
 */

import { describe, it, expect } from 'vitest';
import { MemoryManager } from '../src/memory-manager';
import { InMemoryStore } from '../src/storage/in-memory';
import { GraphMemory } from '../src/graph-memory';
import { EncryptedStore, generateEncryptionKey } from '../src/encrypted-store';
import type { ImportanceLevel, Engram } from '../src/types';

// ── Importance scorer integration (#1) ─────────────────────────────────────

describe('importanceScorer integration', () => {
  it('auto-scores importance when omitted', async () => {
    const scorer = async (content: string): Promise<ImportanceLevel> =>
      content.includes('password') ? 'critical' : 'low';

    const manager = new MemoryManager({ importanceScorer: scorer });
    const engram = await manager.encode({
      content: 'my password is hunter2',
      type: 'semantic',
      source: 'agent-1',
    });

    expect(engram.importance).toBe('critical');
  });

  it('respects explicit importance over auto-score', async () => {
    const scorer = async (): Promise<ImportanceLevel> => 'critical';
    const manager = new MemoryManager({ importanceScorer: scorer });
    const engram = await manager.encode({
      content: 'hello',
      type: 'semantic',
      source: 'agent-1',
      importance: 'trivial',
    });
    expect(engram.importance).toBe('trivial');
  });

  it('supports synchronous scorers', async () => {
    const manager = new MemoryManager({
      importanceScorer: () => 'high',
    });
    const engram = await manager.encode({
      content: 'anything',
      type: 'semantic',
      source: 'agent-1',
    });
    expect(engram.importance).toBe('high');
  });
});

// ── Conflict resolution (#3) ───────────────────────────────────────────────

describe('conflict resolution', () => {
  function engramFixture(overrides: Partial<Engram> = {}): Engram {
    return {
      id: 'id-1',
      content: 'existing content',
      type: 'semantic',
      importance: 'medium',
      status: 'active',
      strength: 1,
      stability: 1,
      lastAccessedAt: Date.now(),
      accessCount: 0,
      createdAt: Date.now(),
      tags: [],
      source: 'agent-a',
      namespace: 'shared',
      metadata: {},
      version: 1,
      previousVersionId: null,
      supersededBy: null,
      compressedFrom: [],
      embedding: null,
      ...overrides,
    };
  }

  it('last-writer-wins (default)', async () => {
    const manager = new MemoryManager();
    const existing = engramFixture();
    const incoming = engramFixture({ content: 'incoming content', source: 'agent-b' });
    const result = await manager.resolveConflict(existing, incoming, 'agent-b');
    expect(result.content).toBe('incoming content');
  });

  it('merge policy concatenates content', async () => {
    const manager = new MemoryManager({ conflictPolicy: 'merge' });
    const existing = engramFixture({ content: 'first part' });
    const incoming = engramFixture({ content: 'second part', tags: ['t1'] });
    const result = await manager.resolveConflict(existing, incoming, 'agent-b');
    expect(result.content).toContain('first part');
    expect(result.content).toContain('second part');
  });

  it('custom policy delegates to onConflict', async () => {
    const manager = new MemoryManager({
      conflictPolicy: 'custom',
      onConflict: async (existing, incoming) => ({
        ...incoming,
        content: `merged: ${existing.content} + ${incoming.content}`,
      }),
    });
    const existing = engramFixture({ content: 'A' });
    const incoming = engramFixture({ content: 'B' });
    const result = await manager.resolveConflict(existing, incoming, 'agent-b');
    expect(result.content).toBe('merged: A + B');
  });

  it('custom policy without resolver throws', async () => {
    const manager = new MemoryManager({ conflictPolicy: 'custom' });
    await expect(
      manager.resolveConflict(engramFixture(), engramFixture(), 'agent-b'),
    ).rejects.toThrow(/no onConflict/);
  });
});

// ── GraphMemory (#5) ───────────────────────────────────────────────────────

describe('GraphMemory', () => {
  it('extracts entities and relations', async () => {
    const graph = new GraphMemory();
    const result = await graph.store("Alice approved Bob's vacation request");
    expect(result.entities.length).toBeGreaterThanOrEqual(2);
    const relation = result.relations.find((r) => r.relation === 'approved');
    expect(relation).toBeDefined();
  });

  it('supports multi-hop traversal', async () => {
    const graph = new GraphMemory();
    await graph.store('Alice manages Bob');
    await graph.store('Bob works_with Carol');

    const result = graph.traverse('Alice', { maxHops: 2 });
    const names = result.map((n) => n.entity.name);
    expect(names).toContain('Alice');
    expect(names).toContain('Bob');
    expect(names).toContain('Carol');
  });

  it('findEntity is case-insensitive', async () => {
    const graph = new GraphMemory();
    await graph.store('Alice manages Bob');
    expect(graph.findEntity('alice')).not.toBeNull();
  });

  it('reports stats', async () => {
    const graph = new GraphMemory();
    await graph.store('Alice approves Bob');
    const stats = graph.stats();
    expect(stats.entities).toBeGreaterThanOrEqual(2);
    expect(stats.relations).toBeGreaterThanOrEqual(1);
  });
});

// ── EncryptedStore (#8) ────────────────────────────────────────────────────

describe('EncryptedStore', () => {
  it('encrypts content at rest and decrypts on read', async () => {
    const inner = new InMemoryStore();
    const store = new EncryptedStore(inner, { key: generateEncryptionKey() });

    const engram = engramFixture();
    await store.put(engram);

    // Content is encrypted in the inner store (not plaintext)
    const raw = await inner.get(engram.id);
    expect(raw!.content).not.toBe('existing content');
    expect(raw!.metadata!['__engram_encrypted__']).toBe(true);

    // Decrypted on read
    const restored = await store.get(engram.id);
    expect(restored!.content).toBe('existing content');
  });

  it('round-trips through query()', async () => {
    const inner = new InMemoryStore();
    const store = new EncryptedStore(inner, { key: generateEncryptionKey() });
    await store.put(engramFixture({ content: 'secret note', namespace: 'ns1' }));
    const results = await store.query({ namespace: 'ns1' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('secret note');
  });

  it('accepts a passphrase-derived key', async () => {
    const inner = new InMemoryStore();
    const store = new EncryptedStore(inner, { key: 'my-passphrase' });
    await store.put(engramFixture({ content: 'hello' }));
    const restored = await store.get('id-1');
    expect(restored!.content).toBe('hello');
  });

  it('reads key from environment via keySource', async () => {
    process.env.ENGRAM_TEST_KEY = generateEncryptionKey();
    const inner = new InMemoryStore();
    const store = new EncryptedStore(inner, { keySource: 'env:ENGRAM_TEST_KEY' });
    await store.put(engramFixture({ content: 'env-secret' }));
    const restored = await store.get('id-1');
    expect(restored!.content).toBe('env-secret');
    delete process.env.ENGRAM_TEST_KEY;
  });

  it('throws when no key is configured', () => {
    expect(() => new EncryptedStore(new InMemoryStore(), {})).toThrow(/key/);
  });
});

// ── Shared helper ──────────────────────────────────────────────────────────

function engramFixture(overrides: Partial<Engram> = {}): Engram {
  return {
    id: 'id-1',
    content: 'existing content',
    type: 'semantic',
    importance: 'medium',
    status: 'active',
    strength: 1,
    stability: 1,
    lastAccessedAt: Date.now(),
    accessCount: 0,
    createdAt: Date.now(),
    tags: [],
    source: 'agent-a',
    namespace: 'shared',
    metadata: {},
    version: 1,
    previousVersionId: null,
    supersededBy: null,
    compressedFrom: [],
    embedding: null,
    ...overrides,
  };
}
