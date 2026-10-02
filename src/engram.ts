import { randomUUID } from 'crypto';
import type { Engram, MemoryType, ImportanceLevel } from './types';

export interface CreateEngramOptions {
  content: string;
  type: MemoryType;
  importance?: ImportanceLevel;
  tags?: string[];
  source: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
  embedding?: number[] | null;
  /**
   * Bi-temporal (optional): stable identity shared by all versions of the
   * same fact. Set this to enable MemoryManager.updateFact() invalidation.
   */
  factId?: string;
  /** Bi-temporal (optional): epoch ms when the fact became true. */
  validFrom?: number | null;
  /** Bi-temporal (optional): epoch ms when the fact stops being true (null = open). */
  validUntil?: number | null;
}

export function createEngram(options: CreateEngramOptions): Engram {
  const now = Date.now();
  const engram: Engram = {
    id: randomUUID(),
    content: options.content,
    type: options.type,
    importance: options.importance ?? 'medium',
    status: 'active',

    strength: 1.0,
    stability: 1.0,
    lastAccessedAt: now,
    accessCount: 0,
    createdAt: now,

    tags: options.tags ?? [],
    source: options.source,
    namespace: options.namespace ?? 'default',
    metadata: options.metadata ?? {},

    version: 1,
    previousVersionId: null,
    supersededBy: null,

    compressedFrom: [],
    embedding: options.embedding ?? null,
  };

  // Bi-temporal fields are only attached when explicitly requested so that
  // existing engrams keep their exact shape (backward compatibility).
  if (options.factId !== undefined) engram.factId = options.factId;
  if (options.validFrom !== undefined) engram.validFrom = options.validFrom;
  if (options.validUntil !== undefined) engram.validUntil = options.validUntil;

  return engram;
}
