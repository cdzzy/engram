// Engram — Standardized Long-Term Memory for AI Agents
// https://github.com/cdzzy/engram

export type {
  MemoryType,
  ImportanceLevel,
  MemoryStatus,
  Permission,
  Engram,
  DecayConfig,
  MemorySpaceConfig,
  RecallQuery,
  RecallSignals,
  RecallResult,
  CompressionStrategy,
  CompressionResult,
  ChangeType,
  VersionRecord,
  MemoryStore,
  MemoryFilter,
  MemoryEvents,
  MemoryManagerConfig,
} from './types';

export { IMPORTANCE_WEIGHTS, DEFAULT_DECAY_CONFIG, TypedEmitter } from './types';
export { createEngram } from './engram';
export type { CreateEngramOptions } from './engram';
export { InMemoryStore } from './storage/in-memory';
export { DecayEngine } from './decay-engine';
export type { SweepResult } from './decay-engine';
export { Compressor, ConcatenationStrategy } from './compressor';
export type { ConsolidateOptions } from './compressor';
export {
  SemanticCompressionStrategy,
  HierarchicalSemanticStrategy,
  KeyExtractionStrategy,
  createSemanticCompressor,
} from './semantic-compressor';
export type {
  LLMFunction,
  SemanticCompressionOptions,
} from './semantic-compressor';
export { MemorySpace, MemorySpaceManager } from './memory-space';
export { VersionManager } from './version-manager';
export { RecallEngine } from './recall-engine';
export { MemoryManager } from './memory-manager';
export {
  SemanticSearchAdapter,
  OpenAIEmbeddings,
  OllamaEmbeddings,
} from './semantic-search';
export type {
  EmbeddingProvider,
  SemanticSearchOptions,
} from './semantic-search';
