import type { Engram, MemoryStore, TypedEmitter } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// HierarchicalSummarizer
//
// Implements calendar-tiered memory summarization:
//   DAY  → compress same-day active memories into a daily digest
//   WEEK → roll up 7 daily digests into a weekly abstract
//   MONTH→ roll up 4 weekly abstracts into a monthly overview
//
// This mirrors the kiwi-mem "calendar hierarchy" pattern and aligns with
// engram's existing compression infrastructure (CompressionResult events).
//
// Reference: kiwi-mem (2026-04-18 AI Trending) + engram CompressedFrom lineage
// ─────────────────────────────────────────────────────────────────────────────

export type SummaryTier = 'day' | 'week' | 'month';

export interface TierConfig {
  /** Stability assigned to the summary engram */
  stability: number;
  /** Importance threshold — only memories at or above this level are included */
  minImportanceWeight: number;
  /** Max chars per source memory in the summary */
  excerptLength: number;
}

export interface HierarchicalConfig {
  day: TierConfig;
  week: TierConfig;
  month: TierConfig;
  /** Tag prefix used to identify summaries (default: '__summary__') */
  summaryTagPrefix: string;
}

export const DEFAULT_HIERARCHICAL_CONFIG: HierarchicalConfig = {
  day: { stability: 8.0, minImportanceWeight: 0.1, excerptLength: 300 },
  week: { stability: 24.0, minImportanceWeight: 0.3, excerptLength: 500 },
  month: { stability: 72.0, minImportanceWeight: 0.5, excerptLength: 800 },
  summaryTagPrefix: '__summary__',
};

/** ms constants */
const ONE_DAY_MS = 86_400_000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;

function tierWindow(tier: SummaryTier): number {
  if (tier === 'day') return ONE_DAY_MS;
  if (tier === 'week') return ONE_WEEK_MS;
  return ONE_MONTH_MS;
}

function summaryId(tier: SummaryTier, namespace: string, anchor: number): string {
  return `summary_${tier}_${namespace}_${anchor}`;
}

function summaryTag(tier: SummaryTier, prefix: string): string {
  return `${prefix}${tier}`;
}

/** Numeric importance weight — maps ImportanceLevel string to 0–1 */
const IMP_WEIGHTS: Record<string, number> = {
  critical: 1.0,
  high: 0.8,
  medium: 0.5,
  low: 0.3,
  trivial: 0.1,
};

export interface SummarizationResult {
  tier: SummaryTier;
  namespace: string;
  anchor: number;
  summary: Engram | null;
  sourcesCompressed: number;
}

export class HierarchicalSummarizer {
  private config: HierarchicalConfig;

  constructor(config?: Partial<HierarchicalConfig>) {
    this.config = { ...DEFAULT_HIERARCHICAL_CONFIG, ...config };
  }

  /**
   * Build a daily summary for a given namespace and day anchor (start-of-day ms).
   *
   * Collects all active/decayed engrams created in the day window,
   * generates a digest, stores it, and marks sources as compressed.
   */
  async summarizeDay(
    store: MemoryStore,
    emitter: TypedEmitter,
    namespace: string,
    dayAnchor: number = startOfDay(Date.now()),
  ): Promise<SummarizationResult> {
    return this._summarizeTier(store, emitter, 'day', namespace, dayAnchor);
  }

  /** Roll up daily summaries into a weekly abstract. */
  async summarizeWeek(
    store: MemoryStore,
    emitter: TypedEmitter,
    namespace: string,
    weekAnchor: number = startOfWeek(Date.now()),
  ): Promise<SummarizationResult> {
    return this._summarizeTier(store, emitter, 'week', namespace, weekAnchor);
  }

  /** Roll up weekly summaries into a monthly overview. */
  async summarizeMonth(
    store: MemoryStore,
    emitter: TypedEmitter,
    namespace: string,
    monthAnchor: number = startOfMonth(Date.now()),
  ): Promise<SummarizationResult> {
    return this._summarizeTier(store, emitter, 'month', namespace, monthAnchor);
  }

  private async _summarizeTier(
    store: MemoryStore,
    emitter: TypedEmitter,
    tier: SummaryTier,
    namespace: string,
    anchor: number,
  ): Promise<SummarizationResult> {
    const window = tierWindow(tier);
    const tierCfg = this.config[tier];
    const minWeight = tierCfg.minImportanceWeight;

    // For week/month: query existing lower-tier summaries as sources
    const sourceTag = tier === 'day'
      ? null   // raw memories
      : summaryTag(tier === 'week' ? 'day' : 'week', this.config.summaryTagPrefix);

    const candidates = await store.query({
      namespace,
      status: ['active', 'decayed', 'archived'],
      createdAfter: anchor,
      createdBefore: anchor + window,
      ...(sourceTag ? { tags: [sourceTag] } : {}),
    });

    // Filter by importance
    const sources = candidates.filter(
      e => (IMP_WEIGHTS[e.importance] ?? 0) >= minWeight,
    );

    if (sources.length === 0) {
      return { tier, namespace, anchor, summary: null, sourcesCompressed: 0 };
    }

    const id = summaryId(tier, namespace, anchor);
    const now = Date.now();
    const tag = summaryTag(tier, this.config.summaryTagPrefix);

    const content = this._buildTierContent(tier, sources, tierCfg.excerptLength, anchor);

    const summary: Engram = {
      id,
      content,
      type: 'semantic',
      importance: 'high',
      status: 'active',
      strength: 1.0,
      stability: tierCfg.stability,
      lastAccessedAt: now,
      accessCount: 0,
      createdAt: now,
      tags: [tag, namespace],
      source: `hierarchical-summarizer:${tier}`,
      namespace,
      metadata: {
        tier,
        anchor,
        sourceCount: sources.length,
        window,
      },
      version: 1,
      previousVersionId: null,
      supersededBy: null,
      compressedFrom: sources.map(e => e.id),
      embedding: null,
    };

    await store.put(summary);
    emitter.emit('memory:encoded', summary);

    // Mark sources as compressed (preserve audit trail)
    for (const src of sources) {
      if (src.status !== 'compressed') {
        await store.put({ ...src, status: 'compressed', supersededBy: id });
      }
    }

    emitter.emit('memory:compressed', {
      summaryId: id,
      sourceIds: sources.map(e => e.id),
      originalCount: sources.length,
      compressionRatio: sources.length,
    });

    return { tier, namespace, anchor, summary, sourcesCompressed: sources.length };
  }

  private _buildTierContent(
    tier: SummaryTier,
    sources: Engram[],
    excerptLen: number,
    anchor: number,
  ): string {
    const label = tier.toUpperCase();
    // Use local date parts to avoid UTC/timezone shift on date string
    const d = new Date(anchor);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const date = `${yyyy}-${mm}-${dd}`;
    const lines = sources
      .sort((a, b) => b.accessCount - a.accessCount)
      .map(e => `• [${e.importance}] ${e.content.slice(0, excerptLen)}`);
    return `[${label} SUMMARY — ${date} — ${sources.length} items]\n${lines.join('\n')}`;
  }
}

// ─── Date helpers ────────────────────────────────────────────────────────────

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfWeek(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // Sunday as week start
  return d.getTime();
}

export function startOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}
