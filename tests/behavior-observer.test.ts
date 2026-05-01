/**
 * Tests for BehaviorObserver
 *
 * Covers:
 * - Tool call observation (normal, error, ignored, below-threshold)
 * - File change observation (all change types, ignored extensions)
 * - Decision observation
 * - Batch replay methods
 * - Configuration options (minImportance, namespaces, flags)
 * - MCP tool integration via EngramMCPStdioServer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryManager } from '../src/memory-manager';
import { BehaviorObserver } from '../src/behavior-observer';
import { EngramMCPStdioServer } from '../src/mcp-stdio';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeManager() {
  const manager = new MemoryManager();
  manager.start();
  return manager;
}

function makeObserver(config = {}) {
  return new BehaviorObserver(makeManager(), config);
}

async function allMemories(manager: MemoryManager) {
  return manager.store.query({ status: ['active'] });
}

async function rpc(
  server: EngramMCPStdioServer,
  method: string,
  params: Record<string, unknown> = {},
) {
  return server.handleRequest({ jsonrpc: '2.0', id: 1, method, params }) as Promise<
    Record<string, unknown>
  >;
}

async function callTool(
  server: EngramMCPStdioServer,
  name: string,
  args: Record<string, unknown>,
) {
  const resp = await rpc(server, 'tools/call', { name, arguments: args });
  return resp['result'] as Record<string, unknown>;
}

// ── BehaviorObserver unit tests ───────────────────────────────────────────────

describe('BehaviorObserver — tool calls', () => {
  it('encodes a write tool call as episodic memory', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onToolCall('write_file', { path: 'src/app.ts' }, 'ok');

    const memories = await allMemories(manager);
    expect(memories.length).toBe(1);
    expect(memories[0].type).toBe('episodic');
    expect(memories[0].content).toContain('write_file');
    expect(memories[0].content).toContain('src/app.ts');
    expect(memories[0].tags).toContain('tool-call');
    expect(memories[0].tags).toContain('write_file');
  });

  it('infers high importance for destructive tools', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onToolCall('delete_file', { path: 'old.ts' }, 'deleted');

    const memories = await allMemories(manager);
    expect(memories[0].importance).toBe('high');
  });

  it('infers medium importance for write tools', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onToolCall('create_file', { path: 'new.ts' }, 'created');

    const memories = await allMemories(manager);
    expect(memories[0].importance).toBe('medium');
  });

  it('infers low importance for read tools', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onToolCall('read_file', { path: 'config.ts' }, '// content');

    const memories = await allMemories(manager);
    expect(memories[0].importance).toBe('low');
  });

  it('infers high importance for errors regardless of tool name', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onToolCall('read_file', { path: 'missing.ts' }, undefined, {
      error: 'File not found',
    });

    const memories = await allMemories(manager);
    expect(memories[0].importance).toBe('high');
    expect(memories[0].content).toContain('ERROR');
    expect(memories[0].tags).toContain('error');
  });

  it('skips tools in ignoredTools list', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager, { ignoredTools: ['health_check', 'ping'] });

    await observer.onToolCall('ping', {}, 'pong');
    await observer.onToolCall('health_check', {}, 'ok');

    const memories = await allMemories(manager);
    expect(memories.length).toBe(0);
    expect(observer.stats.skipped).toBe(2);
  });

  it('skips tool calls below minImportance', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager, { minImportance: 'medium' });

    // read_file has 'low' importance → should be skipped
    await observer.onToolCall('read_file', { path: 'x.ts' }, 'content');

    const memories = await allMemories(manager);
    expect(memories.length).toBe(0);
    expect(observer.stats.skipped).toBe(1);
  });

  it('respects captureToolCalls: false', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager, { captureToolCalls: false });

    await observer.onToolCall('write_file', { path: 'x.ts' }, 'ok');

    const memories = await allMemories(manager);
    expect(memories.length).toBe(0);
  });

  it('stores durationMs in metadata', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onToolCall('bash', { cmd: 'npm test' }, 'passed', { durationMs: 3200 });

    const memories = await allMemories(manager);
    expect(memories[0].metadata?.durationMs).toBe(3200);
    expect(memories[0].content).toContain('3200ms');
  });

  it('tags slow calls (>5s) with "slow"', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onToolCall('bash', { cmd: 'slow-test' }, 'ok', { durationMs: 8000 });

    const memories = await allMemories(manager);
    expect(memories[0].tags).toContain('slow');
  });

  it('stores in custom namespace', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager, { namespace: 'agent-x' });

    await observer.onToolCall('write_file', { path: 'x.ts' }, 'ok');

    const memories = await manager.store.query({ namespace: 'agent-x' });
    expect(memories.length).toBe(1);
  });

  it('tracks encoded count in stats', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onToolCall('write_file', { path: 'a.ts' }, 'ok');
    await observer.onToolCall('delete_file', { path: 'b.ts' }, 'deleted');

    expect(observer.stats.encoded).toBe(2);
  });
});

// ── File change observation ───────────────────────────────────────────────────

describe('BehaviorObserver — file changes', () => {
  it('encodes a file creation as episodic memory', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onFileChange('src/utils.ts', 'create');

    const memories = await allMemories(manager);
    expect(memories.length).toBe(1);
    expect(memories[0].type).toBe('episodic');
    expect(memories[0].content).toContain('Created file');
    expect(memories[0].content).toContain('src/utils.ts');
    expect(memories[0].tags).toContain('file');
    expect(memories[0].tags).toContain('create');
    expect(memories[0].tags).toContain('ts');
  });

  it('encodes a file deletion with high importance', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onFileChange('legacy/old.ts', 'delete');

    const memories = await allMemories(manager);
    expect(memories[0].importance).toBe('high');
    expect(memories[0].content).toContain('Deleted file');
  });

  it('encodes a file modification with medium importance', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onFileChange('src/app.ts', 'modify');

    const memories = await allMemories(manager);
    expect(memories[0].importance).toBe('medium');
    expect(memories[0].content).toContain('Modified file');
  });

  it('encodes a file read with low importance', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onFileChange('README.md', 'read');

    const memories = await allMemories(manager);
    expect(memories[0].importance).toBe('low');
    expect(memories[0].content).toContain('Read file');
  });

  it('includes metadata in content', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onFileChange('src/big.ts', 'modify', { lines: 420, size: 12800 });

    const memories = await allMemories(manager);
    expect(memories[0].content).toContain('lines=420');
    expect(memories[0].content).toContain('size=12800');
  });

  it('skips files with ignored extensions', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onFileChange('yarn.lock', 'modify');
    await observer.onFileChange('debug.log', 'create');
    await observer.onFileChange('temp.tmp', 'create');

    const memories = await allMemories(manager);
    expect(memories.length).toBe(0);
    expect(observer.stats.skipped).toBe(3);
  });

  it('respects captureFileChanges: false', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager, { captureFileChanges: false });

    await observer.onFileChange('src/app.ts', 'modify');

    const memories = await allMemories(manager);
    expect(memories.length).toBe(0);
  });

  it('skips read events when minImportance is medium', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager, { minImportance: 'medium' });

    await observer.onFileChange('config.json', 'read');  // low → skip
    await observer.onFileChange('config.json', 'modify');  // medium → store

    const memories = await allMemories(manager);
    expect(memories.length).toBe(1);
    expect(memories[0].content).toContain('Modified');
  });

  it('stores path and change in metadata', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onFileChange('src/auth.ts', 'create', { language: 'TypeScript' });

    const memories = await allMemories(manager);
    expect(memories[0].metadata?.path).toBe('src/auth.ts');
    expect(memories[0].metadata?.change).toBe('create');
    expect(memories[0].metadata?.language).toBe('TypeScript');
  });
});

// ── Decision observation ──────────────────────────────────────────────────────

describe('BehaviorObserver — decisions', () => {
  it('encodes a decision as semantic memory', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onDecision(
      'User asked to improve performance',
      'Add caching layer with Redis',
      'Reduces DB load by 70% in read-heavy paths',
    );

    const memories = await allMemories(manager);
    expect(memories.length).toBe(1);
    expect(memories[0].type).toBe('semantic');
    expect(memories[0].importance).toBe('medium');
    expect(memories[0].content).toContain('Add caching layer with Redis');
    expect(memories[0].content).toContain('User asked to improve performance');
    expect(memories[0].content).toContain('Reduces DB load by 70%');
    expect(memories[0].tags).toContain('decision');
  });

  it('includes alternatives in content and metadata', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onDecision(
      'Need to handle auth',
      'Use JWT tokens',
      'Stateless, scales well',
      ['Sessions', 'OAuth only', 'API keys'],
    );

    const memories = await allMemories(manager);
    expect(memories[0].content).toContain('Sessions');
    expect(memories[0].content).toContain('OAuth only');
    expect(memories[0].tags).toContain('considered-alternatives');
    expect((memories[0].metadata?.alternatives as string[]).length).toBe(3);
  });

  it('respects captureDecisions: false', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager, { captureDecisions: false });

    await observer.onDecision('context', 'choice', 'reason');

    const memories = await allMemories(manager);
    expect(memories.length).toBe(0);
  });

  it('stores context and choice in metadata', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.onDecision(
      'Refactor auth module',
      'Extract JWT service',
      'SRP principle',
    );

    const memories = await allMemories(manager);
    expect(memories[0].metadata?.context).toBe('Refactor auth module');
    expect(memories[0].metadata?.choice).toBe('Extract JWT service');
  });
});

// ── Batch replay ──────────────────────────────────────────────────────────────

describe('BehaviorObserver — batch replay', () => {
  it('replayToolCalls stores multiple tool calls', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.replayToolCalls([
      { tool: 'write_file', params: { path: 'a.ts' }, result: 'ok' },
      { tool: 'write_file', params: { path: 'b.ts' }, result: 'ok' },
      { tool: 'delete_file', params: { path: 'old.ts' }, result: 'deleted' },
    ]);

    const memories = await allMemories(manager);
    expect(memories.length).toBe(3);
    expect(observer.stats.encoded).toBe(3);
  });

  it('replayFileChanges stores multiple file events', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager);

    await observer.replayFileChanges([
      { path: 'src/a.ts', change: 'create' },
      { path: 'src/b.ts', change: 'modify' },
      { path: 'src/c.ts', change: 'delete' },
    ]);

    const memories = await allMemories(manager);
    expect(memories.length).toBe(3);
  });

  it('replay respects ignore filters', async () => {
    const manager = makeManager();
    const observer = new BehaviorObserver(manager, { ignoredTools: ['ping'] });

    await observer.replayToolCalls([
      { tool: 'ping', params: {}, result: 'pong' },
      { tool: 'write_file', params: { path: 'x.ts' }, result: 'ok' },
    ]);

    const memories = await allMemories(manager);
    expect(memories.length).toBe(1);
    expect(observer.stats.skipped).toBe(1);
  });
});

// ── MCP tool integration ──────────────────────────────────────────────────────

describe('EngramMCPStdioServer — behavior tools', () => {
  function makeServer() {
    const manager = new MemoryManager();
    manager.start();
    return new EngramMCPStdioServer(manager);
  }

  it('tools/list includes all 3 behavior tools', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'tools/list');
    const tools = ((resp['result'] as Record<string, unknown>)['tools'] as Array<{ name: string }>);
    const names = tools.map((t) => t.name);
    expect(names).toContain('engram_observe_tool_call');
    expect(names).toContain('engram_observe_file');
    expect(names).toContain('engram_observe_decision');
  });

  it('total tool count is 15 (7 base + 5 differential + 3 behavior)', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'tools/list');
    const tools = (resp['result'] as Record<string, unknown>)['tools'] as unknown[];
    expect(tools.length).toBe(15);
  });

  it('engram_observe_tool_call stores a memory', async () => {
    const server = makeServer();

    const result = await callTool(server, 'engram_observe_tool_call', {
      tool: 'write_file',
      params: { path: 'src/app.ts' },
      result: 'written 200 bytes',
    });

    expect(result['isError']).toBeFalsy();
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.observed).toBe(true);
    expect(data.tool).toBe('write_file');

    // Verify the memory was stored
    const memories = await server.manager.store.query({
      namespace: 'behavior',
      status: ['active'],
    });
    expect(memories.length).toBe(1);
    expect(memories[0].content).toContain('write_file');
  });

  it('engram_observe_tool_call captures error correctly', async () => {
    const server = makeServer();

    await callTool(server, 'engram_observe_tool_call', {
      tool: 'read_file',
      params: { path: 'missing.ts' },
      error: 'File not found: missing.ts',
    });

    const memories = await server.manager.store.query({
      namespace: 'behavior',
      status: ['active'],
    });
    expect(memories.length).toBe(1);
    expect(memories[0].importance).toBe('high');
    expect(memories[0].content).toContain('ERROR');
  });

  it('engram_observe_tool_call respects custom namespace', async () => {
    const server = makeServer();

    await callTool(server, 'engram_observe_tool_call', {
      tool: 'write_file',
      params: { path: 'x.ts' },
      result: 'ok',
      namespace: 'custom-ns',
    });

    const memories = await server.manager.store.query({
      namespace: 'custom-ns',
      status: ['active'],
    });
    expect(memories.length).toBe(1);
  });

  it('engram_observe_file stores a file change memory', async () => {
    const server = makeServer();

    const result = await callTool(server, 'engram_observe_file', {
      path: 'src/auth.ts',
      change: 'modify',
      meta: { lines: 120 },
    });

    expect(result['isError']).toBeFalsy();
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.observed).toBe(true);
    expect(data.path).toBe('src/auth.ts');
    expect(data.change).toBe('modify');

    const memories = await server.manager.store.query({
      namespace: 'behavior',
      status: ['active'],
    });
    expect(memories[0].content).toContain('Modified file');
    expect(memories[0].content).toContain('lines=120');
  });

  it('engram_observe_decision stores a decision memory', async () => {
    const server = makeServer();

    const result = await callTool(server, 'engram_observe_decision', {
      context: 'User asked to handle rate limiting',
      choice: 'Use token bucket algorithm',
      reason: 'Smooth traffic shaping, low memory overhead',
      alternatives: ['Fixed window counter', 'Sliding log'],
    });

    expect(result['isError']).toBeFalsy();
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.observed).toBe(true);
    expect(data.alternativesConsidered).toBe(2);

    const memories = await server.manager.store.query({
      namespace: 'behavior',
      status: ['active'],
    });
    expect(memories[0].type).toBe('semantic');
    expect(memories[0].content).toContain('token bucket');
    expect(memories[0].tags).toContain('decision');
  });

  it('behavior memories can be recalled via engram_recall', async () => {
    const server = makeServer();

    // Store a few behavior memories
    await callTool(server, 'engram_observe_tool_call', {
      tool: 'write_file',
      params: { path: 'src/jwt.ts' },
      result: 'ok',
    });
    await callTool(server, 'engram_observe_decision', {
      context: 'Auth module refactor',
      choice: 'Extract JWT into separate module',
      reason: 'Reused in 3 places',
    });

    // Recall with keyword
    const resp = await rpc(server, 'tools/call', {
      name: 'engram_recall',
      arguments: { keywords: ['jwt'], namespace: 'behavior', limit: 10 },
    });
    const result = resp['result'] as Record<string, unknown>;
    const text = (result['content'] as Array<{ text: string }>)[0].text;
    expect(text.toLowerCase()).toContain('jwt');
  });

  it('combined: observe → timeline → recall workflow', async () => {
    const server = makeServer();
    const t0 = Date.now() - 1;

    await callTool(server, 'engram_observe_tool_call', {
      tool: 'create_file',
      params: { path: 'src/service.ts' },
      result: 'created',
    });

    await callTool(server, 'engram_observe_file', {
      path: 'src/service.ts',
      change: 'modify',
      meta: { lines: 50 },
    });

    await callTool(server, 'engram_observe_decision', {
      context: 'Service architecture decision',
      choice: 'Use repository pattern',
      reason: 'Testability and separation of concerns',
    });

    // Timeline should find all 3
    const tlResp = await rpc(server, 'tools/call', {
      name: 'engram_timeline',
      arguments: { after: t0, before: Date.now() + 1, namespace: 'behavior' },
    });
    const tlResult = tlResp['result'] as Record<string, unknown>;
    const tlData = JSON.parse((tlResult['content'] as Array<{ text: string }>)[0].text);
    expect(tlData.total).toBe(3);
  });
});
