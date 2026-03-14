import type { Engram, MemoryStore, MemoryFilter, MemoryStatus } from '../types';

/**
 * In-memory storage backend for development and testing.
 * Production deployments should implement MemoryStore with a persistent backend.
 */
export class InMemoryStore implements MemoryStore {
  private store = new Map<string, Engram>();

  async get(id: string): Promise<Engram | null> {
    return this.store.get(id) ?? null;
  }

  async getMany(ids: string[]): Promise<Engram[]> {
    const results: Engram[] = [];
    for (const id of ids) {
      const engram = this.store.get(id);
      if (engram) results.push(engram);
    }
    return results;
  }

  async put(engram: Engram): Promise<void> {
    this.store.set(engram.id, { ...engram });
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async query(filter: MemoryFilter): Promise<Engram[]> {
    const results: Engram[] = [];

    for (const engram of this.store.values()) {
      if (this.matchesFilter(engram, filter)) {
        results.push({ ...engram });
      }
    }

    return results;
  }

  async count(filter?: MemoryFilter): Promise<number> {
    if (!filter) return this.store.size;
    let count = 0;
    for (const engram of this.store.values()) {
      if (this.matchesFilter(engram, filter)) count++;
    }
    return count;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  private matchesFilter(engram: Engram, filter: MemoryFilter): boolean {
    if (filter.namespace !== undefined && engram.namespace !== filter.namespace) return false;
    if (filter.type !== undefined && engram.type !== filter.type) return false;

    if (filter.status !== undefined) {
      const statuses: MemoryStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status];
      if (!statuses.includes(engram.status)) return false;
    }

    if (filter.tags !== undefined && filter.tags.length > 0) {
      const hasAnyTag = filter.tags.some(t => engram.tags.includes(t));
      if (!hasAnyTag) return false;
    }

    if (filter.source !== undefined && engram.source !== filter.source) return false;
    if (filter.minStrength !== undefined && engram.strength < filter.minStrength) return false;
    if (filter.maxStrength !== undefined && engram.strength > filter.maxStrength) return false;
    if (filter.createdAfter !== undefined && engram.createdAt < filter.createdAfter) return false;
    if (filter.createdBefore !== undefined && engram.createdAt > filter.createdBefore) return false;

    return true;
  }
}
