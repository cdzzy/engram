import { describe, it, expect } from 'vitest';
import { RecallEngine } from '../src/recall-engine';
import { DecayEngine } from '../src/decay-engine';
import { InMemoryStore } from '../src/storage/in-memory';
import { TypedEmitter } from '../src/types';
import { createEngram } from '../src/engram';

describe('RecallEngine', () => {
  const makeSetup = () => {
    const store = new InMemoryStore();
    const decay = new DecayEngine();
    const emitter = new TypedEmitter();
    const engine = new RecallEngine(store, decay, emitter);
    return { store, decay, emitter, engine };
  };

  const makeAndStore = async (
    store: any,
    content: string,
    options: Record<string, any> = {},
  ) => {
    const engram = createEngram({
      content,
      type: options.type ?? 'episodic',
      source: options.source ?? 'agent-1',
      importance: options.importance,
      tags: options.tags,
      namespace: options.namespace,
    });
    const patched = {
      ...engram,
      ...options.overrides,
    };
    await store.put(patched);
    return patched;
  };

  describe('recall', () => {
    it('should return memories matching text query', async () => {
      const { store, engine } = makeSetup();
      await makeAndStore(store, 'The user prefers dark mode');
      await makeAndStore(store, 'The API key was rotated');
      await makeAndStore(store, 'User selected dark theme option');

      const results = await engine.recall({
        text: 'dark mode',
        reinforce: false,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].engram.content).toContain('dark');
    });

    it('should rank by combined signals', async () => {
      const { store, engine } = makeSetup();

      // High importance, recent
      await makeAndStore(store, 'Critical system alert', {
        importance: 'critical',
      });

      // Low importance
      await makeAndStore(store, 'Minor log entry', {
        importance: 'trivial',
      });

      const results = await engine.recall({
        text: 'system',
        limit: 2,
        reinforce: false,
      });

      // Critical should rank higher
      expect(results[0].engram.importance).toBe('critical');
    });

    it('should filter by tags', async () => {
      const { store, engine } = makeSetup();
      await makeAndStore(store, 'Meeting notes', { tags: ['meetings'] });
      await makeAndStore(store, 'Code review', { tags: ['engineering'] });

      const results = await engine.recall({
        tags: ['meetings'],
        reinforce: false,
      });

      expect(results.length).toBe(1);
      expect(results[0].engram.content).toBe('Meeting notes');
    });

    it('should filter by namespace', async () => {
      const { store, engine } = makeSetup();
      await makeAndStore(store, 'In ns-A', { namespace: 'ns-A' });
      await makeAndStore(store, 'In ns-B', { namespace: 'ns-B' });

      const results = await engine.recall({
        namespace: 'ns-A',
        reinforce: false,
      });

      expect(results.length).toBe(1);
      expect(results[0].engram.content).toBe('In ns-A');
    });

    it('should filter by memory type', async () => {
      const { store, engine } = makeSetup();
      await makeAndStore(store, 'An episode', { type: 'episodic' });
      await makeAndStore(store, 'A fact', { type: 'semantic' });

      const results = await engine.recall({
        type: 'semantic',
        reinforce: false,
      });

      expect(results.length).toBe(1);
      expect(results[0].engram.type).toBe('semantic');
    });

    it('should respect limit', async () => {
      const { store, engine } = makeSetup();
      for (let i = 0; i < 10; i++) {
        await makeAndStore(store, `Memory ${i}`);
      }

      const results = await engine.recall({ limit: 3, reinforce: false });
      expect(results.length).toBe(3);
    });

    it('should reinforce recalled memories', async () => {
      const { store, engine } = makeSetup();
      const original = await makeAndStore(store, 'Reinforceable memory');

      const results = await engine.recall({
        text: 'Reinforceable',
        reinforce: true,
      });

      expect(results.length).toBe(1);
      expect(results[0].engram.accessCount).toBe(original.accessCount + 1);
      expect(results[0].engram.strength).toBe(1.0); // Reset to full
    });

    it('should return empty array for no matches', async () => {
      const { engine } = makeSetup();
      const results = await engine.recall({ text: 'nonexistent' });
      expect(results).toEqual([]);
    });

    it('should include signal breakdown in results', async () => {
      const { store, engine } = makeSetup();
      await makeAndStore(store, 'Test memory');

      const results = await engine.recall({
        text: 'Test',
        reinforce: false,
      });

      expect(results[0].signals).toHaveProperty('recency');
      expect(results[0].signals).toHaveProperty('strength');
      expect(results[0].signals).toHaveProperty('relevance');
      expect(results[0].signals).toHaveProperty('importance');
      expect(results[0].score).toBeGreaterThan(0);
    });
  });
});
