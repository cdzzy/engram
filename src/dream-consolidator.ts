import type { Engram, MemoryStore, TypedEmitter, CompressionStrategy } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// DreamConsolidator
//
// Inspired by sleep-based memory consolidation in cognitive neuroscience.
// During low-activity periods (or on-demand), this module:
//   1. Scans decayed/low-strength short-term memories
//   2. Groups related memories by tags / source namespace
//   3. Compresses each group into a single high-stability "dream summary"
//   4. Marks originals as `compressed` (not deleted — audit trail preserved)
//
// Reference: kiwi-mem Dream integration pattern (2026-04-18 AI Trending)
// ─────────────────────────────────────────────────────────────────────────────

export interface DreamConfig {
  /** Strength threshold below which memories become candidates (default: 0.4) */
  candidateStrengthThreshold: number;
  /** Minimum group size before consolidation fires (default: 3) */
  minGroupSize: number;
  /** Stability assigned to the resulting dream summary (default: 5.0) */
  dreamStability: number;
  /** Max memories to process per dream cycle (default: 200) */
  batchLimit: number;
  /** Whether to run automatically on a schedule (default: false) */
  autoSchedule: boolean;
  /** Interval between auto dream cycles in ms (default: 3_600_000 = 1 h) */
  autoIntervalMs: number;
}

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  candidateStrengthThreshold: 0.4,
  minGroupSize: 3,
  dreamStability: 5.0,
  batchLimit: 200,
  autoSchedule: false,
  autoIntervalMs: 3_600_000,
};

export interface DreamResult {
  groupsProcessed: number;
  memoriesConsolidated: number;
  summariesCreated: Engram[];
  skippedGroups: number;
}

/** Group key: namespace + primary tag (or '__untagged__') */
function groupKey(engram: Engram): string {
  const tag = engram.tags[0] ?? '__untagged__';
  return `${engram.namespace}::${tag}`;
}

/** Generate a unique ID for dream summary engrams */
function dreamId(prefix: string, now: number): string {
  return `dream_${prefix}_${now}_${Math.random().toString(36).slice(2, 8)}`;
}

export class DreamConsolidator {
  private config: DreamConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<DreamConfig>) {
    this.config = { ...DEFAULT_DREAM_CONFIG, ...config };
  }

  /**
   * Start automatic dream cycles.
   * Call `stop()` to cancel.
   */
  start(store: MemoryStore, emitter: TypedEmitter): void {
    if (!this.config.autoSchedule || this.timer) return;
    this.timer = setInterval(
      () => void this.consolidate(store, emitter),
      this.config.autoIntervalMs,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one dream consolidation cycle.
   *
   * Steps:
   *   1. Query weak/decayed memories up to batchLimit
   *   2. Group by namespace::primaryTag
   *   3. For each group >= minGroupSize: create dream summary, mark sources compressed
   *   4. Emit `memory:encoded` for each summary, `memory:compressed` for source batch
   */
  async consolidate(
    store: MemoryStore,
    emitter: TypedEmitter,
    now: number = Date.now(),
  ): Promise<DreamResult> {
    const candidates = await store.query({
      status: ['active', 'decayed'],
      strengthBelow: this.config.candidateStrengthThreshold,
      limit: this.config.batchLimit,
    });

    // Group memories
    const groups = new Map<string, Engram[]>();
    for (const eng of candidates) {
      const key = groupKey(eng);
      const arr = groups.get(key) ?? [];
      arr.push(eng);
      groups.set(key, arr);
    }

    const result: DreamResult = {
      groupsProcessed: 0,
      memoriesConsolidated: 0,
      summariesCreated: [],
      skippedGroups: 0,
    };

    for (const [key, group] of groups) {
      if (group.length < this.config.minGroupSize) {
        result.skippedGroups++;
        continue;
      }

      result.groupsProcessed++;
      result.memoriesConsolidated += group.length;

      // Build summary content
      const summaryContent = this._buildSummary(group, key);

      // Create dream engram — inherits highest importance in the group
      const topImportance = group.reduce<Engram>(
        (best, e) =>
          (e.strength + e.accessCount) > (best.strength + best.accessCount) ? e : best,
        group[0]!,
      );

      const [namespace] = key.split('::') as [string, string];
      const summaryId = dreamId(key.replace('::', '_'), now);

      const dreamEngram: Engram = {
        id: summaryId,
        content: summaryContent,
        type: 'semantic',           // Dream summaries are semantic by nature
        importance: topImportance.importance,
        status: 'active',
        strength: 1.0,              // Born fresh
        stability: this.config.dreamStability,
        lastAccessedAt: now,
        accessCount: 0,
        createdAt: now,
        tags: [...new Set(group.flatMap(e => e.tags))].slice(0, 10),
        source: 'dream-consolidator',
        namespace,
        metadata: {
          dreamCycle: true,
          sourceIds: group.map(e => e.id),
          consolidatedAt: now,
        },
        version: 1,
        previousVersionId: null,
        supersededBy: null,
        compressedFrom: group.map(e => e.id),
        embedding: null,
      };

      await store.put(dreamEngram);
      emitter.emit('memory:encoded', dreamEngram);
      result.summariesCreated.push(dreamEngram);

      // Mark source memories as compressed
      for (const src of group) {
        const updated: Engram = {
          ...src,
          status: 'compressed',
          supersededBy: summaryId,
        };
        await store.put(updated);
      }

      // Emit compression event
      emitter.emit('memory:compressed', {
        summaryId,
        sourceIds: group.map(e => e.id),
        originalCount: group.length,
        compressionRatio: group.length,
      });
    }

    return result;
  }

  private _buildSummary(group: Engram[], groupKey: string): string {
    const sorted = [...group].sort((a, b) => b.accessCount - a.accessCount);
    const lines = sorted.map(e => `• ${e.content.slice(0, 200)}`);
    return `[Dream Summary — ${groupKey} — ${group.length} memories]\n${lines.join('\n')}`;
  }

  getConfig(): Readonly<DreamConfig> {
    return { ...this.config };
  }
}
