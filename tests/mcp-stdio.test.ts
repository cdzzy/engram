/**
 * Tests for EngramMCPStdioServer
 *
 * Covers:
 * - MCP protocol handshake (initialize, ping, tools/list)
 * - All differential tools: engram_link, engram_related, engram_timeline,
 *   engram_namespaces, engram_forget
 * - Delegation to base MCPToolsAdapter tools
 * - Error handling (unknown tool, missing memory)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryManager } from '../src/memory-manager';
import { EngramMCPStdioServer } from '../src/mcp-stdio';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function storeMemory(
  server: EngramMCPStdioServer,
  content: string,
  options: Record<string, unknown> = {},
) {
  const resp = await rpc(server, 'tools/call', {
    name: 'engram_store',
    arguments: { content, type: 'semantic', ...options },
  });
  const result = resp['result'] as Record<string, unknown>;
  const text = (result['content'] as Array<{ text: string }>)[0].text;
  const parsed = JSON.parse(text) as { id: string };
  return parsed.id;
}

// ── Protocol ──────────────────────────────────────────────────────────────────

describe('EngramMCPStdioServer — protocol', () => {
  it('handles initialize handshake', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
    expect(resp['result']).toBeDefined();
    const result = resp['result'] as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2024-11-05');
    expect((result['serverInfo'] as Record<string, unknown>)['name']).toBe('engram');
  });

  it('responds to ping', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'ping');
    expect(resp['result']).toEqual({});
  });

  it('returns null for notifications/initialized', async () => {
    const server = makeServer();
    const resp = await server.handleRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(resp).toBeNull();
  });

  it('returns error for unknown method', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'unknown/method') as Record<string, unknown>;
    expect(resp['error']).toBeDefined();
    expect((resp['error'] as Record<string, number>)['code']).toBe(-32601);
  });

  it('returns error for invalid JSON-RPC version', async () => {
    const server = makeServer();
    const resp = await server.handleRequest({
      jsonrpc: '1.0', id: 1, method: 'ping', params: {},
    }) as Record<string, unknown>;
    expect(resp['error']).toBeDefined();
  });

  it('returns error for non-object body', async () => {
    const server = makeServer();
    const resp = await server.handleRequest('bad input') as Record<string, unknown>;
    expect(resp['error']).toBeDefined();
  });
});

// ── tools/list ────────────────────────────────────────────────────────────────

describe('EngramMCPStdioServer — tools/list', () => {
  it('lists all base tools', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'tools/list');
    const tools = ((resp['result'] as Record<string, unknown>)['tools'] as Array<{ name: string }>);
    const names = tools.map((t) => t.name);
    expect(names).toContain('engram_store');
    expect(names).toContain('engram_recall');
    expect(names).toContain('engram_get');
    expect(names).toContain('engram_update');
    expect(names).toContain('engram_sweep');
    expect(names).toContain('engram_stats');
    expect(names).toContain('engram_consolidate');
  });

  it('lists all differential tools', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'tools/list');
    const tools = ((resp['result'] as Record<string, unknown>)['tools'] as Array<{ name: string }>);
    const names = tools.map((t) => t.name);
    expect(names).toContain('engram_link');
    expect(names).toContain('engram_related');
    expect(names).toContain('engram_timeline');
    expect(names).toContain('engram_namespaces');
    expect(names).toContain('engram_forget');
  });

  it('total tool count is 15 (7 base + 5 differential + 3 behavior)', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'tools/list');
    const tools = (resp['result'] as Record<string, unknown>)['tools'] as unknown[];
    expect(tools.length).toBe(15);
  });
});

// ── Base tools (delegation) ───────────────────────────────────────────────────

describe('EngramMCPStdioServer — base tool delegation', () => {
  it('engram_store stores a memory and returns id', async () => {
    const server = makeServer();
    const id = await storeMemory(server, 'TypeScript is great for large codebases');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('engram_recall finds stored memory by keyword', async () => {
    const server = makeServer();
    await storeMemory(server, 'The Ebbinghaus forgetting curve models memory decay');

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_recall',
      arguments: { keywords: ['Ebbinghaus', 'decay'], limit: 5 },
    });
    const result = resp['result'] as Record<string, unknown>;
    const text = (result['content'] as Array<{ text: string }>)[0].text;
    expect(text).toContain('Ebbinghaus');
  });

  it('engram_get retrieves memory by id', async () => {
    const server = makeServer();
    const id = await storeMemory(server, 'Specific memory for retrieval');

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_get',
      arguments: { id },
    });
    const result = resp['result'] as Record<string, unknown>;
    const text = (result['content'] as Array<{ text: string }>)[0].text;
    expect(text).toContain('Specific memory for retrieval');
  });

  it('engram_stats returns statistics', async () => {
    const server = makeServer();
    await storeMemory(server, 'test 1');
    await storeMemory(server, 'test 2');

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_stats',
      arguments: {},
    });
    const result = resp['result'] as Record<string, unknown>;
    const text = (result['content'] as Array<{ text: string }>)[0].text;
    const stats = JSON.parse(text);
    expect(stats.total).toBeGreaterThanOrEqual(2);
  });
});

// ── engram_link ───────────────────────────────────────────────────────────────

describe('EngramMCPStdioServer — engram_link', () => {
  it('links two existing memories', async () => {
    const server = makeServer();
    const id1 = await storeMemory(server, 'Caffeine improves focus');
    const id2 = await storeMemory(server, 'Focus is key to productivity');

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_link',
      arguments: { fromId: id1, toId: id2, relation: 'supports' },
    });
    const result = resp['result'] as Record<string, unknown>;
    expect((result as Record<string, boolean>)['isError']).toBeFalsy();
    const text = (result['content'] as Array<{ text: string }>)[0].text;
    const data = JSON.parse(text);
    expect(data.link.relation).toBe('supports');
    expect(data.from.id).toBe(id1);
    expect(data.to.id).toBe(id2);
  });

  it('returns error if source memory not found', async () => {
    const server = makeServer();
    const id2 = await storeMemory(server, 'Some memory');

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_link',
      arguments: { fromId: 'nonexistent-id', toId: id2, relation: 'extends' },
    });
    const result = resp['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });

  it('returns error if target memory not found', async () => {
    const server = makeServer();
    const id1 = await storeMemory(server, 'Some memory');

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_link',
      arguments: { fromId: id1, toId: 'nonexistent-id', relation: 'causes' },
    });
    const result = resp['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });

  it('supports custom relation types', async () => {
    const server = makeServer();
    const id1 = await storeMemory(server, 'Memory A');
    const id2 = await storeMemory(server, 'Memory B');

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_link',
      arguments: { fromId: id1, toId: id2, relation: 'my-custom-relation' },
    });
    const result = resp['result'] as Record<string, unknown>;
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.link.relation).toBe('my-custom-relation');
  });
});

// ── engram_related ────────────────────────────────────────────────────────────

describe('EngramMCPStdioServer — engram_related', () => {
  it('finds related memories after linking', async () => {
    const server = makeServer();
    const id1 = await storeMemory(server, 'Root memory');
    const id2 = await storeMemory(server, 'Child memory A');
    const id3 = await storeMemory(server, 'Child memory B');

    await rpc(server, 'tools/call', {
      name: 'engram_link',
      arguments: { fromId: id1, toId: id2, relation: 'extends' },
    });
    await rpc(server, 'tools/call', {
      name: 'engram_link',
      arguments: { fromId: id1, toId: id3, relation: 'causes' },
    });

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_related',
      arguments: { id: id1 },
    });
    const result = resp['result'] as Record<string, unknown>;
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.relatedCount).toBe(2);
  });

  it('returns empty related for unlinked memory', async () => {
    const server = makeServer();
    const id1 = await storeMemory(server, 'Isolated memory');

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_related',
      arguments: { id: id1 },
    });
    const result = resp['result'] as Record<string, unknown>;
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.relatedCount).toBe(0);
  });

  it('filters by direction=outgoing', async () => {
    const server = makeServer();
    const id1 = await storeMemory(server, 'Source');
    const id2 = await storeMemory(server, 'Target');
    await rpc(server, 'tools/call', {
      name: 'engram_link',
      arguments: { fromId: id1, toId: id2, relation: 'precedes' },
    });

    // id2 has incoming link from id1
    const resp = await rpc(server, 'tools/call', {
      name: 'engram_related',
      arguments: { id: id2, direction: 'outgoing' },
    });
    const result = resp['result'] as Record<string, unknown>;
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.relatedCount).toBe(0);

    const resp2 = await rpc(server, 'tools/call', {
      name: 'engram_related',
      arguments: { id: id2, direction: 'incoming' },
    });
    const result2 = resp2['result'] as Record<string, unknown>;
    const data2 = JSON.parse((result2['content'] as Array<{ text: string }>)[0].text);
    expect(data2.relatedCount).toBe(1);
  });

  it('returns error for nonexistent memory', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'tools/call', {
      name: 'engram_related',
      arguments: { id: 'does-not-exist' },
    });
    const result = resp['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });
});

// ── engram_timeline ───────────────────────────────────────────────────────────

describe('EngramMCPStdioServer — engram_timeline', () => {
  it('returns memories within time window', async () => {
    const server = makeServer();
    const before = Date.now() - 1;
    await storeMemory(server, 'Memory in window A');
    await storeMemory(server, 'Memory in window B');
    const after = Date.now() + 1;

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_timeline',
      arguments: { after: before, before: after },
    });
    const result = resp['result'] as Record<string, unknown>;
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.total).toBeGreaterThanOrEqual(2);
  });

  it('respects limit parameter', async () => {
    const server = makeServer();
    const t = Date.now() - 1;
    await storeMemory(server, 'M1');
    await storeMemory(server, 'M2');
    await storeMemory(server, 'M3');

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_timeline',
      arguments: { after: t, before: Date.now() + 1, limit: 2 },
    });
    const result = resp['result'] as Record<string, unknown>;
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.memories.length).toBeLessThanOrEqual(2);
  });

  it('filters by namespace', async () => {
    const server = makeServer();
    const t = Date.now() - 1;
    await storeMemory(server, 'In NS1', { namespace: 'ns1' });
    await storeMemory(server, 'In NS2', { namespace: 'ns2' });

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_timeline',
      arguments: { after: t, before: Date.now() + 1, namespace: 'ns1' },
    });
    const result = resp['result'] as Record<string, unknown>;
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.memories.every((m: { namespace: string }) => m.namespace === 'ns1')).toBe(true);
  });

  it('returns empty for past time window with no memories', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'tools/call', {
      name: 'engram_timeline',
      arguments: { after: 0, before: 1 },  // epoch ms 0–1 = no real memories
    });
    const result = resp['result'] as Record<string, unknown>;
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.total).toBe(0);
  });
});

// ── engram_namespaces ─────────────────────────────────────────────────────────

describe('EngramMCPStdioServer — engram_namespaces', () => {
  it('returns default namespace after storing a memory', async () => {
    const server = makeServer();
    await storeMemory(server, 'Default namespace memory');

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_namespaces',
      arguments: {},
    });
    const result = resp['result'] as Record<string, unknown>;
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    const names = data.namespaces.map((n: { name: string }) => n.name);
    expect(names).toContain('default');
  });

  it('lists multiple namespaces', async () => {
    const server = makeServer();
    await storeMemory(server, 'In alpha', { namespace: 'alpha' });
    await storeMemory(server, 'In beta', { namespace: 'beta' });
    await storeMemory(server, 'In alpha 2', { namespace: 'alpha' });

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_namespaces',
      arguments: {},
    });
    const result = resp['result'] as Record<string, unknown>;
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    const names = data.namespaces.map((n: { name: string }) => n.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');

    // alpha has 2 memories, should come first (sorted by count desc)
    const alpha = data.namespaces.find((n: { name: string; count: number }) => n.name === 'alpha');
    expect(alpha?.count).toBe(2);
  });
});

// ── engram_forget ──────────────────────────────────────────────────────────────

describe('EngramMCPStdioServer — engram_forget', () => {
  it('deletes an existing memory', async () => {
    const server = makeServer();
    const id = await storeMemory(server, 'Memory to be forgotten');

    const resp = await rpc(server, 'tools/call', {
      name: 'engram_forget',
      arguments: { id, reason: 'test deletion' },
    });
    const result = resp['result'] as Record<string, unknown>;
    expect(result['isError']).toBeFalsy();
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.deleted).toBe(id);
    expect(data.reason).toBe('test deletion');
  });

  it('memory is gone after forget', async () => {
    const server = makeServer();
    const id = await storeMemory(server, 'Transient memory');

    await rpc(server, 'tools/call', {
      name: 'engram_forget',
      arguments: { id },
    });

    const getResp = await rpc(server, 'tools/call', {
      name: 'engram_get',
      arguments: { id },
    });
    const result = getResp['result'] as Record<string, unknown>;
    const text = (result['content'] as Array<{ text: string }>)[0].text;
    expect(text).toContain('not found');
    expect(result['isError']).toBe(true);
  });

  it('also removes associated links', async () => {
    const server = makeServer();
    const id1 = await storeMemory(server, 'Memory with links');
    const id2 = await storeMemory(server, 'Linked memory');
    await rpc(server, 'tools/call', {
      name: 'engram_link',
      arguments: { fromId: id1, toId: id2, relation: 'extends' },
    });

    await rpc(server, 'tools/call', {
      name: 'engram_forget',
      arguments: { id: id1 },
    });

    // Verify link is cleaned up — id2 should have 0 related
    const resp = await rpc(server, 'tools/call', {
      name: 'engram_related',
      arguments: { id: id2 },
    });
    const result = resp['result'] as Record<string, unknown>;
    const data = JSON.parse((result['content'] as Array<{ text: string }>)[0].text);
    expect(data.relatedCount).toBe(0);
  });

  it('returns error when memory does not exist', async () => {
    const server = makeServer();
    const resp = await rpc(server, 'tools/call', {
      name: 'engram_forget',
      arguments: { id: 'ghost-memory-id' },
    });
    const result = resp['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });
});

// ── Combined workflow ─────────────────────────────────────────────────────────

describe('EngramMCPStdioServer — combined workflow', () => {
  it('store → link → timeline → related → forget', async () => {
    const server = makeServer();
    const t0 = Date.now() - 1;

    const idA = await storeMemory(server, 'Concept A: attention mechanisms', {
      type: 'semantic',
      importance: 'high',
      tags: ['transformer', 'attention'],
    });
    const idB = await storeMemory(server, 'Concept B: self-attention extends attention', {
      type: 'semantic',
    });

    // Link
    await rpc(server, 'tools/call', {
      name: 'engram_link',
      arguments: { fromId: idA, toId: idB, relation: 'extends' },
    });

    // Timeline
    const timelineResp = await rpc(server, 'tools/call', {
      name: 'engram_timeline',
      arguments: { after: t0, before: Date.now() + 1 },
    });
    const tlData = JSON.parse(
      ((timelineResp['result'] as Record<string, unknown>)['content'] as Array<{ text: string }>)[0].text,
    );
    expect(tlData.total).toBeGreaterThanOrEqual(2);

    // Related
    const relResp = await rpc(server, 'tools/call', {
      name: 'engram_related',
      arguments: { id: idA },
    });
    const relData = JSON.parse(
      ((relResp['result'] as Record<string, unknown>)['content'] as Array<{ text: string }>)[0].text,
    );
    expect(relData.relatedCount).toBe(1);
    expect(relData.related[0].relation).toBe('extends');

    // Forget A
    await rpc(server, 'tools/call', {
      name: 'engram_forget',
      arguments: { id: idA },
    });

    // B should have no links now
    const relResp2 = await rpc(server, 'tools/call', {
      name: 'engram_related',
      arguments: { id: idB },
    });
    const relData2 = JSON.parse(
      ((relResp2['result'] as Record<string, unknown>)['content'] as Array<{ text: string }>)[0].text,
    );
    expect(relData2.relatedCount).toBe(0);
  });
});
