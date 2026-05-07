import type {
  Engram,
  DecayConfig,
  MemoryStore,
  TypedEmitter,
} from './types';
import { DEFAULT_DECAY_CONFIG, IMPORTANCE_WEIGHTS } from './types';

/**
 * Ebbinghaus-inspired forgetting curve engine.
 *
 * Core formula:  R(t) = e^(-t / S)
 *   R = retention (0–1)
 *   t = time elapsed since last access (ms)
 *   S = effective stability = baseHalfLife × stability × importanceMultiplier
 *
 * Stability increases with each successful recall (spacing effect).
 * The decay engine also handles reinforcement when memories are accessed.
 */
export class DecayEngine {
  private config: DecayConfig;

  constructor(config?: Partial<DecayConfig>) {
    this.config = { ...DEFAULT_DECAY_CONFIG, ...config };
  }

  /** Calculate current retention strength for a memory at a given time. */
  calculateStrength(engram: Engram, now: number = Date.now()): number {
    const elapsed = Math.max(0, now - engram.lastAccessedAt);
    const effectiveStability = this.getEffectiveStability(engram);

    // R(t) = e^(-t / S)
    const retention = Math.exp(-elapsed / effectiveStability);
    return Math.max(0, Math.min(1, retention));
  }

  /** Get effective stability = baseHalfLife × stability × importanceMultiplier × memoryTypeMultiplier × accessFrequency */
  getEffectiveStability(engram: Engram): number {
    const importanceMult = this.config.importanceMultiplier[engram.importance];
    const typeMult = this.config.memoryTypeMultiplier?.[engram.type] ?? 1.0;
    const freqFactor = this.config.accessFrequencyFactor ?? 0;
    const accessBoost = 1 + Math.log1p(engram.accessCount) * freqFactor;

    // Effective half-life = baseHalfLife × typeMult
    // S = halfLife / ln(2) × stability × importanceMult × accessBoost
    const effectiveHalfLife = this.config.baseHalfLife * typeMult;
    const decayConstant = effectiveHalfLife / Math.LN2;
    return decayConstant * engram.stability * importanceMult * accessBoost;
  }

  /**
   * Reinforce a memory after a successful recall.
   * Applies the spacing effect — stability grows with each access.
   * @param usefulness - Optional 0–1 score indicating how useful the recall was.
   *                    1.0 = fully useful (full boost), 0.0 = not useful (no boost).
   */
  reinforce(engram: Engram, now: number = Date.now(), usefulness?: number): Engram {
    const boostFactor = usefulness !== undefined
      ? 1 + (this.config.recallBoostFactor - 1) * Math.max(0, Math.min(1, usefulness))
      : this.config.recallBoostFactor;
    const newStability = engram.stability * boostFactor;
    return {
      ...engram,
      strength: 1.0,  // Reset to full strength on recall
      stability: newStability,
      lastAccessedAt: now,
      accessCount: engram.accessCount + 1,
    };
  }

  /**
   * Run a decay sweep across all memories in the store.
   * Updates strength values and transitions status based on thresholds.
   * Returns lists of memories that changed status.
   */
  async sweep(
    store: MemoryStore,
    emitter: TypedEmitter,
    now: number = Date.now(),
  ): Promise<SweepResult> {
    const active = await store.query({ status: ['active', 'decayed'] });
    const result: SweepResult = { decayed: [], archived: [], forgotten: [] };

    for (const engram of active) {
      const oldStrength = engram.strength;
      const newStrength = this.calculateStrength(engram, now);

      if (Math.abs(newStrength - oldStrength) < 0.0001 && engram.status !== 'active') {
        continue;
      }

      const updated = { ...engram, strength: newStrength };

      if (newStrength <= this.config.forgetThreshold) {
        updated.status = 'forgotten';
        await store.put(updated);
        result.forgotten.push(updated);
        emitter.emit('memory:forgotten', updated);
      } else if (newStrength <= this.config.archiveThreshold) {
        updated.status = 'archived';
        await store.put(updated);
        result.archived.push(updated);
        emitter.emit('memory:archived', updated);
      } else if (newStrength <= this.config.decayThreshold) {
        if (engram.status === 'active') {
          updated.status = 'decayed';
          emitter.emit('memory:decayed', updated, oldStrength, newStrength);
        }
        await store.put(updated);
        result.decayed.push(updated);
      } else {
        await store.put(updated);
      }
    }

    return result;
  }

  /** Predict when a memory will drop below a given threshold. */
  predictDecayTime(engram: Engram, threshold: number = this.config.decayThreshold): number {
    const S = this.getEffectiveStability(engram);
    // R(t) = e^(-t/S)  →  t = -S × ln(threshold)
    return -S * Math.log(threshold);
  }

  getConfig(): Readonly<DecayConfig> {
    return { ...this.config };
  }
}

export interface SweepResult {
  decayed: Engram[];
  archived: Engram[];
  forgotten: Engram[];
}

