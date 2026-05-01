/**
 * BehaviorObserver — Behavior-Driven Memory for AI Agents
 *
 * Inspired by MemoriLabs/Memori (13k★): "Memory from what agents do,
 * not just what they say."
 *
 * Traditional memory systems capture conversation text. BehaviorObserver
 * captures the agent's *actions* — tool calls, file operations, decisions —
 * and automatically encodes them as structured engrams.
 *
 * This produces richer, more reliable memories because:
 * - Tool call outcomes are factual (not summarized)
 * - File changes are traceable (path + change type)
 * - Decisions are reasoned (context + choice + rationale)
 *
 * Architecture
 * ─────────────
 *
 *   Agent runtime
 *        │
 *        ▼
 *   BehaviorObserver          (collects raw events)
 *        │
 *        ▼
 *   BehaviorExtractor          (extracts meaningful content from events)
 *        │
 *        ▼
 *   MemoryManager.encode()     (stores as typed Engrams with appropriate
 *                               importance, tags, and namespace)
 *
 * Usage
 * ─────
 *
 * ```ts
 * const observer = new BehaviorObserver(manager, {
 *   namespace: 'agent-x',
 *   minImportance: 'low',
 *   captureToolCalls: true,
 *   captureFileChanges: true,
 *   captureDecisions: true,
 * });
 *
 * // In your tool execution hook:
 * await observer.onToolCall('read_file', { path: 'src/app.ts' }, '// file contents');
 *
 * // In your file system hook:
 * await observer.onFileChange('src/config.ts', 'modify', { size: 1200 });
 *
 * // When the agent makes a decision:
 * await observer.onDecision(
 *   'User asked to refactor auth module',
 *   'Extract JWT logic into separate service',
 *   'Separation of concerns; JWT validation is reused in 3 places',
 * );
 * ```
 *
 * MCP Integration
 * ───────────────
 * The EngramMCPStdioServer exposes three behavior tools so any MCP client
 * (Claude Code, Cursor, etc.) can report behaviors directly:
 *
 *   engram_observe_tool_call   — report a tool invocation + result
 *   engram_observe_file        — report a file system change
 *   engram_observe_decision    — report an agent decision
 */

import type { MemoryManager } from './memory-manager';
import type { ImportanceLevel, MemoryType } from './types';

// ── Event types ───────────────────────────────────────────────────────────────

/** A recorded tool call event */
export interface ToolCallEvent {
  tool: string;
  params: Record<string, unknown>;
  result: unknown;
  durationMs?: number;
  error?: string;
  timestamp: number;
}

/** A recorded file system change event */
export interface FileChangeEvent {
  path: string;
  change: 'create' | 'modify' | 'delete' | 'read';
  meta?: Record<string, unknown>;  // e.g. { size, lines, language }
  timestamp: number;
}

/** A recorded agent decision event */
export interface DecisionEvent {
  context: string;   // What situation prompted the decision?
  choice: string;    // What did the agent decide?
  reason: string;    // Why?
  alternatives?: string[];  // Other options considered
  timestamp: number;
}

// ── Observer configuration ────────────────────────────────────────────────────

export interface BehaviorObserverConfig {
  /** Namespace for behavior memories (default: 'behavior') */
  namespace?: string;
  /** Source/agent ID for attribution (default: 'observer') */
  agentId?: string;
  /** Minimum importance level to store (default: 'low') */
  minImportance?: ImportanceLevel;
  /** Whether to capture tool call events (default: true) */
  captureToolCalls?: boolean;
  /** Whether to capture file change events (default: true) */
  captureFileChanges?: boolean;
  /** Whether to capture decision events (default: true) */
  captureDecisions?: boolean;
  /**
   * Tool names to ignore (e.g. noisy read-only tools).
   * Default: ['ping', 'health_check']
   */
  ignoredTools?: string[];
  /**
   * File extensions to ignore.
   * Default: ['.lock', '.log', '.tmp']
   */
  ignoredExtensions?: string[];
  /**
   * Max length of result/content stored in memory (default: 500 chars).
   * Longer results are truncated with an ellipsis.
   */
  maxResultLength?: number;
}

const DEFAULT_CONFIG: Required<BehaviorObserverConfig> = {
  namespace: 'behavior',
  agentId: 'observer',
  minImportance: 'low',
  captureToolCalls: true,
  captureFileChanges: true,
  captureDecisions: true,
  ignoredTools: ['ping', 'health_check'],
  ignoredExtensions: ['.lock', '.log', '.tmp'],
  maxResultLength: 500,
};

// ── Importance inference ──────────────────────────────────────────────────────

/**
 * Infer importance level from a tool call.
 * - Destructive operations → high
 * - State-changing operations → medium
 * - Pure reads → low
 * - Errors → high (failures are important to remember)
 */
function inferToolImportance(tool: string, error?: string): ImportanceLevel {
  if (error) return 'high';

  const toolLower = tool.toLowerCase();

  // Destructive / irreversible
  if (/delete|remove|drop|truncate|destroy|kill|terminate/.test(toolLower)) {
    return 'high';
  }

  // State-changing / writing
  if (/write|create|update|insert|patch|push|deploy|commit|send|post|put/.test(toolLower)) {
    return 'medium';
  }

  // Pure reads (lower importance, still useful for recall)
  return 'low';
}

/**
 * Infer importance level from a file change.
 * - Deletions → high
 * - Creates/modifies → medium
 * - Reads → low
 */
function inferFileImportance(change: FileChangeEvent['change']): ImportanceLevel {
  switch (change) {
    case 'delete': return 'high';
    case 'create': return 'medium';
    case 'modify': return 'medium';
    case 'read': return 'low';
  }
}

const IMPORTANCE_ORDER: ImportanceLevel[] = ['trivial', 'low', 'medium', 'high', 'critical'];

function importanceGte(a: ImportanceLevel, b: ImportanceLevel): boolean {
  return IMPORTANCE_ORDER.indexOf(a) >= IMPORTANCE_ORDER.indexOf(b);
}

// ── Content helpers ───────────────────────────────────────────────────────────

function truncate(value: unknown, maxLen: number): string {
  const str = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined');
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return dot > slash ? path.slice(dot) : '';
}

// ── BehaviorObserver ──────────────────────────────────────────────────────────

/**
 * Observes agent behaviors and automatically encodes them as Engrams.
 *
 * Behaviors captured:
 * - Tool calls (tool name, params, result, duration, errors)
 * - File system changes (path, change type, metadata)
 * - Agent decisions (context, choice, rationale)
 */
export class BehaviorObserver {
  private readonly manager: MemoryManager;
  private readonly config: Required<BehaviorObserverConfig>;

  /** Number of memories successfully encoded this session */
  private encoded = 0;
  /** Number of events skipped (below minImportance or ignored) */
  private skipped = 0;

  constructor(
    manager: MemoryManager,
    config: BehaviorObserverConfig = {},
  ) {
    this.manager = manager;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureNamespace();
  }

  /**
   * Ensure the target namespace exists as a MemorySpace.
   * Called synchronously from the constructor.
   */
  private ensureNamespace(): void {
    const ns = this.config.namespace;
    if (ns === 'default') return; // default namespace always exists
    if (this.manager.getSpace(ns)) return; // already created
    // Create the namespace with the observer's agentId as admin
    this.manager.createSpace({
      name: ns,
      shared: false,
      maxCapacity: 0,
      consolidationInterval: 0,
      acl: { [this.config.agentId]: ['admin', 'read', 'write'] },
    });
  }

  // ── Session stats ─────────────────────────────────────────────────────────

  get stats() {
    return { encoded: this.encoded, skipped: this.skipped };
  }

  // ── Tool call observation ─────────────────────────────────────────────────

  /**
   * Observe a tool call and encode it as an episodic memory.
   *
   * @param tool    Name of the tool that was called
   * @param params  Arguments passed to the tool
   * @param result  Return value of the tool (or undefined on error)
   * @param options Optional: durationMs, error message
   */
  async onToolCall(
    tool: string,
    params: Record<string, unknown>,
    result: unknown,
    options: { durationMs?: number; error?: string } = {},
  ): Promise<void> {
    if (!this.config.captureToolCalls) return;
    if (this.config.ignoredTools.includes(tool)) {
      this.skipped++;
      return;
    }

    const importance = inferToolImportance(tool, options.error);
    if (!importanceGte(importance, this.config.minImportance)) {
      this.skipped++;
      return;
    }

    const event: ToolCallEvent = {
      tool,
      params,
      result,
      durationMs: options.durationMs,
      error: options.error,
      timestamp: Date.now(),
    };

    const content = this.formatToolCallContent(event);
    const tags = this.buildToolTags(event);

    await this.manager.encode({
      content,
      type: 'episodic' as MemoryType,
      importance,
      tags,
      source: this.config.agentId,
      namespace: this.config.namespace,
      metadata: {
        behaviorType: 'tool_call',
        tool,
        durationMs: options.durationMs,
        hasError: !!options.error,
      },
    });

    this.encoded++;
  }

  private formatToolCallContent(event: ToolCallEvent): string {
    const paramStr = truncate(event.params, 200);
    const resultStr = truncate(event.result, this.config.maxResultLength);

    if (event.error) {
      return `Tool call failed: ${event.tool}(${paramStr}) → ERROR: ${event.error}`;
    }

    const duration = event.durationMs != null ? ` [${event.durationMs}ms]` : '';
    return `Tool call: ${event.tool}(${paramStr}) → ${resultStr}${duration}`;
  }

  private buildToolTags(event: ToolCallEvent): string[] {
    const tags = ['behavior', 'tool-call', event.tool];
    if (event.error) tags.push('error');
    if (event.durationMs != null && event.durationMs > 5000) tags.push('slow');
    return tags;
  }

  // ── File change observation ───────────────────────────────────────────────

  /**
   * Observe a file system change and encode it as an episodic memory.
   *
   * @param path   File path that changed
   * @param change Type of change: 'create' | 'modify' | 'delete' | 'read'
   * @param meta   Optional metadata (e.g. file size, line count, language)
   */
  async onFileChange(
    path: string,
    change: FileChangeEvent['change'],
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    if (!this.config.captureFileChanges) return;

    const ext = fileExtension(path);
    if (this.config.ignoredExtensions.includes(ext)) {
      this.skipped++;
      return;
    }

    const importance = inferFileImportance(change);
    if (!importanceGte(importance, this.config.minImportance)) {
      this.skipped++;
      return;
    }

    const event: FileChangeEvent = { path, change, meta, timestamp: Date.now() };
    const content = this.formatFileChangeContent(event);
    const tags = this.buildFileTags(event);

    await this.manager.encode({
      content,
      type: 'episodic' as MemoryType,
      importance,
      tags,
      source: this.config.agentId,
      namespace: this.config.namespace,
      metadata: {
        behaviorType: 'file_change',
        path,
        change,
        ...meta,
      },
    });

    this.encoded++;
  }

  private formatFileChangeContent(event: FileChangeEvent): string {
    const changeVerb: Record<FileChangeEvent['change'], string> = {
      create: 'Created file',
      modify: 'Modified file',
      delete: 'Deleted file',
      read: 'Read file',
    };
    const verb = changeVerb[event.change];
    const metaParts = Object.entries(event.meta ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    return metaParts
      ? `${verb}: ${event.path} (${metaParts})`
      : `${verb}: ${event.path}`;
  }

  private buildFileTags(event: FileChangeEvent): string[] {
    const tags = ['behavior', 'file', event.change];
    const ext = fileExtension(event.path);
    if (ext) tags.push(ext.replace('.', ''));
    return tags;
  }

  // ── Decision observation ──────────────────────────────────────────────────

  /**
   * Observe an agent decision and encode it as a semantic memory.
   *
   * Decisions are stored as semantic memories (not episodic) because they
   * represent generalizable knowledge about how the agent reasons.
   *
   * @param context      The situation or trigger for the decision
   * @param choice       What the agent decided to do
   * @param reason       The rationale behind the decision
   * @param alternatives Optional list of other options considered
   */
  async onDecision(
    context: string,
    choice: string,
    reason: string,
    alternatives: string[] = [],
  ): Promise<void> {
    if (!this.config.captureDecisions) return;

    // Decisions are always at least medium importance
    const importance: ImportanceLevel = 'medium';
    if (!importanceGte(importance, this.config.minImportance)) {
      this.skipped++;
      return;
    }

    const event: DecisionEvent = {
      context,
      choice,
      reason,
      alternatives,
      timestamp: Date.now(),
    };

    const content = this.formatDecisionContent(event);
    const tags = ['behavior', 'decision'];
    if (alternatives.length > 0) tags.push('considered-alternatives');

    await this.manager.encode({
      content,
      type: 'semantic' as MemoryType,
      importance,
      tags,
      source: this.config.agentId,
      namespace: this.config.namespace,
      metadata: {
        behaviorType: 'decision',
        context,
        choice,
        alternatives,
      },
    });

    this.encoded++;
  }

  private formatDecisionContent(event: DecisionEvent): string {
    let content = `Decision: ${event.choice}\nContext: ${event.context}\nReason: ${event.reason}`;
    if ((event.alternatives ?? []).length > 0) {
      content += `\nAlternatives considered: ${(event.alternatives ?? []).join(', ')}`;
    }
    return content;
  }

  // ── Batch observation ─────────────────────────────────────────────────────

  /**
   * Replay a batch of pre-recorded tool call events.
   * Useful for ingesting logs from a completed session.
   */
  async replayToolCalls(events: Omit<ToolCallEvent, 'timestamp'>[]): Promise<void> {
    for (const event of events) {
      await this.onToolCall(event.tool, event.params, event.result, {
        durationMs: event.durationMs,
        error: event.error,
      });
    }
  }

  /**
   * Replay a batch of pre-recorded file change events.
   */
  async replayFileChanges(events: Omit<FileChangeEvent, 'timestamp'>[]): Promise<void> {
    for (const event of events) {
      await this.onFileChange(event.path, event.change, event.meta);
    }
  }
}
