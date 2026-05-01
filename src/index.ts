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
export { FileStore } from './storage/file-store';
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

// LLM importance auto-scorer
export { LLMImportanceScorer } from './importance-scorer';
export type { LLMImportanceScorerConfig } from './importance-scorer';

// MCP Server adapter — expose Engram as an MCP-compatible tool server (HTTP)
export { MCPToolsAdapter } from './mcp-adapter';

// MCP stdio Server — structured long-term memory with stdio transport +
// differential tools: engram_link, engram_related, engram_timeline,
// engram_namespaces, engram_forget
// behavior tools: engram_observe_tool_call, engram_observe_file, engram_observe_decision
export { EngramMCPStdioServer } from './mcp-stdio';

// BehaviorObserver — capture agent behaviors as memories (tool calls, file changes, decisions)
export { BehaviorObserver } from './behavior-observer';
export type {
  BehaviorObserverConfig,
  ToolCallEvent,
  FileChangeEvent,
  DecisionEvent,
} from './behavior-observer';

