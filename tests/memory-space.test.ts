import { describe, it, expect } from 'vitest';
import { MemorySpace, MemorySpaceManager } from '../src/memory-space';
import { InMemoryStore } from '../src/storage/in-memory';
import { TypedEmitter } from '../src/types';
import { createEngram } from '../src/engram';

describe('MemorySpace', () => {
  const makeConfig = (overrides = {}) => ({
    name: 'test-space',
    maxCapacity: 100,
    acl: {
      'agent-1': ['read' as const, 'write' as const],
      'agent-2': ['read' as const],
      'admin-agent': ['admin' as const],
    },
    shared: true,
    consolidationInterval: 0,
    ...overrides,
  });

  describe('permissions', () => {
    it('should check read permission', () => {
      const space = new MemorySpace(makeConfig());
      expect(space.hasPermission('agent-1', 'read')).toBe(true);
      expect(space.hasPermission('agent-2', 'read')).toBe(true);
      expect(space.hasPermission('unknown', 'read')).toBe(false);
    });

    it('should check write permission', () => {
      const space = new MemorySpace(makeConfig());
      expect(space.hasPermission('agent-1', 'write')).toBe(true);
      expect(space.hasPermission('agent-2', 'write')).toBe(false);
    });

    it('should grant admin full access', () => {
      const space = new MemorySpace(makeConfig());
      expect(space.hasPermission('admin-agent', 'read')).toBe(true);
      expect(space.hasPermission('admin-agent', 'write')).toBe(true);
      expect(space.hasPermission('admin-agent', 'admin')).toBe(true);
    });

    it('should grant access to new agents', () => {
      const space = new MemorySpace(makeConfig());
      expect(space.hasPermission('new-agent', 'read')).toBe(false);
      space.grantAccess('new-agent', ['read', 'write']);
      expect(space.hasPermission('new-agent', 'read')).toBe(true);
      expect(space.hasPermission('new-agent', 'write')).toBe(true);
    });

    it('should revoke access', () => {
      const space = new MemorySpace(makeConfig());
      expect(space.hasPermission('agent-1', 'read')).toBe(true);
      space.revokeAccess('agent-1');
      expect(space.hasPermission('agent-1', 'read')).toBe(false);
    });
  });

  describe('metadata', () => {
    it('should report shared status', () => {
      const space = new MemorySpace(makeConfig({ shared: true }));
      expect(space.isShared()).toBe(true);
    });

    it('should list agent IDs', () => {
      const space = new MemorySpace(makeConfig());
      const agents = space.getAgentIds();
      expect(agents).toContain('agent-1');
      expect(agents).toContain('agent-2');
      expect(agents).toContain('admin-agent');
    });
  });
});

describe('MemorySpaceManager', () => {
  const makeManager = () => {
    const store = new InMemoryStore();
    const emitter = new TypedEmitter();
    const manager = new MemorySpaceManager(store, emitter);
    return { store, emitter, manager };
  };

  it('should create and retrieve spaces', () => {
    const { manager } = makeManager();
    manager.createSpace({
      name: 'shared',
      maxCapacity: 50,
      acl: { 'agent-1': ['read', 'write'] },
      shared: true,
      consolidationInterval: 0,
    });

    const space = manager.getSpace('shared');
    expect(space).not.toBeNull();
    expect(space!.name).toBe('shared');
  });

  it('should reject duplicate space names', () => {
    const { manager } = makeManager();
    const config = {
      name: 'dup',
      maxCapacity: 0,
      acl: {},
      shared: false,
      consolidationInterval: 0,
    };
    manager.createSpace(config);
    expect(() => manager.createSpace(config)).toThrow('already exists');
  });

  it('should enforce permissions', () => {
    const { manager } = makeManager();
    manager.createSpace({
      name: 'restricted',
      maxCapacity: 0,
      acl: { 'agent-1': ['read'] },
      shared: true,
      consolidationInterval: 0,
    });

    expect(() => manager.assertPermission('restricted', 'agent-1', 'read'))
      .not.toThrow();
    expect(() => manager.assertPermission('restricted', 'agent-1', 'write'))
      .toThrow('does not have');
    expect(() => manager.assertPermission('restricted', 'unknown', 'read'))
      .toThrow('does not have');
  });

  it('should allow default namespace without space', () => {
    const { manager } = makeManager();
    expect(() => manager.assertPermission('default', 'anyone', 'write'))
      .not.toThrow();
  });

  it('should detect write conflicts', () => {
    const { manager, emitter } = makeManager();
    let conflictDetected = false;
    emitter.on('memory:conflict', () => { conflictDetected = true; });

    manager.trackWrite('engram-1', 'agent-A');
    manager.trackWrite('engram-1', 'agent-B');

    expect(conflictDetected).toBe(true);
  });

  it('should check capacity', async () => {
    const { manager, store } = makeManager();
    manager.createSpace({
      name: 'small',
      maxCapacity: 2,
      acl: { 'agent-1': ['write'] },
      shared: false,
      consolidationInterval: 0,
    });

    // Add 2 memories
    for (let i = 0; i < 2; i++) {
      const e = createEngram({
        content: `mem-${i}`,
        type: 'episodic',
        source: 'agent-1',
        namespace: 'small',
      });
      await store.put(e);
    }

    const hasRoom = await manager.checkCapacity('small');
    expect(hasRoom).toBe(false);
  });

  it('should list agent spaces', () => {
    const { manager } = makeManager();
    manager.createSpace({
      name: 'space-a',
      maxCapacity: 0,
      acl: { 'agent-1': ['read'] },
      shared: true,
      consolidationInterval: 0,
    });
    manager.createSpace({
      name: 'space-b',
      maxCapacity: 0,
      acl: { 'agent-2': ['read'] },
      shared: true,
      consolidationInterval: 0,
    });

    const agent1Spaces = manager.listAgentSpaces('agent-1');
    expect(agent1Spaces.length).toBe(1);
    expect(agent1Spaces[0].name).toBe('space-a');
  });

  it('should emit space:created event', () => {
    const { manager, emitter } = makeManager();
    let createdName: string | null = null;
    emitter.on('space:created', (name) => { createdName = name; });

    manager.createSpace({
      name: 'new-space',
      maxCapacity: 0,
      acl: {},
      shared: false,
      consolidationInterval: 0,
    });

    expect(createdName).toBe('new-space');
  });
});

