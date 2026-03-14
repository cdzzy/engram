import type {
  Engram,
  MemoryStore,
  RecallQuery,
  RecallResult,
  RecallSignals,
  TypedEmitter,
} from './types';
import { IMPORTANCE_WEIGHTS } from './types';
import { DecayEngine } from './decay-engine';

/**
 * Multi-signal recall engine.
 *
 * Ranks memories by combining 4 weighted signals:
 *   1. Recency   — how recently the memory was accessed
 *   2. Strength  — current forgetting-curve retention
 *   3. Relevance — text similarity to query
 *   4. Importance — declared importance level
 *
 * Each signal produces a score in [0, 1], combined via weighted sum.
 */
export class RecallEngine {
  private store: MemoryStore;
  private decay: DecayEngine;
  private emitter: TypedEmitter;

  constructor(store: MemoryStore, decay: DecayEngine, emitter: TypedEmitter) {
    this.store = store;
    this.decay = decay;
    this.emitter = emitter;
  }

  async recall(query: RecallQuery): Promise<RecallResult[]> {
    const {
      text,
      tags,
      type,
      namespace,
      minStrength = 0,
      limit = 10,
      recencyBias = 0.3,
      strengthBias = 0.3,
      relevanceBias = 0.25,
      importanceBias = 0.15,
      reinforce = true,
    } = query;

    // Build filter to narrow candidates
    const candidates = await this.store.query({
      namespace,
      type,
      tags,
      status: ['active', 'decayed'],
      minStrength,
    });

    if (candidates.length === 0) return [];

    const now = Date.now();

    // Compute time range for recency normalization
    const accessTimes = candidates.map(m => m.lastAccessedAt);
    const minTime = Math.min(...accessTimes);
    const maxTime = Math.max(...accessTimes);
    const timeRange = maxTime - minTime || 1;

    // Score each candidate
    const scored: RecallResult[] = candidates.map(engram => {
      const signals = this.computeSignals(engram, now, text, minTime, timeRange);

      const score =
        signals.recency * recencyBias +
        signals.strength * strengthBias +
        signals.relevance * relevanceBias +
        signals.importance * importanceBias;

      return { engram, score, signals };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Take top results
    const results = scored.slice(0, limit);

    // Reinforce recalled memories (spacing effect)
    if (reinforce) {
      for (const result of results) {
        const reinforced = this.decay.reinforce(result.engram, now);
        await this.store.put(reinforced);
        this.emitter.emit('memory:recalled', reinforced);
        this.emitter.emit(
          'memory:strengthened',
          reinforced,
          result.engram.strength,
          reinforced.strength,
        );
        result.engram = reinforced;
      }
    }

    return results;
  }

  private computeSignals(
    engram: Engram,
    now: number,
    queryText: string | undefined,
    minTime: number,
    timeRange: number,
  ): RecallSignals {
    // 1. Recency: normalized [0, 1] based on lastAccessedAt
    const recency = (engram.lastAccessedAt - minTime) / timeRange;

    // 2. Strength: current forgetting-curve value
    const strength = this.decay.calculateStrength(engram, now);

    // 3. Relevance: text matching score
    const relevance = queryText ? this.computeRelevance(engram, queryText) : 0.5;

    // 4. Importance: weight from importance level
    const importance = IMPORTANCE_WEIGHTS[engram.importance];

    return { recency, strength, relevance, importance };
  }

  /**
   * Simple text relevance scoring.
   * Combines: exact substring match, word overlap (Jaccard), and tag matching.
   * For production, replace with embedding cosine similarity.
   */
  private computeRelevance(engram: Engram, queryText: string): number {
    const contentLower = engram.content.toLowerCase();
    const queryLower = queryText.toLowerCase();

    // Exact substring match gets a high base score
    if (contentLower.includes(queryLower)) return 1.0;

    // Word overlap (Jaccard similarity)
    const queryWords = new Set(queryLower.split(/\s+/).filter(w => w.length > 1));
    const contentWords = new Set(contentLower.split(/\s+/).filter(w => w.length > 1));

    if (queryWords.size === 0) return 0;

    let overlap = 0;
    for (const word of queryWords) {
      if (contentWords.has(word)) overlap++;
    }

    const jaccard = overlap / queryWords.size;

    // Tag match bonus
    const tagBonus = engram.tags.some(t =>
      queryLower.includes(t.toLowerCase()),
    ) ? 0.2 : 0;

    return Math.min(1, jaccard + tagBonus);
  }
}
