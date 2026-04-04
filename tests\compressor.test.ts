import { describe, it, expect } from 'vitest';
import { Compressor, ConcatenationStrategy } from '../src/compressor';
import { InMemoryStore } from '../src/storage/in-memory';
import { TypedEmitter } from '../src/types';
import { createEngram } from '../src/engram';

describe('Compressor', () => {
  const makeEngram = (content: string, tags: string[], strength = 0.3) => {
    const engram = createEngram({
      content,
      type: 'episodic',
      source: 'agent-1',
      tags,
    });
    return { ...engram, strength };
  };

  describe('ConcatenationStrategy', () => {
    it('should concatenate memory contents', async () => {
      const strategy = new ConcatenationStrategy();
      const memories = [
        makeEngram('Memory A', ['tag1']),
        makeEngram('Memory B', ['tag1']),
      ];
      const result = await strategy.compress(memories);
      expect(result).toContain('Memory A');
      expect(result).toContain('Memory B');
      expect(result).toContain('Consolidated');
    });

    it('should truncate when exceeding max length', async () => {
      const strategy = new ConcatenationStrategy(50);
      const memories = [
        makeEngram('A very long memory content that should be truncated', ['tag1']),
        makeEngram('Another long memory', ['tag1']),
      ];
      const result = await strategy.compress(memories);
      expect(result.length).toBeLessThanOrEqual(200);  // prefix + truncated content
    });
  });

  describe('consolidate', () => {
    it('should compress groups of related weak memories', async () => {
      const compressor = new Compressor();
      const store = new InMemoryStore();
      const emitter = new TypedEmitter();

      // Add 4 memories sharing a tag, all weak
      for (let i = 0; i < 4; i++) {
        await store.put(makeEngram(`Event ${i} happened`, ['project-alpha']));
      }

      const results = await compressor.consolidate(store, emitter, {
        maxStrength: 0.5,
        minGroupSize: 3,
      });

      expect(results.length).toBe(1);
      expect(results[0].sourceIds.length).toBe(4);
      expect(results[0].compressed.compressedFrom.length).toBe(4);
      expect(results[0].compressed.type).toBe('semantic');
    });

    it('should not compress if fewer than minGroupSize', async () => {
      const compressor = new Compressor();
      const store = new InMemoryStore();
      const emitter = new TypedEmitter();

      await store.put(makeEngram('Memory 1', ['tag-a']));
      await store.put(makeEngram('Memory 2', ['tag-b']));

      const results = await compressor.consolidate(store, emitter, {
        minGroupSize: 3,
      });

      expect(results.length).toBe(0);
    });

    it('should mark source memories as compressed', async () => {
      const compressor = new Compressor();
      const store = new InMemoryStore();
      const emitter = new TypedEmitter();

      const originals = [];
      for (let i = 0; i < 3; i++) {
        const m = makeEngram(`Item ${i}`, ['shared-tag']);
        await store.put(m);
        originals.push(m);
      }

      await compressor.consolidate(store, emitter, { minGroupSize: 3 });

      for (const orig of originals) {
        const updated = await store.get(orig.id);
        expect(updated!.status).toBe('compressed');
      }
    });

    it('should inherit highest importance from sources', async () => {
      const compressor = new Compressor();
      const store = new InMemoryStore();
      const emitter = new TypedEmitter();

      const m1 = { ...makeEngram('Low', ['tag']), importance: 'low' as const };
      const m2 = { ...makeEngram('High', ['tag']), importance: 'high' as const };
      const m3 = { ...makeEngram('Med', ['tag']), importance: 'medium' as const };

      await store.put(m1);
      await store.put(m2);
      await store.put(m3);

      const results = await compressor.consolidate(store, emitter, { minGroupSize: 3 });
      expect(results[0].compressed.importance).toBe('high');
    });

    it('should merge tags from all source memories', async () => {
      const compressor = new Compressor();
      const store = new InMemoryStore();
      const emitter = new TypedEmitter();

      await store.put(makeEngram('A', ['shared', 'tag-a']));
      await store.put(makeEngram('B', ['shared', 'tag-b']));
      await store.put(makeEngram('C', ['shared', 'tag-c']));

      const results = await compressor.consolidate(store, emitter, { minGroupSize: 3 });
      const tags = results[0].compressed.tags;
      expect(tags).toContain('shared');
      expect(tags).toContain('tag-a');
      expect(tags).toContain('tag-b');
      expect(tags).toContain('tag-c');
    });

    it('should emit memory:compressed event', async () => {
      const compressor = new Compressor();
      const store = new InMemoryStore();
      const emitter = new TypedEmitter();

      let emittedResult: any = null;
      emitter.on('memory:compressed', (result) => { emittedResult = result; });

      for (let i = 0; i < 3; i++) {
        await store.put(makeEngram(`Item ${i}`, ['tag']));
      }

      await compressor.consolidate(store, emitter, { minGroupSize: 3 });
      expect(emittedResult).not.toBeNull();
      expect(emittedResult.sourceIds.length).toBe(3);
    });

    it('should group by type when groupByTags is false', async () => {
      const compressor = new Compressor();
      const store = new InMemoryStore();
      const emitter = new TypedEmitter();

      for (let i = 0; i < 3; i++) {
        await store.put(makeEngram(`Event ${i}`, [`unique-tag-${i}`]));
      }

      const results = await compressor.consolidate(store, emitter, {
        minGroupSize: 3,
        groupByTags: false,
      });

      expect(results.length).toBe(1); // All are 'episodic' type
    });
  });
});
