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
}

export function createEngram(options: CreateEngramOptions): Engram {
  const now = Date.now();
  return {
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
}
