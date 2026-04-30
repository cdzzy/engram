/**
 * MCPToolsAdapter — expose Engram as an MCP (Model Context Protocol) server.
 *
 * This adapter wraps a MemoryManager and translates MCP JSON-RPC 2.0 requests
 * into Engram operations, making Engram directly callable from any MCP client
 * (Claude Code, Cursor, Cline, Windsurf, etc.).
 *
 * Exposed MCP tools
 * -----------------
 * | Tool name              | Engram operation          |
 * |------------------------|---------------------------|
 * | engram_store           | manager.encode()          |
 * | engram_recall          | manager.query()           |
 * | engram_get             | manager.get()             |
 * | engram_update          | manager.update()          |
 * | engram_sweep           | manager.runDecaySweep()   |
 * | engram_stats           | manager.stats()           |
 * | engram_consolidate     | manager.consolidate()     |
 *
 * Usage (standalone HTTP server)
 * ------------------------------
 * ```ts
 * import { MemoryManager } from './memory-manager';
 * import { MCPToolsAdapter } from './mcp-adapter';
 *
 * const manager = new MemoryManager();
 * manager.start();
 *
 * const mcp = new MCPToolsAdapter(manager);
 * mcp.serveForever({ host: '127.0.0.1', port: 8766 });
 * ```
 *
 * Usage (embedded / programmatic)
 * --------------------------------
 * ```ts
 * const mcp = new MCPToolsAdapter(manager);
 * const response = await mcp.handleRequest(jsonRpcBody);
 * ```
 *
 * MCP specification: https://spec.modelcontextprotocol.io/specification/2024-11-05/
 */

import * as http from 'http';
import type { MemoryManager } from './memory-manager';
import type { MemoryType, ImportanceLevel } from './types';

// ── JSON-RPC 2.0 types ────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const TOOL_ERROR = -32001;

function ok(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function err(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// ── Tool result wrapper ───────────────────────────────────────────────────────

function toolResult(content: unknown, isError = false) {
  const text =
    typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

// ── MCP tool definitions ──────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'engram_store',
    description:
      'Store a new memory in Engram. Returns the created memory object with its ID.',
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
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for organisation and recall.',
        },
        source: {
          type: 'string',
          description: 'Agent ID that is storing this memory (default: mcp-client).',
        },
        namespace: {
          type: 'string',
          description: 'Memory namespace / space (default: default).',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'engram_recall',
    description:
      'Query memories using multi-signal ranking (recency + strength + keyword relevance + importance). Returns ranked list of memories.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to match against memory content and tags.',
        },
        type: {
          type: 'string',
          enum: ['episodic', 'semantic', 'procedural', 'working'],
          description: 'Filter by memory type.',
        },
        namespace: { type: 'string', description: 'Filter by namespace.' },
        minStrength: {
          type: 'number',
          description: 'Minimum strength threshold (0–1, default: 0.1).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10).',
        },
        agentId: {
          type: 'string',
          description: 'The agent ID performing the recall (reinforces accessed memories).',
        },
      },
    },
  },
  {
    name: 'engram_get',
    description: 'Retrieve a specific memory by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The memory ID.' },
        reinforce: {
          type: 'boolean',
          description: 'If true, accessing this memory boosts its strength (default: false).',
        },
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
        id: { type: 'string', description: 'The memory ID to update.' },
        content: { type: 'string', description: 'New memory content.' },
        agentId: { type: 'string', description: 'Agent performing the update.' },
      },
      required: ['id', 'content', 'agentId'],
    },
  },
  {
    name: 'engram_sweep',
    description:
      'Manually trigger the Ebbinghaus decay sweep. Decays, archives, or forgets memories based on their strength and stability. Returns a summary of changes.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'engram_stats',
    description:
      'Get memory statistics — total count, active, decayed, compressed, archived, superseded, and forgotten memories.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description: 'Optional namespace to scope the stats.',
        },
      },
    },
  },
  {
    name: 'engram_consolidate',
    description:
      'Run memory consolidation: compress semantically similar or weak memories into summaries to free capacity.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Limit consolidation to this namespace.' },
        strengthThreshold: {
          type: 'number',
          description: 'Only consolidate memories below this strength (default: 0.3).',
        },
      },
    },
  },
] as const;

// ── MCPToolsAdapter ───────────────────────────────────────────────────────────

export class MCPToolsAdapter {
  private manager: MemoryManager;
  private serverName: string;
  private serverVersion: string;

  static readonly MCP_VERSION = '2024-11-05';

  constructor(
    manager: MemoryManager,
    options: { serverName?: string; serverVersion?: string } = {},
  ) {
    this.manager = manager;
    this.serverName = options.serverName ?? 'engram';
    this.serverVersion = options.serverVersion ?? '0.1.0';
  }

  // ── Request dispatcher ──────────────────────────────────────────────────

  async handleRequest(body: unknown): Promise<JsonRpcResponse> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return err(null, PARSE_ERROR, 'Request must be a JSON object');
    }

    const req = body as Partial<JsonRpcRequest>;
    const id = req.id ?? null;
    const method = req.method ?? '';
    const params = req.params ?? {};

    if (req.jsonrpc !== '2.0') {
      return err(id, INVALID_REQUEST, 'Only JSON-RPC 2.0 is supported');
    }

    try {
      switch (method) {
        case 'initialize':
          return ok(id, this.handleInitialize(params));
        case 'tools/list':
          return ok(id, { tools: TOOL_DEFINITIONS });
        case 'tools/call':
          return ok(id, await this.handleToolsCall(params));
        case 'ping':
          return ok(id, {});
        default:
          return err(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err(id, INTERNAL_ERROR, `Internal error: ${message}`);
    }
  }

  // ── MCP handlers ────────────────────────────────────────────────────────

  private handleInitialize(params: Record<string, unknown>) {
    const clientInfo = (params.clientInfo as Record<string, string>) ?? {};
    console.log(
      `[engram-mcp] Client connected: ${clientInfo.name ?? 'unknown'} v${clientInfo.version ?? '?'}`,
    );
    return {
      protocolVersion: MCPToolsAdapter.MCP_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.serverName, version: this.serverVersion },
    };
  }

  private async handleToolsCall(params: Record<string, unknown>) {
    const toolName = params.name as string;
    const args = (params.arguments as Record<string, unknown>) ?? {};

    switch (toolName) {
      case 'engram_store':
        return this.toolStore(args);
      case 'engram_recall':
        return this.toolRecall(args);
      case 'engram_get':
        return this.toolGet(args);
      case 'engram_update':
        return this.toolUpdate(args);
      case 'engram_sweep':
        return this.toolSweep();
      case 'engram_stats':
        return this.toolStats(args);
      case 'engram_consolidate':
        return this.toolConsolidate(args);
      default:
        throw Object.assign(new Error(`Unknown tool: ${toolName}`), { code: TOOL_ERROR });
    }
  }

  // ── Tool implementations ─────────────────────────────────────────────────

  private async toolStore(args: Record<string, unknown>) {
    const namespace = (args.namespace as string) ?? undefined;

    // Auto-create the namespace if it doesn't exist (MCP clients shouldn't need to pre-create spaces)
    if (namespace && namespace !== 'default') {
      const existing = this.manager.spaces.getSpace(namespace);
      if (!existing) {
        this.manager.spaces.createSpace({
          name: namespace,
          maxCapacity: 0,
          acl: { 'mcp-client': ['read', 'write', 'admin'] },
          shared: true,
          consolidationInterval: 0,
        });
      }
    }

    const engram = await this.manager.encode({
      content: args.content as string,
      type: (args.type as MemoryType) ?? 'semantic',
      importance: (args.importance as ImportanceLevel) ?? 'medium',
      tags: (args.tags as string[]) ?? [],
      source: (args.source as string) ?? 'mcp-client',
      namespace,
    });
    return toolResult({ id: engram.id, content: engram.content, type: engram.type });
  }

  private async toolRecall(args: Record<string, unknown>) {
    const results = await this.manager.query({
      keywords: (args.keywords as string[]) ?? [],
      type: (args.type as MemoryType) ?? undefined,
      namespace: (args.namespace as string) ?? undefined,
      minStrength: (args.minStrength as number) ?? 0.1,
      limit: (args.limit as number) ?? 10,
      agentId: (args.agentId as string) ?? 'mcp-client',
    });
    return toolResult(
      results.map((r) => ({
        id: r.engram.id,
        content: r.engram.content,
        score: r.score,
        strength: r.engram.strength,
        type: r.engram.type,
        tags: r.engram.tags,
      })),
    );
  }

  private async toolGet(args: Record<string, unknown>) {
    const engram = await this.manager.get(
      args.id as string,
      (args.reinforce as boolean) ?? false,
    );
    if (!engram) {
      return toolResult(`Memory '${args.id}' not found`, true);
    }
    return toolResult(engram);
  }

  private async toolUpdate(args: Record<string, unknown>) {
    const updated = await this.manager.update(
      args.id as string,
      args.content as string,
      args.agentId as string,
    );
    return toolResult({ id: updated.id, version: updated.version });
  }

  private async toolSweep() {
    const result = await this.manager.runDecaySweep();
    return toolResult(result ?? { message: 'Sweep complete' });
  }

  private async toolStats(args: Record<string, unknown>) {
    const stats = await this.manager.stats(args.namespace as string | undefined);
    return toolResult(stats);
  }

  private async toolConsolidate(args: Record<string, unknown>) {
    const results = await this.manager.consolidate(
      args.namespace || args.strengthThreshold
        ? {
            namespace: args.namespace as string | undefined,
            strengthThreshold: args.strengthThreshold as number | undefined,
          }
        : undefined,
    );
    return toolResult({ consolidated: results.length, results });
  }

  // ── Standalone HTTP server ───────────────────────────────────────────────

  /**
   * Start a blocking HTTP server exposing this adapter as an MCP endpoint.
   *
   * The server accepts POST / with JSON-RPC 2.0 bodies.
   * GET / returns a JSON info page.
   */
  serveForever(options: { host?: string; port?: number } = {}): void {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? 8766;

    const adapter = this;

    const server = http.createServer(async (req, res) => {
      // ── GET / info ──────────────────────────────────────────
      if (req.method === 'GET') {
        const info = {
          name: adapter.serverName,
          version: adapter.serverVersion,
          protocol: MCPToolsAdapter.MCP_VERSION,
          tools: TOOL_DEFINITIONS.map((t) => t.name),
        };
        const body = JSON.stringify(info);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }

      // ── POST / JSON-RPC ─────────────────────────────────────
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(err(null, PARSE_ERROR, 'JSON parse error')));
            return;
          }

          const response = await adapter.handleRequest(body);
          const statusCode = 'error' in response ? 400 : 200;
          const responseBody = JSON.stringify(response);
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(responseBody);
        });
        return;
      }

      res.writeHead(405);
      res.end();
    });

    server.listen(port, host, () => {
      console.log(`[Engram MCP Server] http://${host}:${port}  (Ctrl-C to stop)`);
    });

    // Block until interrupted
    process.on('SIGINT', () => {
      server.close();
      process.exit(0);
    });
  }

  /**
   * Start the HTTP server in the background (non-blocking).
   *
   * Returns the underlying `http.Server` so callers can close it.
   */
  serveBackground(options: { host?: string; port?: number } = {}): http.Server {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? 8766;
    const adapter = this;

    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET') {
        const info = {
          name: adapter.serverName,
          version: adapter.serverVersion,
          protocol: MCPToolsAdapter.MCP_VERSION,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
        return;
      }
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          let body: unknown;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { body = {}; }
          const response = await adapter.handleRequest(body);
          const statusCode = 'error' in response ? 400 : 200;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        });
        return;
      }
      res.writeHead(405); res.end();
    });

    server.listen(port, host);
    console.log(`[Engram MCP Server] Background server on http://${host}:${port}`);
    return server;
  }
}
