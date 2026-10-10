# Changelog

All notable changes to Engram are documented in this file.

## [0.12.0] - 2026-10-10

### Changed

- **Upgraded vitest 3.2.7 → 5.0.3, resolving the deferred `@vitest/mocker`
  advisories**
  ([GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9),
  moderate): dev-server redirect-mock registration lacked `server.fs` allowlist
  validation. Fixed upstream in vitest 5.0.0; vitest 3.x is unmaintained and
  will not receive a backport. `npm audit` now reports **0 vulnerabilities**,
  closing out the deferral documented in 0.11.0.
- **Minimum supported Node is now 22.12** (`engines`), the floor required by
  vitest 5 (`^22.12.0 || ^24.0.0 || >=26.0.0`). The CI matrix now runs on
  Node 22 / 24 / 26 (Node 20 dropped — vitest 5 no longer installs on it).
- **Added `vite@^8.3.4` as an explicit devDependency**: vitest 5 declares
  Vite as a required peer (`^6.4.0 || ^7.0.0 || ^8.0.0`) and pairs best with
  a directly-pinned version. `@vitest/coverage-v8` moves to `5.0.3`
  (must exactly match the vitest version).
- **Removed the `overrides` block** (vite `^6.3.0`, tinypool `2.1.2`,
  source-map-js `1.2.2`): vitest 5 ships a fully patched dependency chain, so
  the 0.11.0-era pins are obsolete. The lockfile shrinks by ~1,000 lines.
- **Renamed `vitest.config.ts` → `vitest.config.mts`**: the file uses ESM
  syntax while the package is CommonJS, which Vite 8 warns will break under
  the upcoming native `configLoader` default. The `.mts` extension makes the
  module format explicit.

### Verified

- All 252 tests pass on vitest 5.0.3 (no `vi.mock`/`vi.hoisted` nesting,
  empty-`toThrow` assertions, or benchmark APIs in the suite — the v5 breaking
  changes do not apply). Lint, typecheck, and build are green.

## [0.11.0] - 2026-10-09

### Changed

- **Node 18 is EOL — minimum supported Node is now 20** (`engines`), matching
  the CI matrix which now runs on Node 20 / 22 / 24. Node 18 reached
  end-of-life on 2025-04-30 and the test toolchain (tinypool 2.x) no longer
  supports it.
- **Dev toolchain security hardening**: `overrides` force `tinypool@2.1.2`
  and `source-map-js@1.2.2`, closing three npm advisories in the vitest
  dependency chain that remain unfixed on vitest 3.x:
  - `tinypool <=2.1.1` — prototype-pollution-to-RCE via worker options
    ([GHSA-5gmw-xhrv-c9v3](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3),
    [GHSA-85c8-ppgw-ccpr](https://github.com/advisories/GHSA-85c8-ppgw-ccpr), critical)
  - `source-map-js <=1.2.1` — event-loop denial of service
    ([GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), high)
  - Verified compatible: all 252 tests pass against tinypool 2.1.2.
  - Remaining: 3 moderate findings on `@vitest/mocker`
    ([GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)) are
    only resolvable by the vitest 5.0 breaking upgrade (requires Node ≥ 22.12);
    deferred until the matrix moves to Node 22+ only.

### Fixed

- **Semantic search type safety** (`semantic-search.ts`): removed the last two
  unchecked `as any` casts in the codebase. The `types` filter now routes
  through a `MemoryType` type guard instead of an unchecked string cast, the
  `recallScore` metadata boost is read as a finite number or falls back to
  `0.5` (no more `NaN` propagation into ranking), and `_memoryToText` uses the
  typed `tags` array plus a narrowed `metadata.summary` read. Behavior is
  unchanged; the search API surface is untouched.

## [0.10.0] - 2026-10-02

### Added

- **Bi-temporal facts (Zep-style)**: semantic facts now carry a stable `factId` (shared across all versions), a `validFrom` (real-world effective time) and a `validUntil` (supersession time, `null` = still valid) alongside the existing system-time fields — enabling "what did we know, and when did we know it" queries. Fields are attached conditionally, so ordinary (non-fact) memories keep their exact previous shape.
- **`MemoryManager.updateFact()`**: closes the current fact version (`validUntil = now`, emits the new `memory:fact-closed` event) and encodes a replacement under the same `factId` with `validFrom = asOf ?? now`. The factId is minted lazily — the first update promotes the original memory's id to a factId — so existing stores need no migration.
- **Time-travel recall**: `recall({ validAt })` restricts candidates to facts valid at that instant (`validFrom <= validAt < validUntil`); `recall({ includeInvalidated: true })` lifts the freshness filter entirely. By default recall snaps to the present, so superseded fact versions are excluded without any extra flags.
- **FileStore bi-temporal filtering**: the on-disk index persists `factId`/`validFrom`/`validUntil` and `query()` supports `factId` (returns the full version lineage) combined with `validAt` (returns only the version valid at that time).
- **Three-layer fact tools, now time-aware**: `fact_assert` supersedes the previous version and chains the new one via `factId`/`validFrom`; `fact_query` accepts an optional `asOf` timestamp for point-in-time queries (searching both active and superseded versions, reporting `validFrom`/`validUntil`/`asOf` per fact); `fact_retract` closes the fact's `validUntil` window instead of just flipping status, and reports the timestamp.
- **9 new tests** (`tests/bi-temporal.test.ts`): version chaining, factId stability, time-travel recall, includeInvalidated semantics, FileStore lineage filtering, and the three-layer `asOf`/retract windows.

### Changed

- `recall()` gained the documented `includeInvalidated` flag (default `false`); passing an explicit `validAt` keeps precedence as before, so existing callers see identical behavior.

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
