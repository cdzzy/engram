/**
 * engram CLI — inspect and manage agent memory from the command line.
 *
 * Commands:
 *   engram stats [--storage DIR]              Memory statistics by status/type
 *   engram list [--storage DIR] [--namespace N] [--limit N] [--status S]
 *                                             List memories (newest first)
 *   engram search QUERY [--storage DIR] [--limit N]
 *                                             Multi-signal recall
 *   engram show ID [--storage DIR]            Full detail for one memory
 *   engram forget ID [--storage DIR] [--yes]  Permanently delete a memory
 *   engraph spaces [--storage DIR]            List memory spaces
 *
 * Storage: uses FileStore at --storage (default ~/.engram). Falls back to an
 * in-memory store when the directory doesn't exist (useful for a dry demo).
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { MemoryManager } from './memory-manager.js';
import { FileStore } from './storage/file-store.js';
import { InMemoryStore } from './storage/in-memory.js';
import type { Engram, MemoryStatus } from './types.js';

interface CliArgs {
  command: string;
  positional: string[];
  storage: string;
  namespace?: string;
  limit: number;
  status?: MemoryStatus;
  yes: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const out: CliArgs = {
    command: args[0] ?? 'help',
    positional: [],
    storage: path.join(os.homedir(), '.engram'),
    limit: 20,
    yes: false,
  };

  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--storage': out.storage = args[++i] ?? out.storage; break;
      case '--namespace': case '-n': out.namespace = args[++i]; break;
      case '--limit': case '-l': out.limit = Number(args[++i] ?? 20) || 20; break;
      case '--status': case '-s': out.status = args[++i] as MemoryStatus; break;
      case '--yes': case '-y': out.yes = true; break;
      default:
        if (a.startsWith('-')) {
          fail(`unknown option: ${a}`);
        } else {
          out.positional.push(a);
        }
    }
  }
  return out;
}

/** Typed CLI error carrying the process exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

function fail(message: string): never {
  throw new CliError(message);
}

async function createManager(storageDir: string): Promise<{ manager: MemoryManager; persistent: boolean }> {
  const persistent = fs.existsSync(storageDir);
  if (persistent) {
    const store = new FileStore(storageDir);
    await store.init();
    return { manager: new MemoryManager({}, store), persistent };
  }
  return { manager: new MemoryManager({}, new InMemoryStore()), persistent };
}

/** Resolve a memory ID or unique prefix (like git short SHAs) to the full ID. */
async function resolveId(manager: MemoryManager, idOrPrefix: string): Promise<string> {
  // Full ID — use directly
  const direct = await manager.get(idOrPrefix);
  if (direct) return idOrPrefix;

  // Prefix match against all memories
  const all = await manager.store.query({});
  const matches = all.filter(e => e.id.startsWith(idOrPrefix)).map(e => e.id);
  if (matches.length === 0) fail(`memory not found: ${idOrPrefix}`);
  if (matches.length > 1) fail(`ambiguous ID prefix "${idOrPrefix}" matches ${matches.length} memories`);
  return matches[0]!;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function relativeTime(timestamp: number): string {
  const s = Math.floor((Date.now() - timestamp) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Commands ─────────────────────────────────────────────────────────────

async function cmdStats(args: CliArgs): Promise<number> {
  const { manager } = await createManager(args.storage);
  const stats = await manager.stats();
  const total = stats.total;
  if (total === 0) {
    process.stdout.write('No memories stored yet.\n');
    return 0;
  }
  process.stdout.write(`Memory statistics (total: ${total})\n\n`);
  for (const [key, value] of Object.entries(stats)) {
    if (key === 'total') continue;
    process.stdout.write(`  ${(key + ':').padEnd(12)} ${String(value).padStart(6)}\n`);
  }
  return 0;
}

async function cmdList(args: CliArgs): Promise<number> {
  const { manager } = await createManager(args.storage);
  const results = await manager.query({
    namespace: args.namespace,
    limit: args.limit,
  });

  const filtered = args.status ? results.filter(r => r.engram.status === args.status) : results;
  if (filtered.length === 0) {
    process.stdout.write('No memories found.\n');
    return 0;
  }

  process.stdout.write(`${filtered.length} memor${filtered.length === 1 ? 'y' : 'ies'}\n\n`);
  for (const { engram } of filtered) {
    const id = engram.id.slice(0, 8);
    const tags = engram.tags.length ? ` [${engram.tags.join(', ')}]` : '';
    process.stdout.write(
      `  ${id}  ${String(engram.importance).padEnd(8)} ${String(engram.type).padEnd(10)} ${truncate(engram.content, 60)}${tags}\n`,
    );
  }
  return 0;
}

async function cmdSearch(args: CliArgs): Promise<number> {
  const query = args.positional.join(' ');
  if (!query) fail('search requires a QUERY argument');

  const { manager } = await createManager(args.storage);
  const results = await manager.query({ text: query, limit: args.limit });

  if (results.length === 0) {
    process.stdout.write(`No memories match "${query}".\n`);
    return 0;
  }

  process.stdout.write(`Top ${results.length} results for "${query}"\n\n`);
  for (const { engram, score } of results) {
    process.stdout.write(
      `  ${(score.toFixed(3)).padEnd(6)} ${engram.id.slice(0, 8)}  ${truncate(engram.content, 64)}\n`,
    );
  }
  return 0;
}

async function cmdShow(args: CliArgs): Promise<number> {
  const idOrPrefix = args.positional[0];
  if (!idOrPrefix) fail('show requires a memory ID');

  const { manager } = await createManager(args.storage);
  const id = await resolveId(manager, idOrPrefix);
  const engram = await manager.get(id);
  if (!engram) fail(`memory not found: ${idOrPrefix}`);

  const e = engram as Engram;
  process.stdout.write(`Memory ${e.id}\n\n`);
  process.stdout.write(`  content:     ${e.content}\n`);
  process.stdout.write(`  type:        ${e.type}\n`);
  process.stdout.write(`  importance:  ${e.importance}\n`);
  process.stdout.write(`  status:      ${e.status}\n`);
  process.stdout.write(`  namespace:   ${e.namespace}\n`);
  process.stdout.write(`  source:      ${e.source}\n`);
  process.stdout.write(`  tags:        ${e.tags.length ? e.tags.join(', ') : '(none)'}\n`);
  process.stdout.write(`  strength:    ${e.strength.toFixed(3)} (stability ${e.stability.toFixed(1)})\n`);
  process.stdout.write(`  recalls:     ${e.accessCount}\n`);
  process.stdout.write(`  created:     ${relativeTime(e.createdAt)}\n`);
  process.stdout.write(`  accessed:    ${relativeTime(e.lastAccessedAt)}\n`);
  if (e.compressedFrom.length > 0) {
    process.stdout.write(`  compressed:  from ${e.compressedFrom.length} memories\n`);
  }
  return 0;
}

async function cmdForget(args: CliArgs): Promise<number> {
  const idOrPrefix = args.positional[0];
  if (!idOrPrefix) fail('forget requires a memory ID');

  const { manager } = await createManager(args.storage);
  const id = await resolveId(manager, idOrPrefix);
  const engram = await manager.get(id);
  if (!engram) fail(`memory not found: ${idOrPrefix}`);

  if (!args.yes) {
    process.stdout.write(`About to permanently delete: ${truncate(engram.content, 60)}\n`);
    process.stdout.write('Re-run with --yes to confirm.\n');
    return 0;
  }

  await manager.store.delete(id);
  process.stdout.write(`Deleted ${id}.\n`);
  return 0;
}

async function cmdSpaces(args: CliArgs): Promise<number> {
  const { manager } = await createManager(args.storage);
  const spaces = manager.spaces.listSpaces();
  if (spaces.length === 0) {
    process.stdout.write('No memory spaces configured.\n');
    return 0;
  }
  for (const space of spaces) {
    const info = space.getConfig();
    const shared = info.shared ? ' (shared)' : '';
    process.stdout.write(`  ${space.name}${shared}\n`);
  }
  return 0;
}

async function cmdExport(args: CliArgs): Promise<number> {
  const file = args.positional[0];
  if (!file) fail('export requires an output FILE path');

  const { manager } = await createManager(args.storage);
  const snapshot = await manager.exportSnapshot(file);
  process.stdout.write(`Exported ${snapshot.count} memories to ${file}\n`);
  return 0;
}

async function cmdImport(args: CliArgs): Promise<number> {
  const file = args.positional[0];
  if (!file) fail('import requires a snapshot FILE path');

  const { manager } = await createManager(args.storage);
  const result = await manager.importSnapshot(file, { overwrite: args.yes });
  process.stdout.write(`Imported ${result.imported}, skipped ${result.skipped} (existing ids kept; use --yes to overwrite)\n`);
  return 0;
}

function cmdHelp(): number {
  process.stdout.write(`engram — agent memory inspection

Usage:
  engram stats    [--storage DIR]                    memory statistics
  engram list     [--storage DIR] [--namespace N] [--limit N] [--status S]
  engram search   QUERY [--storage DIR] [--limit N]  multi-signal recall
  engram show     ID [--storage DIR]                 full memory detail
  engram forget   ID [--storage DIR] [--yes]         permanently delete
  engram spaces   [--storage DIR]                    list memory spaces
  engram export   FILE [--storage DIR]               lossless snapshot to JSON
  engram import   FILE [--storage DIR] [--yes]       restore from snapshot

Options:
  --storage DIR   FileStore directory (default: ~/.engram)
  --limit N       max results (default: 20)
  --yes           skip confirmation / overwrite on import
`);
  return 0;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'stats': return cmdStats(args);
    case 'list': return cmdList(args);
    case 'search': return cmdSearch(args);
    case 'show': return cmdShow(args);
    case 'forget': return cmdForget(args);
    case 'spaces': return cmdSpaces(args);
    case 'export': return cmdExport(args);
    case 'import': return cmdImport(args);
    case 'help': case '--help': case '-h': return cmdHelp();
    default:
      fail(`unknown command: ${args.command} (see 'engram help')`);
  }
}
