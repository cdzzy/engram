/**
 * Tests for Three-Layer MCP Interface
 *
 * Covers all three layers:
 *   Layer 1 — Episode (engram_episode_add, engram_episode_search, engram_episode_get_session)
 *   Layer 2 — Fact    (engram_fact_assert, engram_fact_query, engram_fact_retract)
 *   Layer 3 — Working Context (engram_context_set, engram_context_get,
 *                               engram_context_clear, engram_context_inject)
 *
 * All tools are invoked through EngramMCPStdioServer.handleRequest to test
 * the full dispatch path.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryManager } from '../src/memory-manager';
import { EngramMCPStdioServer } from '../src/mcp-stdio';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeServer() {
  const manager = new MemoryManager();
  manager.start();
  return new EngramMCPStdioServer(manager);
}

async function rpc(
  server: EngramMCPStdioServer,
  method: string,
  params: Record<string, unknown> = {},
  id: number | string = 1,
) {
  return server.handleRequest({ jsonrpc: '2.0', id, method, params }) as Promise<
    Record<string, unknown>
  >;
}

async function callTool(
  server: EngramMCPStdioServer,
  toolName: string,
  args: Record<string, unknown> = {},
) {
  const resp = await rpc(server, 'tools/call', { name: toolName, arguments: args });
  const result = resp['result'] as Record<string, unknown>;
  const text = (result['content'] as Array<{ text: string }>)[0].text;
  // Error results may contain non-JSON strings — parse only when it looks like JSON
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON error message; leave data empty
    data = { _rawText: text };
  }
  return { result, data };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools/list — three-layer tools are discoverable
// ─────────────────────────────────────────────────────────────────────────────

describe('Three-Layer Interface — tools/list', () => {
  it('lists all episode tools', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'tools/list');
    const tools = (resp['result'] as Record<string, unknown>)['tools'] as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain('engram_episode_add');
    expect(names).toContain('engram_episode_search');
    expect(names).toContain('engram_episode_get_session');
  });

  it('lists all fact tools', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'tools/list');
    const tools = (resp['result'] as Record<string, unknown>)['tools'] as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain('engram_fact_assert');
    expect(names).toContain('engram_fact_query');
    expect(names).toContain('engram_fact_retract');
  });

  it('lists all working context tools', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'tools/list');
    const tools = (resp['result'] as Record<string, unknown>)['tools'] as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain('engram_context_set');
    expect(names).toContain('engram_context_get');
    expect(names).toContain('engram_context_clear');
    expect(names).toContain('engram_context_inject');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — Episode
// ─────────────────────────────────────────────────────────────────────────────

describe('Three-Layer Interface — Episode layer', () => {
  it('engram_episode_add stores an episode and returns id', async () => {
    const server = makeServer();
    const { data } = await callTool(server, 'engram_episode_add', {
      content: 'User asked me to refactor the auth module',
      sessionId: 'session-abc',
    });
    expect(typeof data['id']).toBe('string');
    expect(data['sessionId']).toBe('session-abc');
    expect(data['layer']).toBe('episode');
  });

  it('engram_episode_add uses default session when sessionId is omitted', async () => {
    const server = makeServer();
    const { data } = await callTool(server, 'engram_episode_add', {
      content: 'Default session episode',
    });
    expect(data['sessionId']).toBe('default-session');
  });

  it('engram_episode_add stores importance and tags', async () => {
    const server = makeServer();
    const { data } = await callTool(server, 'engram_episode_add', {
      content: 'Critical event: deployed to production',
      sessionId: 'session-prod',
      importance: 'critical',
      tags: ['deploy', 'prod'],
    });
    expect(data['id']).toBeTruthy();
  });

  it('engram_episode_search returns episodes matching keywords', async () => {
    const server = makeServer();
    await callTool(server, 'engram_episode_add', {
      content: 'Refactored the authentication module to use JWT',
      sessionId: 'session-1',
    });
    await callTool(server, 'engram_episode_add', {
      content: 'Updated the database schema',
      sessionId: 'session-1',
    });

    const { data } = await callTool(server, 'engram_episode_search', {
      keywords: ['authentication', 'JWT'],
    });

    expect(data['total']).toBeGreaterThanOrEqual(1);
    const episodes = data['episodes'] as Array<{ content: string }>;
    expect(episodes.some((e) => e.content.includes('JWT') || e.content.includes('authentication'))).toBe(true);
  });

  it('engram_episode_search filters by sessionId', async () => {
    const server = makeServer();
    await callTool(server, 'engram_episode_add', {
      content: 'Episode in session alpha',
      sessionId: 'alpha',
    });
    await callTool(server, 'engram_episode_add', {
      content: 'Episode in session beta',
      sessionId: 'beta',
    });

    const { data } = await callTool(server, 'engram_episode_search', {
      keywords: ['Episode'],
      sessionId: 'alpha',
    });

    const episodes = data['episodes'] as Array<{ sessionId: string }>;
    expect(episodes.every((e) => e.sessionId === 'alpha')).toBe(true);
  });

  it('engram_episode_get_session returns all episodes in session order', async () => {
    const server = makeServer();
    const sessionId = 'session-ordered';

    await callTool(server, 'engram_episode_add', { content: 'Step 1: plan', sessionId });
    await callTool(server, 'engram_episode_add', { content: 'Step 2: code', sessionId });
    await callTool(server, 'engram_episode_add', { content: 'Step 3: test', sessionId });

    const { data } = await callTool(server, 'engram_episode_get_session', { sessionId });

    expect(data['sessionId']).toBe(sessionId);
    expect(data['total']).toBe(3);

    const episodes = data['episodes'] as Array<{ content: string; createdAt: number }>;
    // Verify chronological order
    for (let i = 1; i < episodes.length; i++) {
      expect(episodes[i].createdAt).toBeGreaterThanOrEqual(episodes[i - 1].createdAt);
    }
  });

  it('engram_episode_get_session uses default-session when sessionId omitted', async () => {
    const server = makeServer();
    await callTool(server, 'engram_episode_add', { content: 'Default session ep 1' });

    const { data } = await callTool(server, 'engram_episode_get_session', {});
    expect(data['sessionId']).toBe('default-session');
    expect(data['total']).toBeGreaterThanOrEqual(1);
  });

  it('engram_episode_get_session respects limit parameter', async () => {
    const server = makeServer();
    const sessionId = 'limit-test';
    for (let i = 0; i < 5; i++) {
      await callTool(server, 'engram_episode_add', { content: `Episode ${i}`, sessionId });
    }

    const { data } = await callTool(server, 'engram_episode_get_session', {
      sessionId,
      limit: 3,
    });

    const episodes = data['episodes'] as unknown[];
    expect(episodes.length).toBeLessThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — Fact
// ─────────────────────────────────────────────────────────────────────────────

describe('Three-Layer Interface — Fact layer', () => {
  it('engram_fact_assert stores a fact and returns structured data', async () => {
    const server = makeServer();
    const { data } = await callTool(server, 'engram_fact_assert', {
      subject: 'vitest',
      predicate: 'version',
      value: '2.1.9',
    });

    expect(typeof data['id']).toBe('string');
    expect(data['subject']).toBe('vitest');
    expect(data['predicate']).toBe('version');
    expect(data['value']).toBe('2.1.9');
    expect(data['layer']).toBe('fact');
    expect(data['superseded']).toBeNull();
  });

  it('engram_fact_assert supersedes previous fact with same subject+predicate', async () => {
    const server = makeServer();

    const { data: first } = await callTool(server, 'engram_fact_assert', {
      subject: 'node',
      predicate: 'version',
      value: '18.0.0',
    });

    const { data: second } = await callTool(server, 'engram_fact_assert', {
      subject: 'node',
      predicate: 'version',
      value: '20.11.1',
    });

    expect(second['superseded']).toBe(first['id']);
    expect(second['value']).toBe('20.11.1');
  });

  it('engram_fact_query returns stored facts', async () => {
    const server = makeServer();
    await callTool(server, 'engram_fact_assert', {
      subject: 'typescript',
      predicate: 'version',
      value: '5.7.0',
    });

    const { data } = await callTool(server, 'engram_fact_query', {
      subject: 'typescript',
    });

    expect(data['total']).toBeGreaterThanOrEqual(1);
    const facts = data['facts'] as Array<{ subject: unknown; value: unknown }>;
    expect(facts.some((f) => f.subject === 'typescript' && f.value === '5.7.0')).toBe(true);
  });

  it('engram_fact_query filters by predicate', async () => {
    const server = makeServer();
    await callTool(server, 'engram_fact_assert', {
      subject: 'project',
      predicate: 'language',
      value: 'TypeScript',
    });
    await callTool(server, 'engram_fact_assert', {
      subject: 'project',
      predicate: 'author',
      value: 'cdzzy',
    });

    const { data } = await callTool(server, 'engram_fact_query', {
      predicate: 'author',
    });

    const facts = data['facts'] as Array<{ predicate: string }>;
    expect(facts.every((f) => f.predicate === 'author')).toBe(true);
  });

  it('engram_fact_query finds by keywords', async () => {
    const server = makeServer();
    await callTool(server, 'engram_fact_assert', {
      subject: 'engram',
      predicate: 'description',
      value: 'AI agent long-term memory system with forgetting curve',
    });

    const { data } = await callTool(server, 'engram_fact_query', {
      keywords: ['forgetting'],
    });

    expect(data['total']).toBeGreaterThanOrEqual(1);
  });

  it('engram_fact_retract marks a fact as superseded', async () => {
    const server = makeServer();
    const { data: factData } = await callTool(server, 'engram_fact_assert', {
      subject: 'server',
      predicate: 'status',
      value: 'online',
    });

    const factId = factData['id'] as string;

    const { data: retractData } = await callTool(server, 'engram_fact_retract', {
      id: factId,
      reason: 'server went offline',
    });

    expect(retractData['retracted']).toBe(factId);
    expect(retractData['reason']).toBe('server went offline');
  });

  it('retracted fact no longer appears in query results', async () => {
    const server = makeServer();

    const { data: factData } = await callTool(server, 'engram_fact_assert', {
      subject: 'feature',
      predicate: 'enabled',
      value: 'true',
    });
    const factId = factData['id'] as string;

    await callTool(server, 'engram_fact_retract', { id: factId });

    const { data: queryData } = await callTool(server, 'engram_fact_query', {
      subject: 'feature',
      predicate: 'enabled',
    });

    const facts = queryData['facts'] as Array<{ value: string }>;
    // Retracted fact should not appear (status: superseded, not active)
    expect(facts.every((f) => f.value !== 'true')).toBe(true);
  });

  it('engram_fact_retract returns error for non-existent id', async () => {
    const server = makeServer();
    const { result } = await callTool(server, 'engram_fact_retract', {
      id: 'nonexistent-fact-id',
    });
    expect(result['isError']).toBe(true);
  });

  it('engram_fact_retract returns error for non-fact memory', async () => {
    const server = makeServer();
    // Store a regular memory (not a fact)
    const storeResp = await rpc(server, 'tools/call', {
      name: 'engram_store',
      arguments: { content: 'regular memory', type: 'semantic' },
    });
    const storeResult = storeResp['result'] as Record<string, unknown>;
    const text = (storeResult['content'] as Array<{ text: string }>)[0].text;
    const { id } = JSON.parse(text) as { id: string };

    const { result } = await callTool(server, 'engram_fact_retract', { id });
    expect(result['isError']).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — Working Context
// ─────────────────────────────────────────────────────────────────────────────

describe('Three-Layer Interface — Working Context layer', () => {
  it('engram_context_set stores a key-value pair', async () => {
    const server = makeServer();
    const { data } = await callTool(server, 'engram_context_set', {
      key: 'current_task',
      value: 'implement three-layer MCP interface',
    });
    expect(data['key']).toBe('current_task');
    expect(data['value']).toBe('implement three-layer MCP interface');
    expect(data['layer']).toBe('working-context');
    expect(typeof data['id']).toBe('string');
  });

  it('engram_context_get retrieves a stored key', async () => {
    const server = makeServer();
    await callTool(server, 'engram_context_set', {
      key: 'active_file',
      value: 'src/three-layer-interface.ts',
    });

    const { data } = await callTool(server, 'engram_context_get', {
      key: 'active_file',
    });

    expect(data['found']).toBe(true);
    expect(data['value']).toBe('src/three-layer-interface.ts');
    expect(data['key']).toBe('active_file');
  });

  it('engram_context_get returns found: false for missing key', async () => {
    const server = makeServer();
    const { data } = await callTool(server, 'engram_context_get', {
      key: 'nonexistent_key',
    });
    expect(data['found']).toBe(false);
    expect(data['value']).toBeNull();
  });

  it('engram_context_set supersedes previous value for the same key', async () => {
    const server = makeServer();

    await callTool(server, 'engram_context_set', {
      key: 'user_goal',
      value: 'old goal',
    });
    await callTool(server, 'engram_context_set', {
      key: 'user_goal',
      value: 'new goal',
    });

    const { data } = await callTool(server, 'engram_context_get', {
      key: 'user_goal',
    });

    expect(data['found']).toBe(true);
    expect(data['value']).toBe('new goal');
  });

  it('engram_context_clear removes all context items for the session', async () => {
    const server = makeServer();
    const sessionId = 'test-clear-session';

    await callTool(server, 'engram_context_set', { key: 'k1', value: 'v1', sessionId });
    await callTool(server, 'engram_context_set', { key: 'k2', value: 'v2', sessionId });

    const { data: clearData } = await callTool(server, 'engram_context_clear', { sessionId });
    expect(clearData['cleared']).toBe(2);

    // Both keys should now be gone
    const { data: get1 } = await callTool(server, 'engram_context_get', { key: 'k1', sessionId });
    const { data: get2 } = await callTool(server, 'engram_context_get', { key: 'k2', sessionId });
    expect(get1['found']).toBe(false);
    expect(get2['found']).toBe(false);
  });

  it('engram_context_inject returns markdown by default', async () => {
    const server = makeServer();
    const sessionId = 'inject-session';

    await callTool(server, 'engram_context_set', {
      key: 'task',
      value: 'Write tests for MCP interface',
      sessionId,
    });
    await callTool(server, 'engram_context_set', {
      key: 'language',
      value: 'TypeScript',
      sessionId,
    });

    const { data } = await callTool(server, 'engram_context_inject', { sessionId });

    expect(data['itemCount']).toBe(2);
    expect(data['format']).toBe('markdown');
    const injected = data['injected'] as string;
    expect(injected).toContain('## Working Context');
    expect(injected).toContain('task');
    expect(injected).toContain('language');
  });

  it('engram_context_inject returns json format', async () => {
    const server = makeServer();
    const sessionId = 'json-session';
    await callTool(server, 'engram_context_set', { key: 'env', value: 'production', sessionId });

    const { data } = await callTool(server, 'engram_context_inject', {
      sessionId,
      format: 'json',
    });

    expect(data['format']).toBe('json');
    const injected = JSON.parse(data['injected'] as string) as Record<string, string>;
    expect(injected['env']).toBe('production');
  });

  it('engram_context_inject returns plaintext format', async () => {
    const server = makeServer();
    const sessionId = 'plain-session';
    await callTool(server, 'engram_context_set', { key: 'mode', value: 'debug', sessionId });

    const { data } = await callTool(server, 'engram_context_inject', {
      sessionId,
      format: 'plaintext',
    });

    expect(data['format']).toBe('plaintext');
    const injected = data['injected'] as string;
    expect(injected).toContain('mode: debug');
  });

  it('engram_context_inject returns empty message for no context', async () => {
    const server = makeServer();
    const { data } = await callTool(server, 'engram_context_inject', {
      sessionId: 'empty-session',
    });

    expect(data['itemCount']).toBe(0);
  });

  it('context is scoped to session — different sessions do not cross-contaminate', async () => {
    const server = makeServer();

    await callTool(server, 'engram_context_set', {
      key: 'project',
      value: 'alpha',
      sessionId: 'session-A',
    });
    await callTool(server, 'engram_context_set', {
      key: 'project',
      value: 'beta',
      sessionId: 'session-B',
    });

    const { data: a } = await callTool(server, 'engram_context_get', {
      key: 'project',
      sessionId: 'session-A',
    });
    const { data: b } = await callTool(server, 'engram_context_get', {
      key: 'project',
      sessionId: 'session-B',
    });

    expect(a['value']).toBe('alpha');
    expect(b['value']).toBe('beta');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-layer workflow
// ─────────────────────────────────────────────────────────────────────────────

describe('Three-Layer Interface — cross-layer workflow', () => {
  it('episode + fact + context together in a realistic agent session', async () => {
    const server = makeServer();
    const sessionId = 'realistic-session';

    // 1. Record an episode (what happened)
    const { data: ep } = await callTool(server, 'engram_episode_add', {
      content: 'User asked to implement auth module using JWT',
      sessionId,
      importance: 'high',
    });
    expect(ep['layer']).toBe('episode');

    // 2. Assert facts (what we know)
    await callTool(server, 'engram_fact_assert', {
      subject: 'project',
      predicate: 'auth_strategy',
      value: 'JWT',
    });
    await callTool(server, 'engram_fact_assert', {
      subject: 'jwt',
      predicate: 'library',
      value: 'jsonwebtoken@9',
    });

    // 3. Set working context (current state)
    await callTool(server, 'engram_context_set', {
      key: 'current_task',
      value: 'implement JWT auth middleware',
      sessionId,
    });
    await callTool(server, 'engram_context_set', {
      key: 'active_file',
      value: 'src/middleware/auth.ts',
      sessionId,
    });

    // 4. Retrieve context for injection
    const { data: inject } = await callTool(server, 'engram_context_inject', { sessionId });
    expect(inject['itemCount']).toBe(2);
    expect(inject['injected'] as string).toContain('current_task');

    // 5. Query facts
    const { data: facts } = await callTool(server, 'engram_fact_query', { subject: 'project' });
    expect(facts['total']).toBeGreaterThanOrEqual(1);

    // 6. Search episodes
    const { data: episodes } = await callTool(server, 'engram_episode_search', {
      keywords: ['JWT', 'auth'],
      sessionId,
    });
    expect(episodes['total']).toBeGreaterThanOrEqual(1);

    // 7. Session ends — clear working context
    const { data: cleared } = await callTool(server, 'engram_context_clear', { sessionId });
    expect(cleared['cleared']).toBe(2);
  });
});
