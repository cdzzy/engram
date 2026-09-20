import type {
  Engram,
  MemoryManagerConfig,
  MemorySpaceConfig,
  MemoryStatus,
  RecallQuery,
  RecallResult,
  CompressionResult,
  DecayConfig,
  MemoryStore,
  VersionRecord,
  ImportanceScorer,
  ConflictPolicy,
  ConflictResolver,
  ImportanceLevel,
} from './types';
import {
  TypedEmitter,
  DEFAULT_DECAY_CONFIG,
  SOFT_DELETE_MARKER,
  EXPIRATION_DATE_KEY,
} from './types';
import { createEngram, CreateEngramOptions } from './engram';
import { InMemoryStore } from './storage/in-memory';
import { DecayEngine } from './decay-engine';
import { Compressor, ConsolidateOptions } from './compressor';
import { MemorySpaceManager, MemorySpace } from './memory-space';
import { VersionManager } from './version-manager';
import { RecallEngine } from './recall-engine';

/** Statuses eligible for lazy expiration on read. */
const EXPIRATION_ELIGIBLE: readonly MemoryStatus[] = ['active', 'decayed', 'compressed'];

/**
 * MemoryManager — the main entry point for Engram.
 *
 * Orchestrates all subsystems:
 * - Decay engine (Ebbinghaus forgetting curve)
 * - Memory compressor (multi-level consolidation)
 * - Shared memory spaces (cross-agent ACL)
 * - Version manager (supersession, restore)
 * - Recall engine (multi-signal ranking)
 */
export class MemoryManager {
  readonly emitter: TypedEmitter;
  readonly store: MemoryStore;
  readonly decay: DecayEngine;
  readonly compressor: Compressor;
  readonly spaces: MemorySpaceManager;
  readonly versions: VersionManager;
  readonly recall: RecallEngine;

  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private config: Required<MemoryManagerConfig>;

  constructor(config: MemoryManagerConfig = {}, store?: MemoryStore) {
    this.emitter = new TypedEmitter();
    this.store = store ?? new InMemoryStore();

    const decayConfig: DecayConfig = {
      ...DEFAULT_DECAY_CONFIG,
      ...config.decay,
    };

    this.config = {
      decay: decayConfig,
      recallTimeDecay: config.recallTimeDecay!,
      defaultNamespace: config.defaultNamespace ?? 'default',
      globalCapacity: config.globalCapacity ?? 0,
      decaySweepInterval: config.decaySweepInterval ?? 60_000,
      compressionStrategy: config.compressionStrategy!,
      importanceScorer: config.importanceScorer!,
      conflictPolicy: config.conflictPolicy ?? 'last-writer-wins',
      onConflict: config.onConflict!,
    };

    this.decay = new DecayEngine(decayConfig);
    this.compressor = new Compressor(config.compressionStrategy);
    this.spaces = new MemorySpaceManager(this.store, this.emitter);
    this.versions = new VersionManager(this.store, this.emitter);
    this.recall = new RecallEngine(this.store, this.decay, this.emitter, config.recallTimeDecay);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Start the automatic decay sweep timer. */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(
      () => this.runDecaySweep(),
      this.config.decaySweepInterval,
    );
  }

  /** Stop the decay sweep timer and clean up. */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.spaces.destroy();
  }

  // ── Encode (Store New Memory) ────────────────────────────────────────────

  /**
   * Encode a new memory into the system.
   * Validates agent permissions, checks capacity, records version.
   * Auto-scores importance when omitted and an importanceScorer is configured.
   */
  async encode(options: CreateEngramOptions): Promise<Engram> {
    const namespace = options.namespace ?? this.config.defaultNamespace;
    let fullOptions = { ...options, namespace };

    // Auto-score importance if not explicitly provided
    if (fullOptions.importance === undefined && this.config.importanceScorer) {
      const importance = await this.config.importanceScorer(
        fullOptions.content,
        fullOptions.type,
      );
      fullOptions = { ...fullOptions, importance };
    }

    // Check write permission
    this.spaces.assertPermission(namespace, fullOptions.source, 'write');

    // Check capacity
    const hasCapacity = await this.spaces.checkCapacity(namespace);
    if (!hasCapacity) {
      throw new Error(`Memory space '${namespace}' is at capacity`);
    }

    const engram = createEngram(fullOptions);
    await this.store.put(engram);

    // Record version
    this.versions.recordCreation(engram);

    // Track write for conflict detection
    this.spaces.trackWrite(engram.id, fullOptions.source);

    this.emitter.emit('memory:encoded', engram);
    return engram;
  }

  /** Expose the effective config (for introspection / debugging). */
  getConfig(): Readonly<Required<MemoryManagerConfig>> {
    return this.config;
  }

  /** The configured conflict resolution policy. */
  get conflictPolicy(): ConflictPolicy {
    return this.config.conflictPolicy;
  }

  // ── Recall (Retrieve Memories) ───────────────────────────────────────────

  /**
   * Query memories using multi-signal ranking.
   *
   * Memories whose `expiration_date` metadata has passed are lazily
   * transitioned to status 'expired' and excluded from the results.
   * Reinforcement is applied after that filter, so expired memories are
   * never strengthened by a read.
   */
  async query(query: RecallQuery): Promise<RecallResult[]> {
    const { reinforce = true, ...rest } = query;

    const results = await this.recall.recall({ ...rest, reinforce: false });

    const kept: RecallResult[] = [];
    for (const result of results) {
      const engram = await this.expireIfDue(result.engram);
      if (engram !== result.engram) continue; // lazily transitioned → exclude
      kept.push(result);
    }

    if (reinforce) {
      const now = Date.now();
      for (const result of kept) {
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

    return kept;
  }

  /**
   * Get a specific memory by ID (also reinforces it on request).
   *
   * Reads are lazy about expiration: when `expiration_date` metadata has
   * passed, the memory is transitioned to status 'expired' before being
   * returned. Expired and soft-deleted memories are never reinforced.
   */
  async get(id: string, reinforce: boolean = false): Promise<Engram | null> {
    let engram = await this.store.get(id);
    if (!engram) return null;

    engram = await this.expireIfDue(engram);

    if (reinforce && engram.status !== 'expired' && !this.isSoftDeleted(engram)) {
      const reinforced = this.decay.reinforce(engram);
      await this.store.put(reinforced);
      this.emitter.emit('memory:recalled', reinforced);
      return reinforced;
    }

    return engram;
  }

  // ── Soft Delete / Restore / Purge ────────────────────────────────────────

  /**
   * Soft-delete a memory. Instead of physically removing it, the memory is
   * marked with status 'archived' plus a `deletedAt` metadata timestamp.
   * Soft-deleted memories are excluded from recall but remain recoverable
   * via undelete() until purge() physically removes them.
   */
  async delete(id: string): Promise<void> {
    const engram = await this.store.get(id);
    if (!engram) throw new Error(`Memory '${id}' not found`);

    const deleted: Engram = {
      ...engram,
      status: 'archived',
      metadata: { ...engram.metadata, [SOFT_DELETE_MARKER]: new Date().toISOString() },
    };
    await this.store.put(deleted);
    this.emitter.emit('memory:soft-deleted', deleted);
  }

  /**
   * Recover a soft-deleted memory (only possible before purge()).
   * Only memories carrying the soft-delete marker are restored; memories
   * archived by the decay engine are left untouched.
   */
  async undelete(id: string): Promise<Engram> {
    const engram = await this.store.get(id);
    if (!engram) throw new Error(`Memory '${id}' not found`);
    if (!this.isSoftDeleted(engram)) {
      throw new Error(`Memory '${id}' is not soft-deleted`);
    }

    const metadata = { ...engram.metadata };
    delete metadata[SOFT_DELETE_MARKER];
    const restored: Engram = { ...engram, status: 'active', metadata };
    await this.store.put(restored);
    this.emitter.emit('memory:soft-restored', restored);
    return restored;
  }

  /**
   * Physically remove a memory from the store. Irreversible — this is the
   * only manager-level API that actually deletes data (delete() is soft).
   */
  async purge(id: string): Promise<void> {
    const engram = await this.store.get(id);
    if (!engram) throw new Error(`Memory '${id}' not found`);
    await this.store.delete(id);
    this.emitter.emit('memory:purged', id);
  }

  /** Whether a memory carries the soft-delete marker. */
  private isSoftDeleted(engram: Engram): boolean {
    return engram.metadata[SOFT_DELETE_MARKER] !== undefined;
  }

  /** Parse `expiration_date` metadata (ISO string or epoch ms) → ms, or null. */
  private getExpirationMs(engram: Engram): number | null {
    const raw = engram.metadata[EXPIRATION_DATE_KEY];
    if (raw === undefined || raw === null) return null;
    const ms = typeof raw === 'number' ? raw : Date.parse(String(raw));
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * Lazily transition a memory to status 'expired' when its expiration_date
   * has passed. Only active/decayed/compressed memories transition; already
   * terminal statuses and soft-deleted memories are left untouched.
   * Returns the (possibly updated) engram — identity changes iff it expired.
   */
  private async expireIfDue(engram: Engram, now: number = Date.now()): Promise<Engram> {
    if (this.isSoftDeleted(engram)) return engram;
    const expirationMs = this.getExpirationMs(engram);
    if (expirationMs === null || now < expirationMs) return engram;
    if (!EXPIRATION_ELIGIBLE.includes(engram.status)) return engram;

    const expired: Engram = { ...engram, status: 'expired' };
    await this.store.put(expired);
    this.emitter.emit('memory:expired', expired);
    return expired;
  }

  // ── Update & Version ─────────────────────────────────────────────────────

  /** Update a memory's content, creating a new version. */
  async update(engramId: string, newContent: string, agentId: string): Promise<Engram> {
    const engram = await this.store.get(engramId);
    if (!engram) throw new Error(`Memory '${engramId}' not found`);

    this.spaces.assertPermission(engram.namespace, agentId, 'write');
    this.spaces.trackWrite(engramId, agentId);

    return this.versions.update(engramId, newContent, agentId);
  }

  /**
   * Resolve a conflict between an existing memory and an incoming write.
   *
   * Applies the configured conflict policy:
   * - `last-writer-wins`: incoming overwrites existing (default)
   * - `merge`: concatenates content from both (existing + incoming)
   * - `version`: keeps existing and creates the incoming as a new version
   * - `custom`: delegates to the configured `onConflict` resolver
   */
  async resolveConflict(
    existing: Engram,
    incoming: Engram,
    agentId: string,
  ): Promise<Engram> {
    const policy = this.config.conflictPolicy;
    const context = { agentId, namespace: incoming.namespace };

    switch (policy) {
      case 'merge': {
        const merged = createEngram({
          content: `${existing.content}\n${incoming.content}`,
          type: existing.type,
          importance: existing.importance,
          tags: [...new Set([...existing.tags, ...incoming.tags])],
          source: agentId,
          namespace: existing.namespace,
        });
        await this.store.put(merged);
        this.emitter.emit('memory:superseded', existing, merged);
        return merged;
      }
      case 'version': {
        // Keep existing; incoming becomes a new version via supersession
        const result = await this.versions.supersede(existing.id, incoming, agentId);
        return result.new;
      }
      case 'custom': {
        if (!this.config.onConflict) {
          throw new Error("conflictPolicy is 'custom' but no onConflict resolver is configured");
        }
        const resolved = await this.config.onConflict(existing, incoming, context);
        if (resolved) {
          await this.store.put(resolved);
          return resolved;
        }
        return existing;
      }
      case 'last-writer-wins':
      default: {
        await this.store.put(incoming);
        this.emitter.emit('memory:superseded', existing, incoming);
        return incoming;
      }
    }
  }

  /**
   * Supersede an outdated memory with a new one.
   * The old memory is marked as superseded and linked to the replacement.
   */
  async supersede(
    oldEngramId: string,
    newOptions: CreateEngramOptions,
  ): Promise<{ old: Engram; new: Engram }> {
    const oldEngram = await this.store.get(oldEngramId);
    if (!oldEngram) throw new Error(`Memory '${oldEngramId}' not found`);

    this.spaces.assertPermission(
      oldEngram.namespace,
      newOptions.source,
      'write',
    );

    const newEngram = createEngram({
      ...newOptions,
      namespace: newOptions.namespace ?? oldEngram.namespace,
    });

    return this.versions.supersede(oldEngramId, newEngram, newOptions.source);
  }

  /** Restore a memory to a previous version. */
  async restore(engramId: string, targetVersion: number, agentId: string): Promise<Engram> {
    const engram = await this.store.get(engramId);
    if (!engram) throw new Error(`Memory '${engramId}' not found`);

    this.spaces.assertPermission(engram.namespace, agentId, 'write');
    return this.versions.restore(engramId, targetVersion, agentId);
  }

  /** Resolve the most current version of a potentially superseded memory. */
  async resolveLatest(engramId: string): Promise<Engram | null> {
    return this.versions.resolveLatest(engramId);
  }

  /** Get version history for a memory. */
  getVersionHistory(engramId: string): VersionRecord[] {
    return this.versions.getHistory(engramId);
  }

  // ── Compression ──────────────────────────────────────────────────────────

  /** Run memory consolidation — compress weak related memories into summaries. */
  async consolidate(options?: ConsolidateOptions): Promise<CompressionResult[]> {
    return this.compressor.consolidate(this.store, this.emitter, options);
  }

  // ── Memory Spaces ────────────────────────────────────────────────────────

  /** Create a shared memory space. */
  createSpace(config: MemorySpaceConfig): MemorySpace {
    return this.spaces.createSpace(config);
  }

  /** Get a memory space. */
  getSpace(name: string): MemorySpace | null {
    return this.spaces.getSpace(name);
  }

  /** List spaces accessible by an agent. */
  listAgentSpaces(agentId: string): MemorySpace[] {
    return this.spaces.listAgentSpaces(agentId);
  }

  // ── Decay Management ─────────────────────────────────────────────────────

  /** Manually trigger a decay sweep. */
  async runDecaySweep(now?: number) {
    return this.decay.sweep(this.store, this.emitter, now);
  }

  /** Get current strength of a memory without modifying it. */
  peekStrength(engram: Engram, now?: number): number {
    return this.decay.calculateStrength(engram, now);
  }

  /** Predict when a memory will decay below threshold. */
  predictDecayTime(engram: Engram, threshold?: number): number {
    return this.decay.predictDecayTime(engram, threshold);
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  async stats(namespace?: string) {
    const filter = namespace ? { namespace } : {};
    const total = await this.store.count(filter);
    const active = await this.store.count({ ...filter, status: 'active' });
    const decayed = await this.store.count({ ...filter, status: 'decayed' });
    const compressed = await this.store.count({ ...filter, status: 'compressed' });
    const archived = await this.store.count({ ...filter, status: 'archived' });
    const superseded = await this.store.count({ ...filter, status: 'superseded' });
    const forgotten = await this.store.count({ ...filter, status: 'forgotten' });
    const expired = await this.store.count({ ...filter, status: 'expired' });

    return { total, active, decayed, compressed, archived, superseded, forgotten, expired };
  }

  // ── Snapshot Export / Import ─────────────────────────────────────────────

  /**
   * Export the full memory store as a lossless snapshot.
   *
   * Preserves ids, timestamps, strength, version lineage, and embeddings so
   * a round-trip (export → clear → import) restores the store exactly.
   *
   * Args:
   *   filePath: Optional path — when given, the snapshot is written to disk
   *             as pretty-printed JSON.
   */
  async exportSnapshot(filePath?: string): Promise<MemorySnapshot> {
    const memories = await this.store.query({});
    const snapshot: MemorySnapshot = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: memories.length,
      memories: structuredClone(memories),
    };
    if (filePath) {
      const fs = await import('node:fs');
      fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    }
    return snapshot;
  }

  /**
   * Import memories from a snapshot (object or JSON file path).
   *
   * Full-fidelity restore: memories are written to the store as-is rather
   * than re-created, so ids, decay state, and version lineage survive.
   *
   * Args:
   *   source: A MemorySnapshot object, or a path to a snapshot JSON file.
   *   options.overwrite: Overwrite existing memories with the same id
   *                      (default: skip duplicates).
   *
   * Returns:
   *   Counts of imported and skipped memories.
   */
  async importSnapshot(
    source: string | MemorySnapshot,
    options: { overwrite?: boolean } = {},
  ): Promise<{ imported: number; skipped: number }> {
    let snapshot: MemorySnapshot;
    if (typeof source === 'string') {
      const fs = await import('node:fs');
      snapshot = JSON.parse(fs.readFileSync(source, 'utf-8')) as MemorySnapshot;
    } else {
      snapshot = source;
    }
    if (!snapshot || !Array.isArray(snapshot.memories)) {
      throw new Error('Invalid snapshot: expected an object with a "memories" array');
    }

    let imported = 0;
    let skipped = 0;
    for (const memory of snapshot.memories) {
      if (!memory || typeof memory.id !== 'string') {
        skipped++;
        continue;
      }
      if (!options.overwrite) {
        const existing = await this.store.get(memory.id);
        if (existing) {
          skipped++;
          continue;
        }
      }
      await this.store.put(memory as Engram);
      imported++;
    }
    return { imported, skipped };
  }
}

/** Lossless, versioned snapshot of a memory store. */
export interface MemorySnapshot {
  version: number;
  exportedAt: string;
  count: number;
  memories: Engram[];
}

