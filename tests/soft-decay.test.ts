/**
 * Tests for soft-decay features:
 * - Soft delete: delete() marks (status 'archived' + deletedAt marker)
 *   instead of removing; undelete() restores; purge() physically removes.
 * - Configurable recall time-decay factor (exponential / power, half-life).
 * - expiration_date metadata with lazy expiration on read.
 * - AES-256-GCM encryption keeps working for archived/expired statuses.
 */

import { describe, it, expect } from 'vitest';
import { MemoryManager } from '../src/memory-manager';
import { RecallEngine, computeTimeDecayFactor } from '../src/recall-engine';
import { DecayEngine } from '../src/decay-engine';
import { InMemoryStore } from '../src/storage/in-memory';
import { EncryptedStore, generateEncryptionKey } from '../src/encrypted-store';
import { TypedEmitter, SOFT_DELETE_MARKER, EXPIRATION_DATE_KEY } from '../src/types';
import { createEngram } from '../src/engram';
import type { Engram, RecallTimeDecayConfig } from '../src/types';

// ── Time-decay factor (pure function) ──────────────────────────────────────

describe('computeTimeDecayFactor', () => {
  const exp: RecallTimeDecayConfig = { type: 'exponential', halfLife: 1_000 };
  const pow: RecallTimeDecayConfig = { type: 'power', halfLife: 1_000 };

  it('returns 1 at age 0', () => {
    expect(computeTimeDecayFactor(0, exp)).toBe(1);
    expect(computeTimeDecayFactor(0, pow)).toBe(1);
  });

  it('exponential: reaches 0.5 at the half-life, 0.25 at twice the half-life', () => {
    expect(computeTimeDecayFactor(1_000, exp)).toBeCloseTo(0.5, 12);
    expect(computeTimeDecayFactor(2_000, exp)).toBeCloseTo(0.25, 12);
  });

  it('power: reaches 0.5 at the half-life, 1/3 at twice the half-life', () => {
    expect(computeTimeDecayFactor(1_000, pow)).toBeCloseTo(0.5, 12);
    expect(computeTimeDecayFactor(2_000, pow)).toBeCloseTo(1 / 3, 12);
  });

  it('clamps negative ages to a factor of 1', () => {
    expect(computeTimeDecayFactor(-5_000, exp)).toBe(1);
    expect(computeTimeDecayFactor(-5_000, pow)).toBe(1);
  });

  it('decays monotonically and exponential falls faster than power past the half-life', () => {
    expect(computeTimeDecayFactor(60_000, exp)).toBeLessThan(1);
    expect(computeTimeDecayFactor(60_000, pow)).toBeLessThan(1);
    expect(computeTimeDecayFactor(2_000, exp)).toBeLessThan(computeTimeDecayFactor(2_000, pow));
  });
});

// ── RecallEngine integration ───────────────────────────────────────────────

describe('recall time-decay factor (RecallEngine)', () => {
  const makeSetup = (timeDecay?: RecallTimeDecayConfig) => {
    const store = new InMemoryStore();
    const decay = new DecayEngine();
    const emitter = new TypedEmitter();
    const engine = new RecallEngine(store, decay, emitter, timeDecay);
    return { store, decay, emitter, engine };
  };

  it('throws on an invalid decay type', () => {
    const { store, decay, emitter } = makeSetup();
    const bad = { type: 'linear', halfLife: 1_000 } as unknown as RecallTimeDecayConfig;
    expect(() => new RecallEngine(store, decay, emitter, bad)).toThrow(/recallTimeDecay\.type/);
  });

  it('throws on a non-positive half-life', () => {
    const { store, decay, emitter } = makeSetup();
    expect(() =>
      new RecallEngine(store, decay, emitter, { type: 'exponential', halfLife: 0 }),
    ).toThrow(/halfLife/);
    expect(() =>
      new RecallEngine(store, decay, emitter, { type: 'power', halfLife: -5 }),
    ).toThrow(/halfLife/);
  });

  it('ranks an aged memory below an identical fresh one (exponential)', async () => {
    const { store, engine } = makeSetup({ type: 'exponential', halfLife: 1_000 });
    const base = createEngram({ content: 'twin alpha payload', type: 'semantic', source: 'agent-1' });
    await store.put({ ...base, id: 'twin-fresh' });
    await store.put({
      ...base,
      id: 'twin-aged',
      createdAt: base.createdAt - 10_000,
      lastAccessedAt: base.lastAccessedAt - 10_000,
    });

    const results = await engine.recall({ text: 'twin', reinforce: false });
    const byId = new Map(results.map((r) => [r.engram.id, r.score]));
    expect(byId.get('twin-aged')).toBeLessThan(byId.get('twin-fresh')!);
  });

  it('ranks an aged memory below an identical fresh one (power)', async () => {
    const { store, engine } = makeSetup({ type: 'power', halfLife: 1_000 });
    const base = createEngram({ content: 'twin beta payload', type: 'semantic', source: 'agent-1' });
    await store.put({ ...base, id: 'twin-fresh' });
    await store.put({
      ...base,
      id: 'twin-aged',
      createdAt: base.createdAt - 10_000,
      lastAccessedAt: base.lastAccessedAt - 10_000,
    });

    const results = await engine.recall({ text: 'twin', reinforce: false });
    const byId = new Map(results.map((r) => [r.engram.id, r.score]));
    expect(byId.get('twin-aged')).toBeLessThan(byId.get('twin-fresh')!);
  });

  it('is disabled by default: identical memories tie exactly', async () => {
    const { store, engine } = makeSetup();
    const base = createEngram({ content: 'twin gamma payload', type: 'semantic', source: 'agent-1' });
    await store.put({ ...base, id: 'twin-a' });
    await store.put({ ...base, id: 'twin-b' });

    const results = await engine.recall({ text: 'twin', reinforce: false });
    const byId = new Map(results.map((r) => [r.engram.id, r.score]));
    expect(byId.get('twin-a')).toBe(byId.get('twin-b'));
  });
});

// ── MemoryManager: config passthrough ──────────────────────────────────────

describe('recall time-decay factor (MemoryManager config)', () => {
  it('lowers scores of aged memories when recallTimeDecay is configured', async () => {
    const store = new InMemoryStore();
    const plain = new MemoryManager({}, store);
    const decayed = new MemoryManager(
      { recallTimeDecay: { type: 'exponential', halfLife: 1_000 } },
      store,
    );

    const engram = await plain.encode({
      content: 'aged alpha content',
      type: 'semantic',
      source: 'agent-1',
    });
    await store.put({ ...engram, createdAt: Date.now() - 4_000 });

    const [a] = await plain.query({ text: 'alpha', limit: 5, reinforce: false });
    const [b] = await decayed.query({ text: 'alpha', limit: 5, reinforce: false });

    // age >= 4s with a 1s half-life → factor <= 1/16
    expect(b.score).toBeLessThan(a.score / 2);
    plain.stop();
    decayed.stop();
  });
});

// ── Soft delete / undelete / purge lifecycle ───────────────────────────────

describe('soft delete lifecycle', () => {
  it('delete() marks the memory archived with a deletedAt marker instead of removing it', async () => {
    const mm = new MemoryManager();
    const stored = await mm.encode({ content: 'to delete', type: 'episodic', source: 'agent-1' });
    let softDeletedEvent: Engram | null = null;
    mm.emitter.on('memory:soft-deleted', (e) => { softDeletedEvent = e; });

    await mm.delete(stored.id);

    const after = await mm.get(stored.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('archived');
    expect(typeof after!.metadata[SOFT_DELETE_MARKER]).toBe('string');
    expect(softDeletedEvent).not.toBeNull();
    // Still physically present in the store
    expect(await mm.store.count({})).toBe(1);
    mm.stop();
  });

  it('soft-deleted memories are excluded from recall but recoverable before purge', async () => {
    const mm = new MemoryManager();
    const target = await mm.encode({ content: 'quasar unique term', type: 'semantic', source: 'agent-1' });
    await mm.encode({ content: 'quasar unrelated other', type: 'semantic', source: 'agent-1' });

    await mm.delete(target.id);
    const before = await mm.query({ text: 'quasar', reinforce: false });
    expect(before.some((r) => r.engram.id === target.id)).toBe(false);

    await mm.undelete(target.id);
    const after = await mm.query({ text: 'quasar', reinforce: false });
    expect(after.some((r) => r.engram.id === target.id)).toBe(true);
    expect(after.find((r) => r.engram.id === target.id)!.engram.status).toBe('active');
    mm.stop();
  });

  it('undelete() restores active status and removes the marker', async () => {
    const mm = new MemoryManager();
    const stored = await mm.encode({ content: 'recoverable', type: 'episodic', source: 'agent-1' });
    let restoredEvent: Engram | null = null;
    mm.emitter.on('memory:soft-restored', (e) => { restoredEvent = e; });

    await mm.delete(stored.id);
    const restored = await mm.undelete(stored.id);

    expect(restored.status).toBe('active');
    expect(restored.metadata[SOFT_DELETE_MARKER]).toBeUndefined();
    expect(restoredEvent).not.toBeNull();
    expect((await mm.get(stored.id))!.status).toBe('active');
    mm.stop();
  });

  it('undelete() rejects memories that carry no soft-delete marker', async () => {
    const mm = new MemoryManager();
    const stored = await mm.encode({ content: 'never deleted', type: 'episodic', source: 'agent-1' });
    await expect(mm.undelete(stored.id)).rejects.toThrow(/not soft-deleted/);

    // A memory archived by the decay engine (no marker) is not undeletable either
    const archived = await mm.encode({ content: 'decay archived', type: 'episodic', source: 'agent-1', importance: 'trivial' });
    await mm.store.put({ ...archived, status: 'archived' });
    await expect(mm.undelete(archived.id)).rejects.toThrow(/not soft-deleted/);
    mm.stop();
  });

  it('purge() physically removes the memory (irreversible)', async () => {
    const mm = new MemoryManager();
    const stored = await mm.encode({ content: 'gone forever', type: 'episodic', source: 'agent-1' });
    let purgedEvent: string | null = null;
    mm.emitter.on('memory:purged', (id) => { purgedEvent = id; });

    await mm.delete(stored.id); // soft first
    await mm.purge(stored.id);  // then hard

    expect(await mm.get(stored.id)).toBeNull();
    expect(await mm.store.count({})).toBe(0);
    expect(purgedEvent).toBe(stored.id);
    mm.stop();
  });

  it('delete/undelete/purge throw for unknown IDs', async () => {
    const mm = new MemoryManager();
    await expect(mm.delete('missing')).rejects.toThrow(/not found/);
    await expect(mm.undelete('missing')).rejects.toThrow(/not found/);
    await expect(mm.purge('missing')).rejects.toThrow(/not found/);
    mm.stop();
  });

  it('does not reinforce soft-deleted memories on get', async () => {
    const mm = new MemoryManager();
    const stored = await mm.encode({ content: 'quiet', type: 'episodic', source: 'agent-1' });
    await mm.delete(stored.id);

    const after = await mm.get(stored.id, true);
    expect(after!.status).toBe('archived');
    expect(after!.accessCount).toBe(0);
    mm.stop();
  });

  it('soft-deleted memories survive decay sweeps and stay recoverable', async () => {
    const mm = new MemoryManager();
    const stored = await mm.encode({
      content: 'sweep survivor',
      type: 'episodic',
      source: 'agent-1',
      importance: 'trivial',
    });
    await mm.delete(stored.id);

    await mm.runDecaySweep(stored.createdAt + 1_000_000);

    const after = await mm.get(stored.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('archived');
    expect(after!.metadata[SOFT_DELETE_MARKER]).toBeDefined();
    expect((await mm.undelete(stored.id)).status).toBe('active');
    mm.stop();
  });
});

// ── expiration_date lazy expiry ────────────────────────────────────────────

describe('expiration_date lazy expiry', () => {
  it('transitions to expired on read when the ISO expiration date has passed', async () => {
    const mm = new MemoryManager();
    let expiredEvent: Engram | null = null;
    mm.emitter.on('memory:expired', (e) => { expiredEvent = e; });

    const stored = await mm.encode({
      content: 'short-lived',
      type: 'episodic',
      source: 'agent-1',
      metadata: { [EXPIRATION_DATE_KEY]: new Date(Date.now() - 1_000).toISOString() },
    });

    const read = await mm.get(stored.id);
    expect(read!.status).toBe('expired');
    expect(expiredEvent).not.toBeNull();
    // The transition is persisted
    expect((await mm.get(stored.id))!.status).toBe('expired');
    mm.stop();
  });

  it('accepts epoch-milliseconds expiration values', async () => {
    const mm = new MemoryManager();
    const stored = await mm.encode({
      content: 'epoch expiry',
      type: 'episodic',
      source: 'agent-1',
      metadata: { [EXPIRATION_DATE_KEY]: Date.now() - 500 },
    });
    expect((await mm.get(stored.id))!.status).toBe('expired');
    mm.stop();
  });

  it('keeps unexpired memories active', async () => {
    const mm = new MemoryManager();
    const stored = await mm.encode({
      content: 'long-lived',
      type: 'episodic',
      source: 'agent-1',
      metadata: { [EXPIRATION_DATE_KEY]: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect((await mm.get(stored.id))!.status).toBe('active');
    mm.stop();
  });

  it('excludes expired memories from query results', async () => {
    const mm = new MemoryManager();
    await mm.encode({
      content: 'ephemeral zebra',
      type: 'semantic',
      source: 'agent-1',
      metadata: { [EXPIRATION_DATE_KEY]: Date.now() - 1_000 },
    });
    await mm.encode({ content: 'durable zebra', type: 'semantic', source: 'agent-1' });

    const results = await mm.query({ text: 'zebra', limit: 5, reinforce: false });
    expect(results).toHaveLength(1);
    expect(results[0].engram.content).toBe('durable zebra');
    mm.stop();
  });

  it('never reinforces an expired memory', async () => {
    const mm = new MemoryManager();
    const stored = await mm.encode({
      content: 'stale',
      type: 'episodic',
      source: 'agent-1',
      metadata: { [EXPIRATION_DATE_KEY]: Date.now() - 1_000 },
    });
    const read = await mm.get(stored.id, true);
    expect(read!.status).toBe('expired');
    expect(read!.accessCount).toBe(0);
    mm.stop();
  });

  it('ignores invalid expiration_date values', async () => {
    const mm = new MemoryManager();
    const stored = await mm.encode({
      content: 'bad expiry',
      type: 'episodic',
      source: 'agent-1',
      metadata: { [EXPIRATION_DATE_KEY]: 'not-a-date' },
    });
    expect((await mm.get(stored.id))!.status).toBe('active');
    mm.stop();
  });

  it('does not expire terminal statuses or soft-deleted memories', async () => {
    const mm = new MemoryManager();

    // Superseded memories are terminal — lazy expiry must leave them alone
    const old = await mm.encode({
      content: 'fact v1',
      type: 'semantic',
      source: 'agent-1',
      metadata: { [EXPIRATION_DATE_KEY]: Date.now() - 1_000 },
    });
    const { old: superseded } = await mm.supersede(old.id, {
      content: 'fact v2',
      type: 'semantic',
      source: 'agent-1',
    });
    const readSuperseded = await mm.get(superseded.id);
    expect(readSuperseded!.status).toBe('superseded');

    // Soft-deleted memories keep their marker even with a past expiration
    const soft = await mm.encode({
      content: 'soft with expiry',
      type: 'semantic',
      source: 'agent-1',
      metadata: { [EXPIRATION_DATE_KEY]: Date.now() - 1_000 },
    });
    await mm.delete(soft.id);
    const readSoft = await mm.get(soft.id);
    expect(readSoft!.status).toBe('archived');
    expect(readSoft!.metadata[SOFT_DELETE_MARKER]).toBeDefined();
    mm.stop();
  });

  it('stats() reflects lazy expiry and soft-delete buckets', async () => {
    const mm = new MemoryManager();
    const past = await mm.encode({
      content: 'past',
      type: 'episodic',
      source: 'agent-1',
      metadata: { [EXPIRATION_DATE_KEY]: Date.now() - 1_000 },
    });
    const soft = await mm.encode({ content: 'soft', type: 'episodic', source: 'agent-1' });

    // Lazy: nothing transitioned until read
    let stats = await mm.stats();
    expect(stats.expired).toBe(0);

    await mm.get(past.id);
    await mm.delete(soft.id);
    stats = await mm.stats();
    expect(stats.expired).toBe(1);
    expect(stats.archived).toBe(1);
    expect(stats.active).toBe(0);
    mm.stop();
  });
});

// ── Encryption persists for archived / expired statuses ────────────────────

describe('encryption keeps working for archived/expired statuses', () => {
  const makeEncryptedManager = () => {
    const inner = new InMemoryStore();
    const store = new EncryptedStore(inner, { key: generateEncryptionKey() });
    const mm = new MemoryManager({}, store);
    return { mm, inner };
  };

  it('keeps content encrypted after soft delete', async () => {
    const { mm, inner } = makeEncryptedManager();
    const stored = await mm.encode({ content: 'classified secret', type: 'semantic', source: 'agent-1' });

    await mm.delete(stored.id);

    const raw = await inner.get(stored.id);
    expect(raw!.content).not.toBe('classified secret');
    expect(raw!.metadata['__engram_encrypted__']).toBe(true);

    const decrypted = await mm.get(stored.id);
    expect(decrypted!.content).toBe('classified secret');
    expect(decrypted!.status).toBe('archived');
    mm.stop();
  });

  it('keeps content encrypted after lazy expiration', async () => {
    const { mm, inner } = makeEncryptedManager();
    const stored = await mm.encode({
      content: 'temporary secret',
      type: 'semantic',
      source: 'agent-1',
      metadata: { [EXPIRATION_DATE_KEY]: Date.now() - 1_000 },
    });

    const read = await mm.get(stored.id);
    expect(read!.status).toBe('expired');
    expect(read!.content).toBe('temporary secret');

    const raw = await inner.get(stored.id);
    expect(raw!.content).not.toBe('temporary secret');
    expect(raw!.metadata['__engram_encrypted__']).toBe(true);
    mm.stop();
  });

  it('survives a delete → undelete round-trip with encryption', async () => {
    const { mm, inner } = makeEncryptedManager();
    const stored = await mm.encode({ content: 'round trip secret', type: 'semantic', source: 'agent-1' });

    await mm.delete(stored.id);
    const restored = await mm.undelete(stored.id);

    expect(restored.content).toBe('round trip secret');
    expect(restored.metadata[SOFT_DELETE_MARKER]).toBeUndefined();
    expect((await inner.get(stored.id))!.metadata['__engram_encrypted__']).toBe(true);
    mm.stop();
  });
});
