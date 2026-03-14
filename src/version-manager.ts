import type {
  Engram,
  MemoryStore,
  VersionRecord,
  ChangeType,
  TypedEmitter,
} from './types';

/**
 * Tracks memory versions over time.
 *
 * Key scenarios:
 * - Memory content is updated → new version created, old content preserved
 * - Memory is superseded by a newer memory → old version marked, new linked
 * - Memory needs to be restored to a previous version
 * - Version history can be queried for audit
 */
export class VersionManager {
  private history = new Map<string, VersionRecord[]>();
  private store: MemoryStore;
  private emitter: TypedEmitter;

  constructor(store: MemoryStore, emitter: TypedEmitter) {
    this.store = store;
    this.emitter = emitter;
  }

  /** Record the initial creation of a memory. */
  recordCreation(engram: Engram): void {
    this.addRecord(engram, 'created', engram.source);
  }

  /**
   * Update a memory's content, creating a new version.
   * The old content is preserved in the version history.
   */
  async update(
    engramId: string,
    newContent: string,
    agentId: string,
  ): Promise<Engram> {
    const engram = await this.store.get(engramId);
    if (!engram) throw new Error(`Memory '${engramId}' not found`);

    const updated: Engram = {
      ...engram,
      content: newContent,
      version: engram.version + 1,
      previousVersionId: engram.id,
      lastAccessedAt: Date.now(),
    };

    await this.store.put(updated);
    this.addRecord(updated, 'updated', agentId);
    return updated;
  }

  /**
   * Supersede one memory with another.
   * The old memory is marked as superseded and linked to the new one.
   * This is how "outdated" information is handled.
   */
  async supersede(
    oldEngramId: string,
    newEngram: Engram,
    agentId: string,
  ): Promise<{ old: Engram; new: Engram }> {
    const oldEngram = await this.store.get(oldEngramId);
    if (!oldEngram) throw new Error(`Memory '${oldEngramId}' not found`);

    const updatedOld: Engram = {
      ...oldEngram,
      status: 'superseded',
      supersededBy: newEngram.id,
    };

    const updatedNew: Engram = {
      ...newEngram,
      previousVersionId: oldEngramId,
    };

    await this.store.put(updatedOld);
    await this.store.put(updatedNew);

    this.addRecord(updatedOld, 'superseded', agentId);
    this.addRecord(updatedNew, 'created', agentId);

    this.emitter.emit('memory:superseded', updatedOld, updatedNew);

    return { old: updatedOld, new: updatedNew };
  }

  /**
   * Restore a memory to a previous version.
   * Creates a new version with the content from the specified version number.
   */
  async restore(
    engramId: string,
    targetVersion: number,
    agentId: string,
  ): Promise<Engram> {
    const history = this.getHistory(engramId);
    const target = history.find(r => r.version === targetVersion);
    if (!target) {
      throw new Error(
        `Version ${targetVersion} not found for memory '${engramId}'`,
      );
    }

    const current = await this.store.get(engramId);
    if (!current) throw new Error(`Memory '${engramId}' not found`);

    const restored: Engram = {
      ...current,
      content: target.content,
      version: current.version + 1,
      status: 'active',
      supersededBy: null,
      lastAccessedAt: Date.now(),
    };

    await this.store.put(restored);
    this.addRecord(restored, 'restored', agentId);
    return restored;
  }

  /** Get the full version history for a memory. */
  getHistory(engramId: string): VersionRecord[] {
    return this.history.get(engramId) ?? [];
  }

  /** Get a specific version record. */
  getVersion(engramId: string, version: number): VersionRecord | null {
    const history = this.getHistory(engramId);
    return history.find(r => r.version === version) ?? null;
  }

  /** Get the latest version number for a memory. */
  getLatestVersion(engramId: string): number {
    const history = this.getHistory(engramId);
    if (history.length === 0) return 0;
    return Math.max(...history.map(r => r.version));
  }

  /**
   * Follow the supersession chain to find the most current version
   * of a potentially outdated memory.
   */
  async resolveLatest(engramId: string, maxDepth: number = 10): Promise<Engram | null> {
    let current = await this.store.get(engramId);
    let depth = 0;

    while (current && current.supersededBy && depth < maxDepth) {
      current = await this.store.get(current.supersededBy);
      depth++;
    }

    return current;
  }

  private addRecord(engram: Engram, changeType: ChangeType, changedBy: string): void {
    const record: VersionRecord = {
      engramId: engram.id,
      version: engram.version,
      content: engram.content,
      timestamp: Date.now(),
      changeType,
      changedBy,
    };

    if (!this.history.has(engram.id)) {
      this.history.set(engram.id, []);
    }
    this.history.get(engram.id)!.push(record);

    this.emitter.emit('memory:version-created', record);
  }
}
