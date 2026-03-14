import { randomUUID } from 'crypto';
import type {
  Engram,
  MemoryStore,
  CompressionStrategy,
  CompressionResult,
  TypedEmitter,
} from './types';

/**
 * Default compression strategy: concatenates memory contents with separators.
 * In production, replace this with an LLM-backed strategy that produces
 * true semantic summaries.
 */
export class ConcatenationStrategy implements CompressionStrategy {
  private maxLength: number;

  constructor(maxLength: number = 1000) {
    this.maxLength = maxLength;
  }

  async compress(memories: Engram[]): Promise<string> {
    const sorted = [...memories].sort((a, b) => b.strength - a.strength);
    const parts: string[] = [];
    let totalLength = 0;

    for (const m of sorted) {
      const entry = `[${m.type}] ${m.content}`;
      if (totalLength + entry.length > this.maxLength) {
        parts.push(entry.slice(0, this.maxLength - totalLength) + '...');
        break;
      }
      parts.push(entry);
      totalLength += entry.length;
    }

    return `Consolidated (${memories.length} memories): ${parts.join(' | ')}`;
  }
}

/**
 * Memory compressor that consolidates related weak memories into summaries.
 *
 * Compression levels:
 *   L0 (raw)       → Individual episodic memories
 *   L1 (summary)   → Group of related memories compressed into one
 *   L2 (abstract)  → Group of L1 summaries compressed into higher-level knowledge
 */
export class Compressor {
  private strategy: CompressionStrategy;

  constructor(strategy?: CompressionStrategy) {
    this.strategy = strategy ?? new ConcatenationStrategy();
  }

  /**
   * Find groups of related memories eligible for compression
   * and compress each group into a single summary memory.
   */
  async consolidate(
    store: MemoryStore,
    emitter: TypedEmitter,
    options: ConsolidateOptions = {},
  ): Promise<CompressionResult[]> {
    const {
      namespace,
      maxStrength = 0.5,
      minGroupSize = 3,
      groupByTags = true,
    } = options;

    // Find weak, active memories eligible for compression
    const candidates = await store.query({
      namespace,
      status: ['active', 'decayed'],
      maxStrength,
    });

    if (candidates.length < minGroupSize) return [];

    // Group candidates by similarity
    const groups = groupByTags
      ? this.groupBySharedTags(candidates, minGroupSize)
      : this.groupByType(candidates, minGroupSize);

    const results: CompressionResult[] = [];

    for (const group of groups) {
      const result = await this.compressGroup(group, store, emitter);
      if (result) results.push(result);
    }

    return results;
  }

  /** Compress a single group of memories into one summary engram. */
  async compressGroup(
    memories: Engram[],
    store: MemoryStore,
    emitter: TypedEmitter,
  ): Promise<CompressionResult | null> {
    if (memories.length < 2) return null;

    const compressedContent = await this.strategy.compress(memories);
    const sourceIds = memories.map(m => m.id);

    // Inherit best attributes from source memories
    const maxImportance = memories.reduce(
      (best, m) => {
        const order = ['critical', 'high', 'medium', 'low', 'trivial'];
        return order.indexOf(m.importance) < order.indexOf(best) ? m.importance : best;
      },
      'trivial' as Engram['importance'],
    );

    // Merge all tags
    const allTags = [...new Set(memories.flatMap(m => m.tags))];

    const compressed: Engram = {
      id: randomUUID(),
      content: compressedContent,
      type: 'semantic',  // Compressed memories become semantic knowledge
      importance: maxImportance,
      status: 'active',
      strength: 0.8,     // Compressed memories start fairly strong
      stability: Math.max(...memories.map(m => m.stability)) * 1.2,
      lastAccessedAt: Date.now(),
      accessCount: 0,
      createdAt: Date.now(),
      tags: allTags,
      source: memories[0].source,
      namespace: memories[0].namespace,
      metadata: { compressionLevel: this.getCompressionLevel(memories) },
      version: 1,
      previousVersionId: null,
      supersededBy: null,
      compressedFrom: sourceIds,
      embedding: null,
    };

    // Store the compressed memory
    await store.put(compressed);

    // Mark source memories as compressed
    for (const m of memories) {
      await store.put({ ...m, status: 'compressed' });
    }

    const result: CompressionResult = {
      compressed,
      sourceIds,
      compressionRatio: memories.length,
    };

    emitter.emit('memory:compressed', result);
    return result;
  }

  private getCompressionLevel(memories: Engram[]): number {
    const hasCompressed = memories.some(m => m.compressedFrom.length > 0);
    return hasCompressed ? 2 : 1;
  }

  /** Group memories that share at least one tag. */
  private groupBySharedTags(memories: Engram[], minSize: number): Engram[][] {
    const tagMap = new Map<string, Engram[]>();

    for (const m of memories) {
      if (m.tags.length === 0) {
        // Untagged memories go to a special group
        const key = `__untagged__${m.type}`;
        if (!tagMap.has(key)) tagMap.set(key, []);
        tagMap.get(key)!.push(m);
      } else {
        for (const tag of m.tags) {
          if (!tagMap.has(tag)) tagMap.set(tag, []);
          tagMap.get(tag)!.push(m);
        }
      }
    }

    // Deduplicate: pick the largest group for each memory
    const assigned = new Set<string>();
    const groups: Engram[][] = [];

    const sortedTags = [...tagMap.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [, group] of sortedTags) {
      const unassigned = group.filter(m => !assigned.has(m.id));
      if (unassigned.length >= minSize) {
        groups.push(unassigned);
        for (const m of unassigned) assigned.add(m.id);
      }
    }

    return groups;
  }

  /** Fallback grouping: group by memory type. */
  private groupByType(memories: Engram[], minSize: number): Engram[][] {
    const typeMap = new Map<string, Engram[]>();
    for (const m of memories) {
      if (!typeMap.has(m.type)) typeMap.set(m.type, []);
      typeMap.get(m.type)!.push(m);
    }
    return [...typeMap.values()].filter(g => g.length >= minSize);
  }
}

export interface ConsolidateOptions {
  namespace?: string;
  maxStrength?: number;
  minGroupSize?: number;
  groupByTags?: boolean;
}
