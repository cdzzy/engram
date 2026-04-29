import * as fs from 'fs';
import * as path from 'path';
import type { Engram, MemoryStore, MemoryFilter, MemoryStatus } from '../types';

/**
 * FileStore — a filesystem-backed MemoryStore for Engram.
 *
 * Each memory (Engram) is persisted as a single JSON file named by its ID.
 * An index file (`_index.json`) is maintained for fast listing and filtering
 * without reading every individual file.
 *
 * Directory layout
 * ----------------
 *   <storageDir>/
 *     _index.json          ← lightweight index: id → { namespace, type, status, tags, strength, … }
 *     <id>.json            ← full Engram object per memory
 *
 * Concurrency
 * -----------
 * Node.js is single-threaded, so concurrent in-process access is safe.
 * However, simultaneous access from multiple processes is NOT safe — use a
 * database-backed store (e.g. SQLite) for multi-process deployments.
 *
 * Usage
 * -----
 * ```ts
 * import { FileStore } from './storage/file-store';
 * import { MemoryManager } from './memory-manager';
 *
 * const store = new FileStore('/path/to/my-agent/.agent/memory');
 * await store.init();   // creates directory and loads index
 *
 * const manager = new MemoryManager({}, store);
 * manager.start();
 * ```
 */
export class FileStore implements MemoryStore {
  private storageDir: string;

  /**
   * In-memory index: id → Engram metadata (subset, not full content).
   * Rebuilt from _index.json on `init()`.
   */
  private index: Map<string, IndexEntry> = new Map();

  private indexPath: string;
  private indexDirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounce delay before writing the index to disk (ms). */
  private readonly FLUSH_DEBOUNCE = 500;

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    this.indexPath = path.join(storageDir, '_index.json');
  }

  // ── Initialisation ──────────────────────────────────────────────────────

  /**
   * Create the storage directory if it doesn't exist, and load the index.
   * Must be called once before using the store.
   */
  async init(): Promise<void> {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    await this.loadIndex();
  }

  // ── MemoryStore interface ───────────────────────────────────────────────

  async get(id: string): Promise<Engram | null> {
    const filePath = this.engramPath(id);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as Engram;
    } catch {
      return null;
    }
  }

  async getMany(ids: string[]): Promise<Engram[]> {
    const results: Engram[] = [];
    for (const id of ids) {
      const engram = await this.get(id);
      if (engram) results.push(engram);
    }
    return results;
  }

  async put(engram: Engram): Promise<void> {
    // Write full engram file
    fs.writeFileSync(
      this.engramPath(engram.id),
      JSON.stringify(engram, null, 2),
      'utf-8',
    );

    // Update index
    this.index.set(engram.id, toIndexEntry(engram));
    this.scheduleFlush();
  }

  async delete(id: string): Promise<void> {
    const filePath = this.engramPath(id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    this.index.delete(id);
    this.scheduleFlush();
  }

  async query(filter: MemoryFilter): Promise<Engram[]> {
    // Fast pre-filter via index
    const candidateIds: string[] = [];
    for (const [id, entry] of this.index) {
      if (matchesIndexEntry(entry, filter)) {
        candidateIds.push(id);
      }
    }

    // Load full engrams for candidates
    const results: Engram[] = [];
    for (const id of candidateIds) {
      const engram = await this.get(id);
      if (engram && matchesFilter(engram, filter)) {
        results.push(engram);
      }
    }
    return results;
  }

  async count(filter?: MemoryFilter): Promise<number> {
    if (!filter) return this.index.size;

    let count = 0;
    for (const entry of this.index.values()) {
      if (matchesIndexEntry(entry, filter)) count++;
    }
    return count;
  }

  async clear(): Promise<void> {
    // Delete all engram files
    for (const id of this.index.keys()) {
      const fp = this.engramPath(id);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    this.index.clear();
    await this.flushIndex();
  }

  // ── Extras ────────────────────────────────────────────────────────────────

  /** Number of memories currently in the store. */
  get size(): number {
    return this.index.size;
  }

  /**
   * Flush the index to disk immediately (bypasses debounce).
   * Call on graceful shutdown to avoid data loss.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushIndex();
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private engramPath(id: string): string {
    return path.join(this.storageDir, `${id}.json`);
  }

  private async loadIndex(): Promise<void> {
    if (!fs.existsSync(this.indexPath)) {
      // Cold start: scan directory for existing .json files
      await this.rebuildIndex();
      return;
    }
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, IndexEntry>;
      this.index = new Map(Object.entries(data));
    } catch {
      // Corrupt index: rebuild
      await this.rebuildIndex();
    }
  }

  private async rebuildIndex(): Promise<void> {
    this.index.clear();
    try {
      const files = fs.readdirSync(this.storageDir).filter(
        (f) => f.endsWith('.json') && f !== '_index.json',
      );
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this.storageDir, file), 'utf-8');
          const engram = JSON.parse(raw) as Engram;
          this.index.set(engram.id, toIndexEntry(engram));
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // storageDir not readable yet
    }
    await this.flushIndex();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.indexDirty = true;
    this.flushTimer = setTimeout(() => {
      this.flushIndex().catch(() => {/* ignore flush errors in background */});
      this.flushTimer = null;
    }, this.FLUSH_DEBOUNCE);
  }

  private async flushIndex(): Promise<void> {
    const data: Record<string, IndexEntry> = {};
    for (const [id, entry] of this.index) {
      data[id] = entry;
    }
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2), 'utf-8');
    this.indexDirty = false;
  }
}

// ── Index entry (lightweight, kept in memory) ─────────────────────────────────

interface IndexEntry {
  namespace: string;
  type: string;
  status: string;
  tags: string[];
  source: string;
  strength: number;
  createdAt: number;
}

function toIndexEntry(e: Engram): IndexEntry {
  return {
    namespace: e.namespace,
    type: e.type,
    status: e.status,
    tags: e.tags,
    source: e.source,
    strength: e.strength,
    createdAt: e.createdAt,
  };
}

function matchesIndexEntry(entry: IndexEntry, filter: MemoryFilter): boolean {
  if (filter.namespace !== undefined && entry.namespace !== filter.namespace) return false;
  if (filter.type !== undefined && entry.type !== filter.type) return false;
  if (filter.status !== undefined) {
    const statuses: MemoryStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(entry.status as MemoryStatus)) return false;
  }
  if (filter.tags !== undefined && filter.tags.length > 0) {
    if (!filter.tags.some((t) => entry.tags.includes(t))) return false;
  }
  if (filter.source !== undefined && entry.source !== filter.source) return false;
  if (filter.minStrength !== undefined && entry.strength < filter.minStrength) return false;
  if (filter.maxStrength !== undefined && entry.strength > filter.maxStrength) return false;
  if (filter.createdAfter !== undefined && entry.createdAt < filter.createdAfter) return false;
  if (filter.createdBefore !== undefined && entry.createdAt > filter.createdBefore) return false;
  return true;
}

function matchesFilter(engram: Engram, filter: MemoryFilter): boolean {
  // Full filter check on loaded engram (catches any fields not in index)
  return matchesIndexEntry(
    {
      namespace: engram.namespace,
      type: engram.type,
      status: engram.status,
      tags: engram.tags,
      source: engram.source,
      strength: engram.strength,
      createdAt: engram.createdAt,
    },
    filter,
  );
}
