# Changelog

All notable changes to Engram are documented in this file.

## [0.9.2] - 2026-09-25

### Fixed

- CI on Node 18: vitest 3.x resolves `vite@7` (ESM-only, requires Node ≥20.19), which broke the Node 18 job with `ERR_REQUIRE_ESM`. Pinned `vite` to `^6.3.0` via `overrides` so the whole matrix runs on a Node 18-compatible toolchain.

## [0.9.1] - 2026-09-25

### Changed

- Dev toolchain refreshed: vitest 2.x → 3.2.7 (the old pin pulled a vite/postcss chain carrying a critical advisory), typescript-eslint 8.70.1, tsx 4.23.15, `@types/node` 25.9.8. Coverage is now actually generated (`@vitest/coverage-v8` + `coverage` config), so the CI coverage artifact reflects real numbers.
- `engines` declared (`node >=18`), matching the CI matrix and sibling packages.
- Remaining `npm audit` findings are dev-only (vitest mock helper, moderate) with no non-breaking fix — vitest 5 would drop Node 18/20 support in CI — so they are accepted and documented here.

## [0.9.0] - 2026-09-20

### Added

- **Soft decay — non-destructive memory lifecycle**: `delete()` now marks a memory soft-deleted (a `deletedAt` marker) instead of destroying it; `undelete()` recovers it, `purge()` is the explicit hard delete (emits the new `memory:purged` event), and soft-deleted memories stay hidden from reads until purged. Encryption remains orthogonal to state.
- **Lazy expiration**: reads flip memories past their `expiration_date` to the new `expired` status on the way out (`expireIfDue`), so due memories disappear from results without a sweeper process; stats reports them.
- **Recall time-decay factor**: optional `recallTimeDecay` config (`exponential`: `0.5^(t/halfLife)` or `power`: `1/(1 + t/halfLife)`) down-weights older memories during recall scoring via the exported `computeTimeDecayFactor()` — off by default, zero behavior change for existing stores.
- **Release automation** (`.github/workflows/release.yml`): npm publish with provenance on `v*` tags, guarded on `NPM_TOKEN`.

### Changed

- CI: test matrix extended to Node 18/20/22 with fail-fast off.

## [0.8.0] - 2026-09-04

### Added

- **OpenClaw `.agent/` compatibility** (last roadmap item): `importAgentDir` pulls `memory/semantic/lessons.jsonl` + `memory/episodic/*.json` into a MemoryManager; `exportToAgentDir` writes semantic memories back as lessons.jsonl + LESSONS.md and episodic memories as individual .json files.

## [0.7.0] - 2026-08-27

### Added

- **Memory snapshot export/import**: `MemoryManager.exportSnapshot(filePath?)` / `importSnapshot(source, { overwrite })` for lossless full-store round-trips (ids, decay state, version lineage, embeddings preserved). Exposed as `engram export FILE` / `engram import FILE [--yes]` CLI commands.

### Fixed

- **FileStore stale-index race**: `init()` now always rebuilds the index from the memory files on disk instead of trusting a cached `_index.json`, which could be up to 500ms stale (debounced flush) — a second process reading the store right after a write saw empty results. Also hardened `rebuildIndex` to skip non-Engram JSON files (snapshots, configs) that previously poisoned the index with an `undefined` key.

## [0.6.0] - 2026-08-19

### Added

- **`engram` CLI for memory inspection**: `stats`, `list`, `search`, `show`, `forget`, and `spaces` commands against a `FileStore` (default `~/.engram`). `show`/`forget` accept full IDs or unique 8-char prefixes (git-style). Errors are typed (`CliError`) so command logic stays testable; the bin entry lives in a separate `cli-main.ts`.

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
