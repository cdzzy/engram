/**
 * Engram Three-Layer MCP Interface
 * =================================
 * Implements the three-layer semantic memory API used by modern agent frameworks
 * (Episode / Fact / Working Context), providing named tool groups that map onto
 * Engram's typed memory model:
 *
 *   Layer 1 — Episode (episodic memory)
 *   ─────────────────────────────────────
 *   Stores sequential events with session context.  Each episode captures *what
 *   happened* at a point in time — actions, observations, interactions — so the
 *   agent can reconstruct a narrative of past sessions.
 *
 *   Tools:  engram_episode_add · engram_episode_search · engram_episode_get_session
 *
 *   Layer 2 — Fact (semantic memory)
 *   ─────────────────────────────────
 *   Stores structured, versioned knowledge assertions.  Facts can be retracted
 *   (superseded) when they become stale, keeping the knowledge base clean.
 *
 *   Tools:  engram_fact_assert · engram_fact_query · engram_fact_retract
 *
 *   Layer 3 — Working Context (working memory)
 *   ───────────────────────────────────────────
 *   A small, volatile key-value store for the *current session's* context.
 *   Working context is tagged `importance: critical` so decay is maximally slow,
 *   and items can be retrieved as a single "inject" payload for prompt stuffing.
 *
 *   Tools:  engram_context_set · engram_context_get · engram_context_clear
 *           engram_context_inject
 *
 * Differentiation vs stash (Go)
 * ──────────────────────────────
 * | Feature              | stash (Go, 659★)    | engram three-layer         |
 * |----------------------|---------------------|----------------------------|
 * | Forgetting curve     | ✗                   | ✓ Ebbinghaus decay         |
 * | Behavior observer    | ✗                   | ✓ tool-call / file / dec.  |
 * | Memory graph         | ✗                   | ✓ engram_link / related    |
 * | Timeline queries     | ✗                   | ✓ engram_timeline          |
 * | Fact versioning      | ✗                   | ✓ supersession chain       |
 * | Three-layer API      | ✓                   | ✓ (this module)            |
 * | Shared namespaces    | ✗                   | ✓ cross-agent ACL spaces   |
 * | Language             | Go                  | TypeScript                 |
 */

import type { MemoryManager } from './memory-manager';
import type { MemoryType, ImportanceLevel } from './types';

// ── Tool result helper ────────────────────────────────────────────────────────

function toolResult(content: unknown, isError = false) {
  const text =
    typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return { content: [{ type: 'text', text }], isError };
}

// ── Source label used for all three-layer memories ──────────────────────────

const THREE_LAYER_SOURCE = 'three-layer-mcp';

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

export const THREE_LAYER_TOOL_DEFINITIONS = [
  // ── Layer 1: Episode ───────────────────────────────────────────────────────
  {
    name: 'engram_episode_add',
    description:
      'Add an episode (event) to memory. Episodes represent "what happened" — actions taken, observations made, or interactions had — ordered by time. Use this to build a narrative log of agent activity.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Description of what happened in this episode.',
        },
        sessionId: {
          type: 'string',
          description:
            'Session identifier — groups episodes from the same working session (default: "default-session").',
        },
        importance: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low', 'trivial'],
          description: 'How important is this episode for future recall (default: medium).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags to categorise the episode.',
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          description: 'Arbitrary structured metadata (e.g. { tool: "bash", exitCode: 0 }).',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'engram_episode_search',
    description:
      'Search episodic memory by keywords, session, or time window. Returns episodes ordered by relevance score (recency × strength × keyword match).',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to match against episode content.',
        },
        sessionId: {
          type: 'string',
          description: 'Filter by session ID.',
        },
        after: {
          type: 'number',
          description: 'Unix timestamp (ms) — only return episodes created after this time.',
        },
        before: {
          type: 'number',
          description: 'Unix timestamp (ms) — only return episodes created before this time.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20).',
        },
      },
    },
  },
  {
    name: 'engram_episode_get_session',
    description:
      'Retrieve all episodes from a specific session, ordered chronologically. Useful for reconstructing the full narrative of a past working session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID to retrieve (default: "default-session").',
        },
        limit: {
          type: 'number',
          description: 'Maximum episodes to return (default: 50).',
        },
      },
    },
  },

  // ── Layer 2: Fact ──────────────────────────────────────────────────────────
  {
    name: 'engram_fact_assert',
    description:
      'Assert (store) a structured fact. Facts represent stable knowledge — things the agent knows to be true. If a fact with the same subject and predicate already exists, it is superseded (versioned) rather than duplicated.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'The entity this fact is about (e.g. "vitest", "user", "project").',
        },
        predicate: {
          type: 'string',
          description: 'The relationship or property (e.g. "version", "prefers", "requires").',
        },
        value: {
          type: 'string',
          description: 'The value of the fact (e.g. "2.1.9", "dark mode", "Node 20").',
        },
        confidence: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low', 'trivial'],
          description: 'Confidence / importance level (default: high).',
        },
        namespace: {
          type: 'string',
          description: 'Memory namespace (default: "facts").',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags.',
        },
      },
      required: ['subject', 'predicate', 'value'],
    },
  },
  {
    name: 'engram_fact_query',
    description:
      'Query facts by subject, predicate, or keyword. Returns active (non-retracted) facts ordered by confidence and recency.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Filter by subject (partial match).',
        },
        predicate: {
          type: 'string',
          description: 'Filter by predicate (partial match).',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Free-text keywords to match against subject/predicate/value.',
        },
        namespace: {
          type: 'string',
          description: 'Memory namespace to search (default: "facts").',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 20).',
        },
      },
    },
  },
  {
    name: 'engram_fact_retract',
    description:
      'Retract (invalidate) a previously asserted fact by its memory ID. The fact is not deleted — it is marked as superseded so the history is preserved. Useful when knowledge becomes stale or incorrect.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The memory ID of the fact to retract.',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for retraction (stored in metadata).',
        },
      },
      required: ['id'],
    },
  },

  // ── Layer 3: Working Context ───────────────────────────────────────────────
  {
    name: 'engram_context_set',
    description:
      'Set a key-value pair in the working context for the current session. Working context items are tagged critical importance (maximum decay resistance) and expire with the session. Use to remember the "state" of the current task.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Context key (e.g. "current_task", "active_file", "user_goal").',
        },
        value: {
          type: 'string',
          description: 'Context value.',
        },
        sessionId: {
          type: 'string',
          description: 'Session namespace (default: "working-context").',
        },
        ttlMs: {
          type: 'number',
          description:
            'Optional time-to-live in milliseconds. After this period the item will naturally decay. Default: no explicit TTL (uses normal decay).',
        },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'engram_context_get',
    description:
      'Get a specific key from the working context. Returns null if not found or expired.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Context key to retrieve.',
        },
        sessionId: {
          type: 'string',
          description: 'Session namespace (default: "working-context").',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'engram_context_clear',
    description:
      'Clear all working context items for a session. Use at the start of a new task to ensure a clean slate.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session namespace to clear (default: "working-context").',
        },
      },
    },
  },
  {
    name: 'engram_context_inject',
    description:
      'Generate a compact, prompt-ready string of the current working context. Returns all active context items as a formatted block that can be injected directly into a system prompt or tool call.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session namespace (default: "working-context").',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json', 'plaintext'],
          description: 'Output format (default: markdown).',
        },
      },
    },
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// ThreeLayerExtension
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ThreeLayerExtension adds Episode / Fact / Working-Context layer tools on top
 * of the existing MemoryManager.  It is instantiated once and injected into
 * EngramMCPStdioServer.
 */
export class ThreeLayerExtension {
  constructor(private readonly manager: MemoryManager) {}

  /**
   * Ensure a memory namespace exists and is writable by THREE_LAYER_SOURCE.
   * Mirrors the auto-create logic in MCPToolsAdapter.toolStore() so that
   * callers don't need to pre-register spaces.
   */
  private ensureNamespace(namespace: string): void {
    if (!namespace || namespace === 'default') return;
    const existing = this.manager.spaces.getSpace(namespace);
    if (!existing) {
      this.manager.spaces.createSpace({
        name: namespace,
        maxCapacity: 0,
        acl: { [THREE_LAYER_SOURCE]: ['read', 'write', 'admin'] },
        shared: true,
        consolidationInterval: 0,
      });
    }
  }

  // ── Layer 1: Episode ──────────────────────────────────────────────────────

  async episodeAdd(args: Record<string, unknown>) {
    const content = args['content'] as string;
    const sessionId = (args['sessionId'] as string) ?? 'default-session';
    const importance = ((args['importance'] as string) ?? 'medium') as ImportanceLevel;
    const tags = (args['tags'] as string[]) ?? [];
    const metadata = (args['metadata'] as Record<string, unknown>) ?? {};
    const ns = `episode:${sessionId}`;
    this.ensureNamespace(ns);

    const engram = await this.manager.encode({
      content,
      type: 'episodic' as MemoryType,
      importance,
      tags: ['episode', `session:${sessionId}`, ...tags],
      source: THREE_LAYER_SOURCE,
      namespace: ns,
      metadata: { sessionId, layer: 'episode', ...metadata },
    });

    return toolResult({
      id: engram.id,
      sessionId,
      content: engram.content.slice(0, 100),
      createdAt: engram.createdAt,
      layer: 'episode',
    });
  }

  async episodeSearch(args: Record<string, unknown>) {
    const keywords = (args['keywords'] as string[]) ?? [];
    const sessionId = args['sessionId'] as string | undefined;
    const after = (args['after'] as number) ?? 0;
    const before = (args['before'] as number) ?? Date.now();
    const limit = (args['limit'] as number) ?? 20;

    // Use recall engine with text search
    const results = await this.manager.query({
      text: keywords.join(' '),
      type: 'episodic',
      namespace: sessionId ? `episode:${sessionId}` : undefined,
      limit,
    });

    // Apply time window filter
    const filtered = results
      .filter((r) => r.engram.createdAt >= after && r.engram.createdAt <= before)
      .slice(0, limit);

    return toolResult({
      total: filtered.length,
      keywords,
      sessionId: sessionId ?? '(all)',
      episodes: filtered.map((r) => ({
        id: r.engram.id,
        content: r.engram.content.slice(0, 120),
        sessionId: (r.engram.metadata?.['sessionId'] as string) ?? 'unknown',
        score: Math.round(r.score * 1000) / 1000,
        createdAt: r.engram.createdAt,
        tags: r.engram.tags.filter((t) => !t.startsWith('session:')),
      })),
    });
  }

  async episodeGetSession(args: Record<string, unknown>) {
    const sessionId = (args['sessionId'] as string) ?? 'default-session';
    const limit = (args['limit'] as number) ?? 50;

    const memories = await this.manager.store.query({
      namespace: `episode:${sessionId}`,
      type: 'episodic',
      status: ['active', 'decayed'],
    });

    const sorted = memories
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((m) => ({
        id: m.id,
        content: m.content.slice(0, 150),
        createdAt: m.createdAt,
        importance: m.importance,
        strength: Math.round(m.strength * 100) / 100,
        tags: m.tags.filter((t) => !t.startsWith('session:')),
        metadata: m.metadata,
      }));

    return toolResult({
      sessionId,
      total: sorted.length,
      episodes: sorted,
    });
  }

  // ── Layer 2: Fact ──────────────────────────────────────────────────────────

  /**
   * Canonical tag that uniquely identifies a fact by subject+predicate.
   * Used for detecting duplicates and for supersession.
   */
  private factKey(subject: string, predicate: string): string {
    return `fact-key:${subject.toLowerCase()}:${predicate.toLowerCase()}`;
  }

  async factAssert(args: Record<string, unknown>) {
    const subject = args['subject'] as string;
    const predicate = args['predicate'] as string;
    const value = args['value'] as string;
    const confidence = ((args['confidence'] as string) ?? 'high') as ImportanceLevel;
    const namespace = (args['namespace'] as string) ?? 'facts';
    const tags = (args['tags'] as string[]) ?? [];

    const content = `[FACT] ${subject} ${predicate} ${value}`;
    const factKey = this.factKey(subject, predicate);
    this.ensureNamespace(namespace);

    // Check for existing active fact with same subject+predicate
    const existing = await this.manager.store.query({
      namespace,
      type: 'semantic',
      status: ['active'],
    });

    const sameFact = existing.filter((m) => m.tags.includes(factKey));
    let supersededId: string | null = null;

    if (sameFact.length > 0) {
      const oldFact = sameFact[0];
      supersededId = oldFact.id;
      // Mark old fact as superseded
      await this.manager.store.put({
        ...oldFact,
        status: 'superseded' as const,
        metadata: {
          ...oldFact.metadata,
          supersededReason: 'reasserted',
          supersededAt: Date.now(),
        },
      });
    }

    const engram = await this.manager.encode({
      content,
      type: 'semantic' as MemoryType,
      importance: confidence,
      tags: ['fact', factKey, `subject:${subject}`, `predicate:${predicate}`, ...tags],
      source: THREE_LAYER_SOURCE,
      namespace,
      metadata: {
        layer: 'fact',
        subject,
        predicate,
        value,
        factKey,
        supersedes: supersededId,
      },
    });

    // Back-fill supersededBy on old record
    if (supersededId) {
      const oldRecord = await this.manager.store.get(supersededId);
      if (oldRecord) {
        await this.manager.store.put({ ...oldRecord, supersededBy: engram.id });
      }
    }

    return toolResult({
      id: engram.id,
      subject,
      predicate,
      value,
      superseded: supersededId,
      namespace,
      layer: 'fact',
    });
  }

  async factQuery(args: Record<string, unknown>) {
    const subject = args['subject'] as string | undefined;
    const predicate = args['predicate'] as string | undefined;
    const keywords = (args['keywords'] as string[]) ?? [];
    const namespace = (args['namespace'] as string) ?? 'facts';
    const limit = (args['limit'] as number) ?? 20;

    // Get all active facts in namespace
    const allFacts = await this.manager.store.query({
      namespace,
      type: 'semantic',
      status: ['active'],
    });

    // Filter to only fact-tagged memories
    let facts = allFacts.filter((m) => m.tags.includes('fact'));

    // Apply subject/predicate filter (substring match)
    if (subject) {
      const lc = subject.toLowerCase();
      facts = facts.filter(
        (m) =>
          ((m.metadata?.['subject'] as string | undefined) ?? '').toLowerCase().includes(lc),
      );
    }
    if (predicate) {
      const lc = predicate.toLowerCase();
      facts = facts.filter(
        (m) =>
          ((m.metadata?.['predicate'] as string | undefined) ?? '').toLowerCase().includes(lc),
      );
    }

    // Keyword filter on full content
    if (keywords.length > 0) {
      facts = facts.filter((m) =>
        keywords.some((kw) => m.content.toLowerCase().includes(kw.toLowerCase())),
      );
    }

    const results = facts
      .sort((a, b) => b.strength - a.strength)
      .slice(0, limit)
      .map((m) => ({
        id: m.id,
        subject: m.metadata?.['subject'],
        predicate: m.metadata?.['predicate'],
        value: m.metadata?.['value'],
        confidence: m.importance,
        strength: Math.round(m.strength * 100) / 100,
        createdAt: m.createdAt,
        supersedes: m.metadata?.['supersedes'] ?? null,
      }));

    return toolResult({
      total: results.length,
      namespace,
      facts: results,
    });
  }

  async factRetract(args: Record<string, unknown>) {
    const id = args['id'] as string;
    const reason = (args['reason'] as string) ?? 'explicit retraction';

    const existing = await this.manager.store.get(id);
    if (!existing) return toolResult(`Fact '${id}' not found`, true);

    if (!existing.tags.includes('fact')) {
      return toolResult(`Memory '${id}' is not a fact`, true);
    }

    await this.manager.store.put({
      ...existing,
      status: 'superseded' as const,
      metadata: {
        ...existing.metadata,
        retractedAt: Date.now(),
        retractReason: reason,
      },
    });

    return toolResult({
      retracted: id,
      subject: existing.metadata?.['subject'],
      predicate: existing.metadata?.['predicate'],
      value: existing.metadata?.['value'],
      reason,
      layer: 'fact',
    });
  }

  // ── Layer 3: Working Context ───────────────────────────────────────────────

  private contextNamespace(sessionId: string): string {
    return `context:${sessionId}`;
  }

  async contextSet(args: Record<string, unknown>) {
    const key = args['key'] as string;
    const value = args['value'] as string;
    const sessionId = (args['sessionId'] as string) ?? 'working-context';
    const ttlMs = args['ttlMs'] as number | undefined;
    const ns = this.contextNamespace(sessionId);
    this.ensureNamespace(ns);

    // Supersede any existing active entry for the same key
    const existing = await this.manager.store.query({
      namespace: ns,
      type: 'working',
      status: ['active'],
    });

    for (const old of existing.filter((m) => m.tags.includes(`ctx:${key}`))) {
      await this.manager.store.put({
        ...old,
        status: 'superseded' as const,
        metadata: { ...old.metadata, supersededAt: Date.now() },
      });
    }

    const content = `[CONTEXT] ${key}: ${value}`;
    const engram = await this.manager.encode({
      content,
      type: 'working' as MemoryType,
      importance: 'critical',           // max decay resistance
      tags: ['context', `ctx:${key}`, `session:${sessionId}`],
      source: THREE_LAYER_SOURCE,
      namespace: ns,
      metadata: {
        layer: 'working-context',
        key,
        value,
        sessionId,
        ttlMs: ttlMs ?? null,
        expiresAt: ttlMs ? Date.now() + ttlMs : null,
      },
    });

    return toolResult({
      id: engram.id,
      key,
      value,
      sessionId,
      namespace: ns,
      layer: 'working-context',
    });
  }

  async contextGet(args: Record<string, unknown>) {
    const key = args['key'] as string;
    const sessionId = (args['sessionId'] as string) ?? 'working-context';
    const ns = this.contextNamespace(sessionId);

    const all = await this.manager.store.query({
      namespace: ns,
      type: 'working',
      status: ['active'],
    });

    const entry = all
      .filter((m) => m.tags.includes(`ctx:${key}`))
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    if (!entry) {
      return toolResult({ key, value: null, found: false, sessionId });
    }

    // Check TTL expiry
    const expiresAt = entry.metadata?.['expiresAt'] as number | null;
    if (expiresAt && Date.now() > expiresAt) {
      return toolResult({ key, value: null, found: false, expired: true, sessionId });
    }

    return toolResult({
      id: entry.id,
      key,
      value: entry.metadata?.['value'] as string,
      found: true,
      sessionId,
      createdAt: entry.createdAt,
      strength: Math.round(entry.strength * 100) / 100,
    });
  }

  async contextClear(args: Record<string, unknown>) {
    const sessionId = (args['sessionId'] as string) ?? 'working-context';
    const ns = this.contextNamespace(sessionId);

    const all = await this.manager.store.query({
      namespace: ns,
      type: 'working',
      status: ['active'],
    });

    let cleared = 0;
    for (const m of all) {
      await this.manager.store.put({
        ...m,
        status: 'superseded' as const,
        metadata: { ...m.metadata, clearedAt: Date.now() },
      });
      cleared++;
    }

    return toolResult({
      sessionId,
      cleared,
      namespace: ns,
      layer: 'working-context',
    });
  }

  async contextInject(args: Record<string, unknown>) {
    const sessionId = (args['sessionId'] as string) ?? 'working-context';
    const format = (args['format'] as string) ?? 'markdown';
    const ns = this.contextNamespace(sessionId);

    const all = await this.manager.store.query({
      namespace: ns,
      type: 'working',
      status: ['active'],
    });

    // Deduplicate — keep only the latest entry per key; skip expired TTL items
    const keyMap = new Map<string, { key: string; value: string }>();
    for (const m of all.sort((a, b) => b.createdAt - a.createdAt)) {
      const k = m.metadata?.['key'] as string | undefined;
      if (!k || keyMap.has(k)) continue;

      const expiresAt = m.metadata?.['expiresAt'] as number | null;
      if (expiresAt && Date.now() > expiresAt) continue;

      keyMap.set(k, { key: k, value: (m.metadata?.['value'] as string) ?? '' });
    }

    const entries = Array.from(keyMap.values());

    let injected: string;
    if (format === 'json') {
      injected = JSON.stringify(
        Object.fromEntries(entries.map((e) => [e.key, e.value])),
        null,
        2,
      );
    } else if (format === 'plaintext') {
      injected = entries.map((e) => `${e.key}: ${e.value}`).join('\n');
    } else {
      // markdown (default)
      injected =
        entries.length === 0
          ? '> (no working context)'
          : `## Working Context (session: ${sessionId})\n\n` +
            entries.map((e) => `- **${e.key}**: ${e.value}`).join('\n');
    }

    return toolResult({
      sessionId,
      itemCount: entries.length,
      format,
      injected,
      layer: 'working-context',
    });
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  /**
   * Dispatch a tool call to the appropriate layer method.
   * Returns `null` if the tool name is not handled by this extension.
   */
  async dispatch(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown | null> {
    switch (toolName) {
      // Episode
      case 'engram_episode_add':           return this.episodeAdd(args);
      case 'engram_episode_search':        return this.episodeSearch(args);
      case 'engram_episode_get_session':   return this.episodeGetSession(args);
      // Fact
      case 'engram_fact_assert':           return this.factAssert(args);
      case 'engram_fact_query':            return this.factQuery(args);
      case 'engram_fact_retract':          return this.factRetract(args);
      // Working Context
      case 'engram_context_set':           return this.contextSet(args);
      case 'engram_context_get':           return this.contextGet(args);
      case 'engram_context_clear':         return this.contextClear(args);
      case 'engram_context_inject':        return this.contextInject(args);
      default:                             return null;
    }
  }
}
