# Changelog

All notable changes to Engram are documented in this file.

## [0.5.0] - 2026-08-15

### Added

- **Importance scorer integration** (`#1`): `importanceScorer` option on `MemoryManagerConfig` — auto-scores memories in `encode()` when `importance` is omitted. Works with `LLMImportanceScorer` or any sync/async scorer.
- **Conflict resolution policies** (`#3`): `conflictPolicy` (`last-writer-wins` | `merge` | `version` | `custom`) plus `onConflict` resolver, exposed via `MemoryManager.resolveConflict()`.
- **GraphRAG memory** (`#5`): first-class `GraphMemory` module with rule-based entity/relation extraction and multi-hop BFS traversal. Supports a pluggable LLM extractor.
- **Encryption at rest** (`#8`): `EncryptedStore` wrapping any `MemoryStore` with AES-256-GCM content encryption. Supports direct keys, passphrases, and `keySource: 'env:VAR'`; `generateEncryptionKey()` helper included.

### Changed

- Exported new types (`ImportanceScorer`, `ConflictPolicy`, `ConflictResolver`, graph + encryption types) from the package root.

## [0.4.0]

- Initial public release: typed memory, decay engine, recall engine, compression, memory spaces, versioning, FileStore, MCP stdio server, behavior observer, three-layer interface.
