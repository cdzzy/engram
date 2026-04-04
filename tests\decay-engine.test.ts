import { describe, it, expect } from 'vitest';
import { createEngram } from '../src/engram';
import { DecayEngine } from '../src/decay-engine';
import { TypedEmitter, DEFAULT_DECAY_CONFIG } from '../src/types';
import { InMemoryStore } from '../src/storage/in-memory';

describe('DecayEngine', () => {
  const makeEngram = (overrides = {}) =>
    createEngram({
      content: 'test memory',
      type: 'episodic',
      source: 'agent-1',
      ...overrides,
    });

  describe('calculateStrength', () => {
    it('should return 1.0 for a freshly created memory', () => {
      const engine = new DecayEngine();
      const engram = makeEngram();
      const strength = engine.calculateStrength(engram, engram.createdAt);
      expect(strength).toBeCloseTo(1.0, 5);
    });

    it('should decay over time', () => {
      const engine = new DecayEngine();
      const engram = makeEngram();
      const oneHourLater = engram.createdAt + 3_600_000;
      const strength = engine.calculateStrength(engram, oneHourLater);
      expect(strength).toBeLessThan(1.0);
      expect(strength).toBeGreaterThan(0);
    });

    it('should decay faster for trivial memories', () => {
      const engine = new DecayEngine();
      const trivial = makeEngram({ importance: 'trivial' });
      const critical = makeEngram({ importance: 'critical' });

      const later = trivial.createdAt + 3_600_000;
      const trivialStrength = engine.calculateStrength(trivial, later);
      const criticalStrength = engine.calculateStrength(critical, later);

      expect(trivialStrength).toBeLessThan(criticalStrength);
    });

    it('should clamp strength between 0 and 1', () => {
      const engine = new DecayEngine();
      const engram = makeEngram({ importance: 'trivial' });
      const veryLate = engram.createdAt + 1_000_000_000;
      const strength = engine.calculateStrength(engram, veryLate);
      expect(strength).toBeGreaterThanOrEqual(0);
      expect(strength).toBeLessThanOrEqual(1);
    });
  });

  describe('reinforce', () => {
    it('should reset strength to 1.0', () => {
      const engine = new DecayEngine();
      const engram = { ...makeEngram(), strength: 0.3 };
      const reinforced = engine.reinforce(engram);
      expect(reinforced.strength).toBe(1.0);
    });

    it('should increase stability', () => {
      const engine = new DecayEngine();
      const engram = makeEngram();
      const reinforced = engine.reinforce(engram);
      expect(reinforced.stability).toBeGreaterThan(engram.stability);
    });

    it('should increment accessCount', () => {
      const engine = new DecayEngine();
      const engram = makeEngram();
      expect(engram.accessCount).toBe(0);
      const reinforced = engine.reinforce(engram);
      expect(reinforced.accessCount).toBe(1);
    });

    it('should apply spacing effect — more recalls = slower decay', () => {
      const engine = new DecayEngine();
      let engram = makeEngram();

      // Reinforce 5 times
      for (let i = 0; i < 5; i++) {
        engram = engine.reinforce(engram);
      }

      const oneHourLater = engram.lastAccessedAt + 3_600_000;
      const reinforcedStrength = engine.calculateStrength(engram, oneHourLater);

      const fresh = makeEngram();
      const freshStrength = engine.calculateStrength(fresh, fresh.createdAt + 3_600_000);

      expect(reinforcedStrength).toBeGreaterThan(freshStrength);
    });
  });

  describe('sweep', () => {
    it('should transition active memories to decayed status', async () => {
      const engine = new DecayEngine({
        baseHalfLife: 100,          // Very short for testing
        importanceMultiplier: {
          ...DEFAULT_DECAY_CONFIG.importanceMultiplier,
          medium: 1.0,
        },
      });
      const store = new InMemoryStore();
      const emitter = new TypedEmitter();
      const engram = makeEngram();
      await store.put(engram);

      // Sweep far into the future
      const result = await engine.sweep(store, emitter, engram.createdAt + 500);
      expect(result.decayed.length + result.archived.length + result.forgotten.length)
        .toBeGreaterThan(0);
    });

    it('should mark very weak memories as forgotten', async () => {
      const engine = new DecayEngine({ baseHalfLife: 10 });
      const store = new InMemoryStore();
      const emitter = new TypedEmitter();
      const engram = makeEngram({ importance: 'trivial' });
      await store.put(engram);

      const result = await engine.sweep(store, emitter, engram.createdAt + 1_000_000);
      expect(result.forgotten.length).toBe(1);
    });
  });

  describe('predictDecayTime', () => {
    it('should predict when memory drops below threshold', () => {
      const engine = new DecayEngine();
      const engram = makeEngram();
      const time = engine.predictDecayTime(engram, 0.5);
      expect(time).toBeGreaterThan(0);
      expect(time).toBeLessThan(Infinity);
    });

    it('should predict longer decay for critical memories', () => {
      const engine = new DecayEngine();
      const trivial = makeEngram({ importance: 'trivial' });
      const critical = makeEngram({ importance: 'critical' });

      const trivialTime = engine.predictDecayTime(trivial, 0.5);
      const criticalTime = engine.predictDecayTime(critical, 0.5);

      expect(criticalTime).toBeGreaterThan(trivialTime);
    });
  });
});
