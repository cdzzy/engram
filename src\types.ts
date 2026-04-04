import { EventEmitter } from 'events';

// ─── Memory Classification ───────────────────────────────────────────────────

/** Type of memory — mirrors cognitive psychology taxonomy */
export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'working';

/** Importance determines base decay resistance */
export type ImportanceLevel = 'critical' | 'high' | 'medium' | 'low' | 'trivial';

/** Lifecycle status of a memory */
export type MemoryStatus =
  | 'active'
  | 'decayed'
  | 'compressed'
  | 'archived'
  | 'superseded'
  | 'forgotten';

/** Permission levels for shared memory spaces */
export type Permission = 'read' | 'write' | 'admin';

// ─── Importance numeric mapping ──────────────────────────────────────────────

export const IMPORTANCE_WEIGHTS: Record<ImportanceLevel, number> = {
  critical: 1.0,
  high: 0.8,
  medium: 0.5,
  low: 0.3,
  trivial: 0.1,
};

// ─── Core Memory Unit ────────────────────────────────────────────────────────

/** Engram — the fundamental unit of memory (neuroscience term for memory trace) */
export interface Engram {
  id: string;
  content: string;
  type: MemoryType;
  importance: ImportanceLevel;
  status: MemoryStatus;

  // Forgetting curve parameters
  strength: number;       // Current retention strength (0–1)
  stability: number;      // Decay resistance — increases with each successful recall
  lastAccessedAt: number; // Timestamp (ms) of last recall
  accessCount: number;    // Total number of successful recalls
  createdAt: number;      // Timestamp (ms) of creation

  // Organizational metadata
  tags: string[];
  source: string;         // Agent ID that created this memory
  namespace: string;      // Memory space this belongs to
  metadata: Record<string, unknown>;

  // Versioning
  version: number;
  previousVersionId: string | null;
  supersededBy: string | null;

  // Compression lineage
  compressedFrom: string[];   // IDs of source memories (if this is a compressed summary)

  // Optional embedding for semantic recall
  embedding: number[] | null;
}

// ─── Decay Configuration ─────────────────────────────────────────────────────

export interface DecayConfig {
  /** Base half-life in milliseconds (default: 1 hour) */
  baseHalfLife: number;
  /** Stability boost multiplier per recall (default: 1.5) */
  recallBoostFactor: number;
  /** Importance-based stability multipliers */
  importanceMultiplier: Record<ImportanceLevel, number>;
  /** Strength threshold below which status becomes 'decayed' */
  decayThreshold: number;
  /** Strength threshold below which memory is archived */
  archiveThreshold: number;
  /** Strength threshold below which memory is forgotten */
  forgetThreshold: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  baseHalfLife: 3_600_000,   // 1 hour
  recallBoostFactor: 1.5,
  importanceMultiplier: {
    critical: 10.0,
    high: 5.0,
    medium: 2.0,
    low: 1.0,
    trivial: 0.5,
  },
  decayThreshold: 0.3,
  archiveThreshold: 0.1,
  forgetThreshold: 0.02,
};

// ─── Memory Space ────────────────────────────────────────────────────────────

export interface MemorySpaceConfig {
  name: string;
  /** Maximum number of active memories (0 = unlimited) */
  maxCapacity: number;
  /** Access control list: agentId → permissions */
  acl: Record<string, Permission[]>;
  /** Whether this space is shared across agents */
  shared: boolean;
  /** Auto-consolidation interval in ms (0 = disabled) */
  consolidationInterval: number;
}

// ─── Recall ──────────────────────────────────────────────────────────────────

export interface RecallQuery {
  /** Text to match against memory content (substring match) */
  text?: string;
  /** Filter by tags (any match) */
  tags?: string[];
  /** Filter by memory type */
  type?: MemoryType;
  /** Filter by namespace */
  namespace?: string;
  /** Only return memories with strength >= this value */
  minStrength?: number;
  /** Max number of results */
  limit?: number;
  /** Weight for recency signal (0–1, default 0.3) */
  recencyBias?: number;
  /** Weight for strength signal (0–1, default 0.3) */
  strengthBias?: number;
  /** Weight for relevance signal (0–1, default 0.25) */
  relevanceBias?: number;
  /** Weight for importance signal (0–1, default 0.15) */
  importanceBias?: number;
  /** If true, recalled memories get a strength boost */
  reinforce?: boolean;
}

export interface RecallSignals {
  recency: number;
  strength: number;
  relevance: number;
  importance: number;
}

export interface RecallResult {
  engram: Engram;
  score: number;
  signals: RecallSignals;
}

// ─── Compression ─────────────────────────────────────────────────────────────

/**
 * Strategy for compressing multiple memories into a summary.
 * Users can plug in LLM-based implementations.
 */
export interface CompressionStrategy {
  compress(memories: Engram[]): Promise<string>;
}

export interface CompressionResult {
  /** The newly created compressed memory */
  compressed: Engram;
  /** IDs of memories that were compressed */
  sourceIds: string[];
  /** Ratio: 1 compressed / N sources */
  compressionRatio: number;
}

// ─── Version Management ──────────────────────────────────────────────────────

export type ChangeType = 'created' | 'updated' | 'superseded' | 'restored';

export interface VersionRecord {
  engramId: string;
  version: number;
  content: string;
  timestamp: number;
  changeType: ChangeType;
  changedBy: string;   // Agent ID
}

// ─── Storage ─────────────────────────────────────────────────────────────────

export interface MemoryStore {
  get(id: string): Promise<Engram | null>;
  getMany(ids: string[]): Promise<Engram[]>;
  put(engram: Engram): Promise<void>;
  delete(id: string): Promise<void>;
  query(filter: MemoryFilter): Promise<Engram[]>;
  count(filter?: MemoryFilter): Promise<number>;
  clear(): Promise<void>;
}

export interface MemoryFilter {
  namespace?: string;
  type?: MemoryType;
  status?: MemoryStatus | MemoryStatus[];
  tags?: string[];
  source?: string;
  minStrength?: number;
  maxStrength?: number;
  createdAfter?: number;
  createdBefore?: number;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface MemoryEvents {
  'memory:encoded': [engram: Engram];
  'memory:recalled': [engram: Engram];
  'memory:strengthened': [engram: Engram, oldStrength: number, newStrength: number];
  'memory:decayed': [engram: Engram, oldStrength: number, newStrength: number];
  'memory:compressed': [result: CompressionResult];
  'memory:archived': [engram: Engram];
  'memory:forgotten': [engram: Engram];
  'memory:superseded': [oldEngram: Engram, newEngram: Engram];
  'memory:version-created': [record: VersionRecord];
  'memory:conflict': [engramId: string, agents: string[]];
  'space:created': [name: string];
  'space:capacity-warning': [name: string, usage: number, capacity: number];
}

/** Type-safe event emitter for memory events */
export class TypedEmitter extends EventEmitter {
  emit<K extends keyof MemoryEvents>(event: K, ...args: MemoryEvents[K]): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof MemoryEvents>(event: K, listener: (...args: MemoryEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof MemoryEvents>(event: K, listener: (...args: MemoryEvents[K]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof MemoryEvents>(event: K, listener: (...args: MemoryEvents[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

// ─── Manager Config ──────────────────────────────────────────────────────────

export interface MemoryManagerConfig {
  decay?: Partial<DecayConfig>;
  /** Default namespace for memories */
  defaultNamespace?: string;
  /** Global memory capacity (0 = unlimited) */
  globalCapacity?: number;
  /** Interval (ms) for running decay sweep (default: 60000) */
  decaySweepInterval?: number;
  /** Custom compression strategy (default: concatenation) */
  compressionStrategy?: CompressionStrategy;
}
