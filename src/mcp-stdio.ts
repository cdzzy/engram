/**
 * Engram MCP stdio Server — structured long-term memory via stdio transport.
 *
 * Why stdio?
 * ----------
 * Claude Code, Cursor, Cline, and most MCP host applications launch MCP servers
 * as child processes and communicate over stdin/stdout (the "stdio" transport).
 * The existing MCPToolsAdapter only serves over HTTP, which requires the user to
 * run a separate server process and configure a network address.
 *
 * This module adds a true stdio transport so Engram can be registered directly
 * in a host's `mcp.json` with a single `npx` command:
 *
 *   "engram": {
 *     "command": "node",
 *     "args": ["node_modules/engram/dist/mcp-stdio.js"]
 *   }
 *
 * Differentiation vs claude-mem
 * ------------------------------
 * | Feature            | claude-mem (70k★)         | engram                         |
 * |--------------------|---------------------------|-------------------------------|
 * | Memory model       | Unstructured compression  | Typed, versioned, namespaced  |
 * | Forgetting curve   | ✗                         | ✓ Ebbinghaus decay engine     |
 * | Memory types       | ✗                         | episodic/semantic/procedural  |
 * | Relationship graph | ✗                         | ✓ engram_link / engram_related|
 * | Timeline queries   | ✗                         | ✓ engram_timeline             |
 * | Shared namespaces  | ✗                         | ✓ cross-agent ACL spaces      |
 * | Consolidation      | ✗                         | ✓ engram_consolidate          |
 * | Transport          | HTTP only                 | stdio + HTTP                  |
 *
 * New tools added in this module (differential tools)
 * -----------------------------------------------------
 * - engram_link                  Link two memories with a typed relationship
 * - engram_related               Find memories linked to a given memory
 * - engram_timeline              Query memories created/accessed within a time window
 * - engram_namespaces            List available memory namespaces
 * - engram_forget                Explicitly delete a memory (force-forget)
 * - engram_observe_tool_call     Record a tool call as behavioral memory
 * - engram_observe_file          Record a file change as behavioral memory
 * - engram_observe_decision      Record an agent decision as semantic memory
 *
 * Usage (stdio server)
 * --------------------
 * ```ts
 * import { MemoryManager } from './memory-manager';
 * import { EngramMCPStdioServer } from './mcp-stdio';
 *
 * const manager = new MemoryManager();
 * manager.start();
 * const server = new EngramMCPStdioServer(manager);
 * server.run();  // reads from stdin, writes to stdout
 * ```
 *
 * CLI entry point
 * ---------------
 * Add to package.json:
 *   "bin": { "engram-mcp": "./dist/mcp-stdio.js" }
 * Then: npx engram-mcp
 */

import * as readline from 'readline';
import type { MemoryManager } from './memory-manager';
import type { MemoryType, ImportanceLevel, Engram } from './types';
import { MCPToolsAdapter } from './mcp-adapter';
import { BehaviorObserver } from './behavior-observer';
import type { BehaviorObserverConfig } from './behavior-observer';

// ── Link store (in-memory graph) ─────────────────────────────────────────────

interface MemoryLink {
  fromId: string;
  toId: string;
  relation: string;  // e.g. "supports", "contradicts", "extends", "causes"
  createdAt: number;
}

/**
 * Simple in-memory link registry.
 * For production use this can be replaced by a persistent graph DB adapter.
 */
class LinkStore {
  private links: MemoryLink[] = [];

  add(fromId: string, toId: string, relation: string): MemoryLink {
    const link: MemoryLink = { fromId, toId, relation, createdAt: Date.now() };
    this.links.push(link);
    return link;
  }

  findRelated(id: string): MemoryLink[] {
    return this.links.filter((l) => l.fromId === id || l.toId === id);
  }

  remove(fromId: string, toId: string): number {
    const before = this.links.length;
    this.links = this.links.filter(
      (l) => !(l.fromId === fromId && l.toId === toId),
    );
    return before - this.links.length;
  }

  all(): MemoryLink[] {
    return [...this.links];
  }
}

// ── Additional tool definitions ───────────────────────────────────────────────

const DIFFERENTIAL_TOOL_DEFINITIONS = [
  {
    name: 'engram_link',
    description:
      'Link two memories with a typed semantic relationship (e.g. "supports", "contradicts", "extends", "causes", "precedes"). Returns the created link.',
    inputSchema: {
      type: 'object',
      properties: {
        fromId: { type: 'string', description: 'Source memory ID.' },
        toId: { type: 'string', description: 'Target memory ID.' },
        relation: {
          type: 'string',
          description: 'Relationship type: supports | contradicts | extends | causes | precedes | custom string.',
        },
      },
      required: ['fromId', 'toId', 'relation'],
    },
  },
  {
    name: 'engram_related',
    description:
      'Find all memories directly linked to the given memory ID, along with the relationship type.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to find related memories for.' },
        direction: {
          type: 'string',
          enum: ['both', 'outgoing', 'incoming'],
          description: 'Which direction of links to follow (default: both).',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'engram_timeline',
    description:
      'Query memories within a time window. Returns memories ordered by creation time. Useful for recalling "what happened between X and Y".',
    inputSchema: {
      type: 'object',
      properties: {
        after: {
          type: 'number',
          description: 'Unix timestamp (ms) — only return memories created after this time.',
        },
        before: {
          type: 'number',
          description: 'Unix timestamp (ms) — only return memories created before this time.',
        },
        namespace: { type: 'string', description: 'Filter by namespace.' },
        type: {
          type: 'string',
          enum: ['episodic', 'semantic', 'procedural', 'working'],
          description: 'Filter by memory type.',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 20).',
        },
      },
    },
  },
  {
    name: 'engram_namespaces',
    description:
      'List all distinct memory namespaces that currently have active memories.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'engram_forget',
    description:
      'Explicitly and permanently delete a memory by ID. Use when you need to correct or erase incorrect/sensitive information.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The memory ID to permanently delete.' },
        reason: { type: 'string', description: 'Optional reason for deletion (for audit purposes).' },
      },
      required: ['id'],
    },
  },
  // ── Behavior tools ─────────────────────────────────────────────────────────
  {
    name: 'engram_observe_tool_call',
    description:
      'Record a tool call as a behavioral memory. Reports what tool was called, with what parameters, and what result was returned. Errors are also captured. This enables "memory from what agents do" — building up a factual record of the agent\'s actions over time.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Name of the tool that was called.' },
        params: {
          type: 'object',
          description: 'Parameters that were passed to the tool.',
          additionalProperties: true,
        },
        result: { description: 'Return value of the tool. Any JSON-serializable value.' },
        durationMs: { type: 'number', description: 'Optional: how long the tool call took (ms).' },
        error: { type: 'string', description: 'Optional: error message if the call failed.' },
        namespace: { type: 'string', description: 'Memory namespace (default: "behavior").' },
      },
      required: ['tool', 'params'],
    },
  },
  {
    name: 'engram_observe_file',
    description:
      'Record a file system change as a behavioral memory. Captures file path, type of change (create/modify/delete/read), and optional metadata. Useful for tracking what files the agent has touched in a session.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path that was changed or accessed.' },
        change: {
          type: 'string',
          enum: ['create', 'modify', 'delete', 'read'],
          description: 'Type of file change.',
        },
        meta: {
          type: 'object',
          description: 'Optional metadata (e.g. { size: 1200, lines: 42, language: "TypeScript" }).',
          additionalProperties: true,
        },
        namespace: { type: 'string', description: 'Memory namespace (default: "behavior").' },
      },
      required: ['path', 'change'],
    },
  },
  {
    name: 'engram_observe_decision',
    description:
      'Record an agent decision as a semantic memory. Captures the decision context, the choice made, the reasoning, and any alternatives considered. Decisions are stored as semantic memories so they can be recalled when similar situations arise.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'What situation or trigger prompted this decision?' },
        choice: { type: 'string', description: 'What did the agent decide to do?' },
        reason: { type: 'string', description: 'Why was this choice made? The reasoning.' },
        alternatives: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: other options that were considered.',
        },
        namespace: { type: 'string', description: 'Memory namespace (default: "behavior").' },
      },
      required: ['context', 'choice', 'reason'],
    },
  },
] as const;

// ── Tool result helper ────────────────────────────────────────────────────────

function toolResult(content: unknown, isError = false) {
  const text =
    typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return { content: [{ type: 'text', text }], isError };
}

// ── EngramMCPStdioServer ──────────────────────────────────────────────────────

/**
 * MCP Server with stdio transport + all Engram tools (base + differential).
 *
 * Reads newline-delimited JSON-RPC 2.0 messages from stdin,
 * writes responses to stdout. Logs go to stderr to avoid polluting the wire.
 */
export class EngramMCPStdioServer {
  private httpAdapter: MCPToolsAdapter;
  private links: LinkStore;
  private behaviorObserver: BehaviorObserver;
  readonly manager: MemoryManager;

  static readonly MCP_VERSION = '2024-11-05';

  constructor(manager: MemoryManager, behaviorConfig?: BehaviorObserverConfig) {
    this.manager = manager;
    this.httpAdapter = new MCPToolsAdapter(manager);
    this.links = new LinkStore();
    this.behaviorObserver = new BehaviorObserver(manager, behaviorConfig);
  }

  // ── All tool definitions (base + differential) ───────────────────────────

  private get allToolDefinitions() {
    // Base tools come from MCPToolsAdapter internals — re-export them here
    const BASE_TOOLS = [
      {
        name: 'engram_store',
        description: 'Store a new memory in Engram. Returns the created memory object with its ID.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The memory content to store.' },
            type: {
              type: 'string',
              enum: ['episodic', 'semantic', 'procedural', 'working'],
              description: 'Memory type (default: semantic).',
            },
            importance: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low', 'trivial'],
              description: 'Importance level affecting decay resistance (default: medium).',
            },
            tags: { type: 'array', items: { type: 'string' } },
            source: { type: 'string' },
            namespace: { type: 'string' },
          },
          required: ['content'],
        },
      },
      {
        name: 'engram_recall',
        description: 'Query memories using multi-signal ranking (recency + strength + keyword relevance + importance).',
        inputSchema: {
          type: 'object',
          properties: {
            keywords: { type: 'array', items: { type: 'string' } },
            type: { type: 'string', enum: ['episodic', 'semantic', 'procedural', 'working'] },
            namespace: { type: 'string' },
            minStrength: { type: 'number' },
            limit: { type: 'number' },
            agentId: { type: 'string' },
          },
        },
      },
      {
        name: 'engram_get',
        description: 'Retrieve a specific memory by its ID.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            reinforce: { type: 'boolean' },
          },
          required: ['id'],
        },
      },
      {
        name: 'engram_update',
        description: 'Update the content of an existing memory, creating a new version.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            agentId: { type: 'string' },
          },
          required: ['id', 'content', 'agentId'],
        },
      },
      {
        name: 'engram_sweep',
        description: 'Manually trigger the Ebbinghaus decay sweep.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'engram_stats',
        description: 'Get memory statistics.',
        inputSchema: {
          type: 'object',
          properties: { namespace: { type: 'string' } },
        },
      },
      {
        name: 'engram_consolidate',
        description: 'Run memory consolidation: compress semantically similar or weak memories.',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            strengthThreshold: { type: 'number' },
          },
        },
      },
    ];
    return [...BASE_TOOLS, ...DIFFERENTIAL_TOOL_DEFINITIONS];
  }

  // ── Differential tool implementations ────────────────────────────────────

  private async toolLink(args: Record<string, unknown>) {
    const fromId = args.fromId as string;
    const toId = args.toId as string;
    const relation = args.relation as string;

    // Verify both memories exist
    const [from, to] = await Promise.all([
      this.manager.get(fromId),
      this.manager.get(toId),
    ]);
    if (!from) return toolResult(`Memory '${fromId}' not found`, true);
    if (!to) return toolResult(`Memory '${toId}' not found`, true);

    const link = this.links.add(fromId, toId, relation);
    return toolResult({
      link,
      from: { id: from.id, content: from.content.slice(0, 80) },
      to: { id: to.id, content: to.content.slice(0, 80) },
    });
  }

  private async toolRelated(args: Record<string, unknown>) {
    const id = args.id as string;
    const direction = (args.direction as string) ?? 'both';

    const engram = await this.manager.get(id);
    if (!engram) return toolResult(`Memory '${id}' not found`, true);

    const rawLinks = this.links.findRelated(id);
    const filtered = rawLinks.filter((l) => {
      if (direction === 'outgoing') return l.fromId === id;
      if (direction === 'incoming') return l.toId === id;
      return true;
    });

    // Enrich with memory content
    const enriched = await Promise.all(
      filtered.map(async (l) => {
        const otherId = l.fromId === id ? l.toId : l.fromId;
        const other = await this.manager.get(otherId);
        return {
          relation: l.relation,
          direction: l.fromId === id ? 'outgoing' : 'incoming',
          memory: other
            ? { id: other.id, content: other.content.slice(0, 100), type: other.type, strength: other.strength }
            : { id: otherId, content: '(deleted)', type: null, strength: 0 },
        };
      }),
    );

    return toolResult({ id, relatedCount: enriched.length, related: enriched });
  }

  private async toolTimeline(args: Record<string, unknown>) {
    const after = (args.after as number) ?? 0;
    const before = (args.before as number) ?? Date.now();
    const namespace = args.namespace as string | undefined;
    const type = args.type as MemoryType | undefined;
    const limit = (args.limit as number) ?? 20;

    const filter: Record<string, unknown> = {
      createdAfter: after,
      createdBefore: before,
      status: ['active', 'decayed'],
    };
    if (namespace) filter.namespace = namespace;
    if (type) filter.type = type;

    const memories = await this.manager.store.query(filter as Parameters<typeof this.manager.store.query>[0]);
    const sorted = memories
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((m) => ({
        id: m.id,
        content: m.content.slice(0, 120),
        type: m.type,
        importance: m.importance,
        createdAt: m.createdAt,
        strength: Math.round(m.strength * 100) / 100,
        tags: m.tags,
        namespace: m.namespace,
      }));

    return toolResult({ total: sorted.length, window: { after, before }, memories: sorted });
  }

  private async toolNamespaces() {
    const memories = await this.manager.store.query({ status: ['active', 'decayed', 'compressed'] });
    const namespaceMap: Record<string, number> = {};
    for (const m of memories) {
      namespaceMap[m.namespace] = (namespaceMap[m.namespace] ?? 0) + 1;
    }
    const namespaces = Object.entries(namespaceMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return toolResult({ total: namespaces.length, namespaces });
  }

  private async toolForget(args: Record<string, unknown>) {
    const id = args.id as string;
    const reason = (args.reason as string) ?? 'explicit deletion via MCP';

    const existing = await this.manager.get(id);
    if (!existing) return toolResult(`Memory '${id}' not found`, true);

    // Remove links involving this memory
    const linksRemoved = this.links.findRelated(id).length;
    this.links.remove(id, '');  // partial — remove outgoing
    this.links['links'] = this.links['links'].filter(
      (l: MemoryLink) => l.fromId !== id && l.toId !== id,
    );

    await this.manager.store.delete(id);

    return toolResult({
      deleted: id,
      content: existing.content.slice(0, 80),
      reason,
      linksRemoved,
    });
  }

  // ── Behavior tool implementations ─────────────────────────────────────────

  private async toolObserveToolCall(args: Record<string, unknown>) {
    const tool = args.tool as string;
    const params = (args.params as Record<string, unknown>) ?? {};
    const result = args.result;
    const durationMs = args.durationMs as number | undefined;
    const error = args.error as string | undefined;
    const namespace = args.namespace as string | undefined;

    const observer = namespace
      ? new BehaviorObserver(this.manager, { namespace })
      : this.behaviorObserver;

    await observer.onToolCall(tool, params, result, { durationMs, error });

    return toolResult({
      observed: true,
      tool,
      importance: error ? 'high' : 'auto-inferred',
      namespace: namespace ?? 'behavior',
    });
  }

  private async toolObserveFile(args: Record<string, unknown>) {
    const path = args.path as string;
    const change = args.change as 'create' | 'modify' | 'delete' | 'read';
    const meta = (args.meta as Record<string, unknown>) ?? {};
    const namespace = args.namespace as string | undefined;

    const observer = namespace
      ? new BehaviorObserver(this.manager, { namespace, captureFileChanges: true, captureToolCalls: true, captureDecisions: true })
      : this.behaviorObserver;

    await observer.onFileChange(path, change, meta);

    return toolResult({
      observed: true,
      path,
      change,
      namespace: namespace ?? 'behavior',
    });
  }

  private async toolObserveDecision(args: Record<string, unknown>) {
    const context = args.context as string;
    const choice = args.choice as string;
    const reason = args.reason as string;
    const alternatives = (args.alternatives as string[]) ?? [];
    const namespace = args.namespace as string | undefined;

    const observer = namespace
      ? new BehaviorObserver(this.manager, { namespace, captureDecisions: true, captureToolCalls: true, captureFileChanges: true })
      : this.behaviorObserver;

    await observer.onDecision(context, choice, reason, alternatives);

    return toolResult({
      observed: true,
      choice,
      namespace: namespace ?? 'behavior',
      alternativesConsidered: alternatives.length,
    });
  }

  // ── Request dispatcher ────────────────────────────────────────────────────

  async handleRequest(body: unknown): Promise<unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } };
    }

    const req = body as Record<string, unknown>;
    const id = req['id'] ?? null;
    const method = (req['method'] as string) ?? '';
    const params = (req['params'] as Record<string, unknown>) ?? {};

    if (req['jsonrpc'] !== '2.0') {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Only JSON-RPC 2.0' } };
    }

    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: EngramMCPStdioServer.MCP_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'engram', version: '0.1.0' },
            },
          };
        case 'notifications/initialized':
          return null;  // Notification — no response
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: this.allToolDefinitions } };
        case 'tools/call': {
          const result = await this.dispatchToolCall(
            params['name'] as string,
            (params['arguments'] as Record<string, unknown>) ?? {},
          );
          return { jsonrpc: '2.0', id, result };
        }
        default:
          return {
            jsonrpc: '2.0', id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { jsonrpc: '2.0', id, error: { code: -32603, message: `Internal error: ${msg}` } };
    }
  }

  private async dispatchToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // Differential tools (handled here)
    switch (toolName) {
      case 'engram_link':               return this.toolLink(args);
      case 'engram_related':            return this.toolRelated(args);
      case 'engram_timeline':           return this.toolTimeline(args);
      case 'engram_namespaces':         return this.toolNamespaces();
      case 'engram_forget':             return this.toolForget(args);
      case 'engram_observe_tool_call':  return this.toolObserveToolCall(args);
      case 'engram_observe_file':       return this.toolObserveFile(args);
      case 'engram_observe_decision':   return this.toolObserveDecision(args);
    }

    // Base tools — delegate to existing MCPToolsAdapter
    const rpcBody = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    };
    const rpcResp = (await this.httpAdapter.handleRequest(rpcBody)) as unknown as Record<string, unknown>;
    if ('error' in rpcResp) {
      throw new Error((rpcResp['error'] as Record<string, string>)?.['message'] ?? 'Tool error');
    }
    return rpcResp['result'];
  }

  // ── stdio transport ───────────────────────────────────────────────────────

  /**
   * Start reading JSON-RPC messages from stdin (one per line) and writing
   * responses to stdout. Blocks until stdin closes.
   *
   * Log messages go to stderr so they don't interfere with the wire protocol.
   */
  run(): void {
    process.stderr.write('[Engram MCP] stdio server started\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: undefined,
      terminal: false,
    });

    rl.on('line', async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let body: unknown;
      try {
        body = JSON.parse(trimmed);
      } catch {
        const errResp = JSON.stringify({
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: 'JSON parse error' },
        });
        process.stdout.write(errResp + '\n');
        return;
      }

      const response = await this.handleRequest(body);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    });

    rl.on('close', () => {
      process.stderr.write('[Engram MCP] stdin closed — shutting down\n');
      process.exit(0);
    });

    // Keep alive
    process.stdin.resume();
  }
}


// ── CLI entry point ───────────────────────────────────────────────────────────

/**
 * When this module is run directly (node mcp-stdio.js), start the stdio server
 * with a default in-memory MemoryManager.
 *
 * For persistent storage, integrate FileStore:
 *   const store = new FileStore('/path/to/engram-data');
 *   const manager = new MemoryManager({}, store);
 */
async function main() {
  const { MemoryManager } = await import('./memory-manager');
  const manager = new MemoryManager();
  manager.start();

  const server = new EngramMCPStdioServer(manager);
  server.run();
}

// Check if this file is the entry point
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[Engram MCP] Fatal error: ${err}\n`);
    process.exit(1);
  });
}
