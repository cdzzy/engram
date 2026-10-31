import { describe, it, expect } from 'vitest';
import { MemoryManager } from '../src/memory-manager';
import type { Engram } from '../src/types';

/** Create a manager plus a shared space owned by "owner". */
function setup(spaceName = 'team') {
  const manager = new MemoryManager();
  manager.createSharedSpace(spaceName, 'owner');
  return manager;
}

async function seed(
  manager: MemoryManager,
  namespace: string,
  source: string,
  content: string,
): Promise<Engram> {
  return await manager.encode({ content, type: 'episodic', source, namespace });
}

describe('Multi-agent shared memory — read isolation', () => {
  it('filters query results to namespaces the agent may read', async () => {
    const manager = setup();
    const a = await seed(manager, 'team', 'owner', 'team decision alpha');
    const b = await seed(manager, 'default', 'stranger', 'private note beta');

    // owner has read on 'team' + the always-open 'default'
    const ownerResults = await manager.query({ agentId: 'owner' });
    expect(ownerResults.map((r) => r.engram.id).sort()).toEqual([a.id, b.id].sort());

    // A stranger granted read on 'team' can see both, but has no special
    // visibility into other agents' spaces.
    manager.grantAccess('team', 'teammate', ['read']);
    const teammateResults = await manager.query({ agentId: 'teammate' });
    expect(teammateResults.map((r) => r.engram.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('returns nothing for a namespace the agent cannot read', async () => {
    const manager = setup();
    await seed(manager, 'team', 'owner', 'secret team plan');

    const results = await manager.query({ namespace: 'team', agentId: 'outsider' });
    expect(results).toEqual([]);
  });

  it('still returns results when no agentId is supplied (backward compatible)', async () => {
    const manager = setup();
    const memory = await seed(manager, 'team', 'owner', 'shared fact');

    const results = await manager.query({ namespace: 'team' });
    expect(results.map((r) => r.engram.id)).toContain(memory.id);
  });

  it('get returns null for an unreadable namespace', async () => {
    const manager = setup();
    const memory = await seed(manager, 'team', 'owner', 'confidential');

    expect(await manager.get(memory.id, false, 'outsider')).toBeNull();
    expect((await manager.get(memory.id, false, 'owner'))?.id).toBe(memory.id);
    // Unscoped read keeps working
    expect((await manager.get(memory.id))?.id).toBe(memory.id);
  });

  it('getAs mirrors get with an agent scope', async () => {
    const manager = setup();
    const memory = await seed(manager, 'team', 'owner', 'fact');

    expect(await manager.getAs('outsider', memory.id)).toBeNull();
    expect((await manager.getAs('owner', memory.id))?.id).toBe(memory.id);
  });

  it('queryAs mirrors query with an agent scope', async () => {
    const manager = setup();
    await seed(manager, 'team', 'owner', 'shared');

    expect((await manager.queryAs('owner')).length).toBeGreaterThan(0);
    expect(await manager.queryAs('outsider', { namespace: 'team' })).toEqual([]);
  });

  it('keeps default-namespace memory readable by every agent', async () => {
    const manager = setup();
    const memory = await seed(manager, 'default', 'anyone', 'global fact');

    expect(await manager.query({ agentId: 'outsider' })).toHaveLength(1);
    expect((await manager.get(memory.id, false, 'outsider'))?.id).toBe(memory.id);
  });
});

describe('Multi-agent shared memory — ACL management', () => {
  it('createSharedSpace grants the owner admin', () => {
    const manager = new MemoryManager();
    const space = manager.createSharedSpace('team', 'owner');

    expect(space.isShared()).toBe(true);
    expect(manager.canAccess('team', 'owner')).toBe(true);
    expect(manager.getAccessList('team')).toEqual({ owner: ['admin'] });
  });

  it('grantAccess adds permissions and emits an event', () => {
    const manager = setup();
    const events: Array<[string, string, string[]]> = [];
    manager.emitter.on(
      'space:access-granted',
      (name: string, agentId: string, perms: string[]) => events.push([name, agentId, perms]),
    );

    manager.grantAccess('team', 'writer', ['read', 'write']);

    expect(manager.canAccess('team', 'writer', 'write')).toBe(true);
    expect(events).toEqual([['team', 'writer', ['read', 'write']]]);
  });

  it('grantAccess is additive, not replacing existing permissions', () => {
    const manager = setup();
    manager.grantAccess('team', 'writer', ['read']);
    manager.grantAccess('team', 'writer', ['write']);

    expect(manager.canAccess('team', 'writer', 'read')).toBe(true);
    expect(manager.canAccess('team', 'writer', 'write')).toBe(true);
  });

  it('revokeAccess removes every permission and emits an event', () => {
    const manager = setup();
    const revoked: Array<[string, string]> = [];
    manager.emitter.on('space:access-revoked', (name: string, agentId: string) =>
      revoked.push([name, agentId]),
    );

    manager.grantAccess('team', 'temp', ['read', 'write']);
    manager.revokeAccess('team', 'temp');

    expect(manager.canAccess('team', 'temp')).toBe(false);
    expect(manager.getSpaceAgents('team')).toEqual(['owner']);
    expect(revoked).toEqual([['team', 'temp']]);
  });

  it('getReadableNamespaces lists default plus granted spaces', () => {
    const manager = new MemoryManager();
    manager.createSharedSpace('team', 'owner');
    manager.createSharedSpace('project', 'owner');
    manager.grantAccess('team', 'agent', ['read']);

    expect(manager.getReadableNamespaces('agent').sort()).toEqual(['default', 'team']);
    expect(manager.getReadableNamespaces('owner').sort()).toEqual([
      'default',
      'project',
      'team',
    ]);
  });

  it('listSharedSpaces only returns shared spaces', () => {
    const manager = new MemoryManager();
    manager.createSpace({
      name: 'private',
      maxCapacity: 0,
      acl: { owner: ['admin'] },
      shared: false,
      consolidationInterval: 0,
    });
    manager.createSharedSpace('team', 'owner');

    expect(manager.listSharedSpaces().map((s) => s.name)).toEqual(['team']);
  });

  it('throws on ACL operations against an unknown space', () => {
    const manager = new MemoryManager();
    expect(() => manager.grantAccess('nope', 'agent', ['read'])).toThrow(
      "Memory space 'nope' does not exist",
    );
    expect(() => manager.getAccessList('nope')).toThrow();
  });

  it('write permission from encode is enforced through the same ACL', async () => {
    const manager = setup();
    await expect(
      seed(manager, 'team', 'outsider', 'unauthorised write'),
    ).rejects.toThrow("does not have 'write' permission");

    const owner = await seed(manager, 'team', 'owner', 'authorised write');
    expect(owner.namespace).toBe('team');
  });
});
