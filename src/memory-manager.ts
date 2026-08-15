import type {
  Engram,
  MemoryManagerConfig,
  MemorySpaceConfig,
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
import { TypedEmitter, DEFAULT_DECAY_CONFIG } from './types';
import { createEngram, CreateEngramOptions } from './engram';
import { InMemoryStore } from './storage/in-memory';
import { DecayEngine } from './decay-engine';
import { Compressor, ConsolidateOptions } from './compressor';
import { MemorySpaceManager, MemorySpace } from './memory-space';
import { VersionManager } from './version-manager';
import { RecallEngine } from './recall-engine';

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
    this.recall = new RecallEngine(this.store, this.decay, this.emitter);
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

  /** Query memories using multi-signal ranking. */
  async query(query: RecallQuery): Promise<RecallResult[]> {
    return this.recall.recall(query);
  }

  /** Get a specific memory by ID (also reinforces it). */
  async get(id: string, reinforce: boolean = false): Promise<Engram | null> {
    const engram = await this.store.get(id);
    if (!engram) return null;

    if (reinforce) {
      const reinforced = this.decay.reinforce(engram);
      await this.store.put(reinforced);
      this.emitter.emit('memory:recalled', reinforced);
      return reinforced;
    }

    return engram;
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

    return { total, active, decayed, compressed, archived, superseded, forgotten };
  }
}

