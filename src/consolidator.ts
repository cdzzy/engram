// ============================================================
// Engram - Memory Consolidation & Auto-Summarization
// Inspired by mem0's cross-session memory patterns
// ============================================================

import { EventEmitter } from 'node:events';
import type {
  Engram,
  MemoryType,
  ImportanceLevel,
  MemoryStore,
  CompressionStrategy,
  CompressionResult,
  DecayConfig,
  DEFAULT_DECAY_CONFIG,
} from './types.js';

// ---- Consolidation Types ----

export type ConsolidationTrigger = 'count' | 'size' | 'time' | 'manual';

export interface ConsolidationConfig {
  /** What triggers consolidation */
  trigger: ConsolidationTrigger;
  /** For 'count' trigger: consolidate when N new memories accumulate */
  triggerCount: number;
  /** For 'time' trigger: consolidate every N milliseconds */
  triggerIntervalMs: number;
  /** For 'size' trigger: consolidate when total memory size exceeds this */
  triggerSizeBytes: number;
  /** Maximum memories per consolidation batch */
  batchSize: number;
  /** Only consolidate memories older than N milliseconds */
  minAgeMs: number;
  /** Target compression ratio (e.g., 0.3 means target 30% of original) */
  targetCompressionRatio: number;
  /** Memory types to include in consolidation */
  includeTypes: MemoryType[];
  /** Minimum importance level to consolidate */
  minImportance: ImportanceLevel;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  trigger: 'count',
  triggerCount: 50,
  triggerIntervalMs: 3600_000,  // 1 hour
  triggerSizeBytes: 1024 * 1024, // 1MB
  batchSize: 20,
  minAgeMs: 300_000,  // 5 minutes
  targetCompressionRatio: 0.3,
  includeTypes: ['episodic', 'semantic'],
  minImportance: 'low',
};

export interface ConsolidationStats {
  totalConsolidations: number;
  totalMemoriesBefore: number;
  totalMemoriesAfter: number;
  avgCompressionRatio: number;
  lastConsolidationAt: number | null;
}

export interface ConsolidationResult {
  id: string;
  timestamp: number;
  triggerReason: string;
  sourceMemoryIds: string[];
  compressedMemoryIds: string[];
  removedMemoryIds: string[];
  compressionRatio: number;
  stats: {
    memoriesBefore: number;
    memoriesAfter: number;
    bytesBefore: number;
    bytesAfter: number;
  };
}

// ---- Events ----

export interface ConsolidationEvents {
  'consolidation:start': (batchId: string, memoryCount: number) => void;
  'consolidation:complete': (result: ConsolidationResult) => void;
  'consolidation:error': (error: Error, batchId: string) => void;
  'consolidation:memory-removed': (engramId: string, reason: string) => void;
}

export class TypedEventEmitter extends EventEmitter {
  override emit<K extends keyof ConsolidationEvents>(
    event: K, ...args: Parameters<ConsolidationEvents[K]>
  ): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof ConsolidationEvents>(
    event: K, listener: ConsolidationEvents[K]
  ): this;
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override off<K extends keyof ConsolidationEvents>(
    event: K, listener: ConsolidationEvents[K]
  ): this;
  override off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
}

// ---- Importance hierarchy for filtering ----

const IMPORTANCE_ORDER: Record<ImportanceLevel, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  trivial: 1,
};

// ---- MemoryConsolidator ----

export class MemoryConsolidator {
  private store: MemoryStore;
  private config: ConsolidationConfig;
  private compressionStrategy: CompressionStrategy;
  private events: TypedEventEmitter;
  private stats: ConsolidationStats;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingCount: number = 0;

  constructor(
    store: MemoryStore,
    compressionStrategy: CompressionStrategy,
    config?: Partial<ConsolidationConfig>,
  ) {
    this.store = store;
    this.compressionStrategy = compressionStrategy;
    this.config = { ...DEFAULT_CONSOLIDATION_CONFIG, ...config };
    this.events = new TypedEventEmitter();
    this.stats = {
      totalConsolidations: 0,
      totalMemoriesBefore: 0,
      totalMemoriesAfter: 0,
      avgCompressionRatio: 0,
      lastConsolidationAt: null,
    };
  }

  /**
   * Notify the consolidator that a new memory was added.
   * For 'count' trigger mode.
   */
  notifyNewMemory(): void {
    this.pendingCount++;
    if (
      this.config.trigger === 'count' &&
      this.pendingCount >= this.config.triggerCount
    ) {
      this.pendingCount = 0;
      this.consolidate('count_threshold_reached');
    }
  }

  /**
   * Manually trigger consolidation.
   */
  async consolidate(reason: string = 'manual'): Promise<ConsolidationResult> {
    const batchId = `consolidate_${Date.now()}`;
    const now = Date.now();
    const cutoff = now - this.config.minAgeMs;

    // Gather eligible memories
    const eligible = await this.store.query({
      type: this.config.includeTypes as unknown as MemoryType,
      createdBefore: cutoff,
    });

    // Filter by importance
    const minImportance = IMPORTANCE_ORDER[this.config.minImportance] || 0;
    const candidates = eligible.filter(
      m => IMPORTANCE_ORDER[m.importance as ImportanceLevel] >= minImportance &&
           m.status === 'active'
    );

    if (candidates.length < 2) {
      // Not enough to consolidate
      return {
        id: batchId,
        timestamp: now,
        triggerReason: reason,
        sourceMemoryIds: [],
        compressedMemoryIds: [],
        removedMemoryIds: [],
        compressionRatio: 1.0,
        stats: {
          memoriesBefore: candidates.length,
          memoriesAfter: candidates.length,
          bytesBefore: this._estimateBytes(candidates),
          bytesAfter: this._estimateBytes(candidates),
        },
      };
    }

    this.events.emit('consolidation:start', batchId, candidates.length);

    try {
      // Take a batch
      const batch = candidates.slice(0, this.config.batchSize);
      const bytesBefore = this._estimateBytes(batch);

      // Group by namespace for contextual consolidation
      const groups = this._groupByNamespace(batch);
      const compressedIds: string[] = [];
      const removedIds: string[] = [];

      for (const [namespace, group] of groups) {
        if (group.length < 2) {
          compressedIds.push(...group.map(m => m.id));
          continue;
        }

        // Compress using the strategy
        const summaryContent = await this.compressionStrategy.compress(group);

        // Mark source memories as compressed
        for (const memory of group) {
          memory.status = 'compressed';
          memory.compressedFrom = group.map(m => m.id);
          await this.store.put(memory);
          removedIds.push(memory.id);
        }

        // Create compressed memory
        const compressed: Engram = {
          id: `compressed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          content: summaryContent,
          type: 'semantic',
          importance: 'medium',
          status: 'active',
          strength: 0.8,
          stability: 0.9,
          lastAccessedAt: now,
          accessCount: 0,
          createdAt: now,
          tags: ['consolidated', `from:${group.length}`, `ns:${namespace}`],
          source: 'consolidator',
          namespace,
          metadata: {
            consolidatedFrom: group.map(m => m.id),
            consolidationId: batchId,
            originalCount: group.length,
          },
          version: 1,
          previousVersionId: null,
          supersededBy: null,
          compressedFrom: group.map(m => m.id),
          embedding: null,
        };

        await this.store.put(compressed);
        compressedIds.push(compressed.id);
      }

      const remainingCount = await this.store.count({});
      const bytesAfter = bytesBefore * (1 - this.config.targetCompressionRatio);
      const compressionRatio = removedIds.length / batch.length;

      const result: ConsolidationResult = {
        id: batchId,
        timestamp: now,
        triggerReason: reason,
        sourceMemoryIds: batch.map(m => m.id),
        compressedMemoryIds: compressedIds,
        removedMemoryIds: removedIds,
        compressionRatio,
        stats: {
          memoriesBefore: batch.length,
          memoriesAfter: remainingCount,
          bytesBefore,
          bytesAfter: Math.round(bytesAfter),
        },
      };

      // Update stats
      this.stats.totalConsolidations++;
      this.stats.totalMemoriesBefore += batch.length;
      this.stats.totalMemoriesAfter += remainingCount;
      this.stats.avgCompressionRatio = this.stats.totalConsolidations > 0
        ? (this.stats.avgCompressionRatio * (this.stats.totalConsolidations - 1) + compressionRatio) /
          this.stats.totalConsolidations
        : compressionRatio;
      this.stats.lastConsolidationAt = now;

      this.events.emit('consolidation:complete', result);

      // Notify about removed memories
      for (const id of removedIds) {
        this.events.emit('consolidation:memory-removed', id, 'consolidated');
      }

      return result;
    } catch (error) {
      this.events.emit(
        'consolidation:error',
        error instanceof Error ? error : new Error(String(error)),
        batchId,
      );
      throw error;
    }
  }

  /**
   * Start automatic consolidation based on interval.
   */
  startAuto(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.consolidate('time_interval').catch(() => {});
    }, this.config.triggerIntervalMs);
  }

  /**
   * Stop automatic consolidation.
   */
  stopAuto(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStats(): ConsolidationStats {
    return { ...this.stats };
  }

  getConfig(): ConsolidationConfig {
    return { ...this.config };
  }

  getEventEmitter(): TypedEventEmitter {
    return this.events;
  }

  // ---- Internal ----

  private _groupByNamespace(memories: Engram[]): Map<string, Engram[]> {
    const groups = new Map<string, Engram[]>();
    for (const m of memories) {
      const ns = m.namespace || 'default';
      if (!groups.has(ns)) groups.set(ns, []);
      groups.get(ns)!.push(m);
    }
    return groups;
  }

  private _estimateBytes(memories: Engram[]): number {
    return memories.reduce((sum, m) => sum + m.content.length * 2, 0);
  }
}

