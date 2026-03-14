import { describe, it, expect } from 'vitest';
import { MemoryManager } from '../src/memory-manager';

describe('MemoryManager', () => {
  const makeManager = () => new MemoryManager();

  describe('encode', () => {
    it('should encode a new memory and emit event', async () => {
      const mm = makeManager();
      let encoded: any = null;
      mm.emitter.on('memory:encoded', (e) => { encoded = e; });

      const engram = await mm.encode({
        content: 'User prefers TypeScript',
        type: 'semantic',
        source: 'agent-1',
        tags: ['preferences'],
        importance: 'high',
      });

      expect(engram.content).toBe('User prefers TypeScript');
      expect(engram.type).toBe('semantic');
      expect(engram.strength).toBe(1.0);
      expect(engram.version).toBe(1);
      expect(encoded).not.toBeNull();
      mm.stop();
    });

    it('should use default namespace', async () => {
      const mm = makeManager();
      const engram = await mm.encode({
        content: 'test',
        type: 'episodic',
        source: 'agent-1',
      });
      expect(engram.namespace).toBe('default');
      mm.stop();
    });

    it('should enforce write permissions on shared spaces', async () => {
      const mm = makeManager();
      mm.createSpace({
        name: 'restricted',
        maxCapacity: 100,
        acl: { 'agent-1': ['read'] },
        shared: true,
        consolidationInterval: 0,
      });

      await expect(mm.encode({
        content: 'should fail',
        type: 'episodic',
        source: 'agent-1',
        namespace: 'restricted',
      })).rejects.toThrow('does not have');
      mm.stop();
    });

    it('should enforce capacity limits', async () => {
      const mm = makeManager();
      mm.createSpace({
        name: 'tiny',
        maxCapacity: 1,
        acl: { 'agent-1': ['read', 'write'] },
        shared: false,
        consolidationInterval: 0,
      });

      await mm.encode({
        content: 'first',
        type: 'episodic',
        source: 'agent-1',
        namespace: 'tiny',
      });

      await expect(mm.encode({
        content: 'second',
        type: 'episodic',
        source: 'agent-1',
        namespace: 'tiny',
      })).rejects.toThrow('at capacity');
      mm.stop();
    });
  });

  describe('query', () => {
    it('should query memories with multi-signal ranking', async () => {
      const mm = makeManager();

      await mm.encode({ content: 'Python is great', type: 'semantic', source: 'agent-1', tags: ['lang'] });
      await mm.encode({ content: 'TypeScript is typed', type: 'semantic', source: 'agent-1', tags: ['lang'] });
      await mm.encode({ content: 'Meeting at 3pm', type: 'episodic', source: 'agent-1', tags: ['meeting'] });

      const results = await mm.query({ text: 'TypeScript', limit: 2, reinforce: false });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].engram.content).toContain('TypeScript');
      mm.stop();
    });
  });

  describe('get', () => {
    it('should get memory by ID', async () => {
      const mm = makeManager();
      const stored = await mm.encode({
        content: 'findable',
        type: 'episodic',
        source: 'agent-1',
      });

      const found = await mm.get(stored.id);
      expect(found).not.toBeNull();
      expect(found!.content).toBe('findable');
      mm.stop();
    });

    it('should return null for unknown ID', async () => {
      const mm = makeManager();
      const found = await mm.get('nonexistent');
      expect(found).toBeNull();
      mm.stop();
    });

    it('should reinforce when requested', async () => {
      const mm = makeManager();
      const stored = await mm.encode({
        content: 'reinforce me',
        type: 'episodic',
        source: 'agent-1',
      });

      const reinforced = await mm.get(stored.id, true);
      expect(reinforced!.accessCount).toBe(1);
      expect(reinforced!.stability).toBeGreaterThan(stored.stability);
      mm.stop();
    });
  });

  describe('update & versioning', () => {
    it('should update content and create version', async () => {
      const mm = makeManager();
      const original = await mm.encode({
        content: 'original',
        type: 'semantic',
        source: 'agent-1',
      });

      const updated = await mm.update(original.id, 'modified', 'agent-1');
      expect(updated.content).toBe('modified');
      expect(updated.version).toBe(2);

      const history = mm.getVersionHistory(original.id);
      expect(history.length).toBe(2);
      mm.stop();
    });

    it('should enforce write permissions on update', async () => {
      const mm = makeManager();
      mm.createSpace({
        name: 'protected',
        maxCapacity: 0,
        acl: {
          'agent-1': ['read', 'write'],
          'agent-2': ['read'],
        },
        shared: true,
        consolidationInterval: 0,
      });

      const engram = await mm.encode({
        content: 'protected data',
        type: 'semantic',
        source: 'agent-1',
        namespace: 'protected',
      });

      await expect(mm.update(engram.id, 'hack', 'agent-2'))
        .rejects.toThrow('does not have');
      mm.stop();
    });
  });

  describe('supersede', () => {
    it('should supersede outdated memory', async () => {
      const mm = makeManager();
      const old = await mm.encode({
        content: 'Earth has 8 planets',
        type: 'semantic',
        source: 'agent-1',
        tags: ['astronomy'],
      });

      const result = await mm.supersede(old.id, {
        content: 'Our solar system has 8 planets',
        type: 'semantic',
        source: 'agent-1',
        tags: ['astronomy'],
      });

      expect(result.old.status).toBe('superseded');
      expect(result.old.supersededBy).toBe(result.new.id);
      expect(result.new.content).toContain('8 planets');
      mm.stop();
    });

    it('should resolve to latest through supersession chain', async () => {
      const mm = makeManager();
      const v1 = await mm.encode({
        content: 'fact v1',
        type: 'semantic',
        source: 'agent-1',
      });

      const { new: v2 } = await mm.supersede(v1.id, {
        content: 'fact v2',
        type: 'semantic',
        source: 'agent-1',
      });

      await mm.supersede(v2.id, {
        content: 'fact v3',
        type: 'semantic',
        source: 'agent-1',
      });

      const latest = await mm.resolveLatest(v1.id);
      expect(latest!.content).toBe('fact v3');
      mm.stop();
    });
  });

  describe('restore', () => {
    it('should restore memory to previous version', async () => {
      const mm = makeManager();
      const original = await mm.encode({
        content: 'correct info',
        type: 'semantic',
        source: 'agent-1',
      });

      await mm.update(original.id, 'wrong info', 'agent-1');
      const restored = await mm.restore(original.id, 1, 'agent-1');

      expect(restored.content).toBe('correct info');
      expect(restored.version).toBe(3);
      mm.stop();
    });
  });

  describe('consolidation', () => {
    it('should compress weak related memories', async () => {
      const mm = makeManager();

      // Create several weak memories
      for (let i = 0; i < 4; i++) {
        const engram = await mm.encode({
          content: `Daily standup note ${i}`,
          type: 'episodic',
          source: 'agent-1',
          tags: ['standup'],
        });
        // Manually weaken them
        const weakened = { ...engram, strength: 0.2 };
        await mm.store.put(weakened);
      }

      const results = await mm.consolidate({ minGroupSize: 3 });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].compressed.type).toBe('semantic');
      expect(results[0].sourceIds.length).toBe(4);
      mm.stop();
    });
  });

  describe('decay sweep', () => {
    it('should transition aged memories', async () => {
      const mm = new MemoryManager({
        decay: { baseHalfLife: 10 },
      });

      const engram = await mm.encode({
        content: 'will decay',
        type: 'episodic',
        source: 'agent-1',
        importance: 'trivial',
      });

      const result = await mm.runDecaySweep(engram.createdAt + 1_000_000);
      expect(
        result.decayed.length + result.archived.length + result.forgotten.length,
      ).toBeGreaterThan(0);
      mm.stop();
    });

    it('should predict decay time', async () => {
      const mm = makeManager();
      const engram = await mm.encode({
        content: 'test',
        type: 'episodic',
        source: 'agent-1',
      });

      const time = mm.predictDecayTime(engram);
      expect(time).toBeGreaterThan(0);
      mm.stop();
    });
  });

  describe('memory spaces', () => {
    it('should create and manage shared spaces', () => {
      const mm = makeManager();
      const space = mm.createSpace({
        name: 'team-knowledge',
        maxCapacity: 1000,
        acl: {
          'agent-1': ['read', 'write', 'admin'],
          'agent-2': ['read', 'write'],
          'agent-3': ['read'],
        },
        shared: true,
        consolidationInterval: 0,
      });

      expect(space.name).toBe('team-knowledge');
      expect(space.isShared()).toBe(true);
      expect(space.hasPermission('agent-1', 'admin')).toBe(true);
      expect(space.hasPermission('agent-3', 'write')).toBe(false);

      const spaces = mm.listAgentSpaces('agent-2');
      expect(spaces.length).toBe(1);
      mm.stop();
    });
  });

  describe('stats', () => {
    it('should return memory statistics', async () => {
      const mm = makeManager();
      await mm.encode({ content: 'a', type: 'episodic', source: 'agent-1' });
      await mm.encode({ content: 'b', type: 'semantic', source: 'agent-1' });

      const stats = await mm.stats();
      expect(stats.total).toBe(2);
      expect(stats.active).toBe(2);
      expect(stats.decayed).toBe(0);
      mm.stop();
    });
  });

  describe('lifecycle', () => {
    it('should start and stop sweep timer', () => {
      const mm = makeManager();
      mm.start();
      // Should not throw on double start
      mm.start();
      mm.stop();
      // Should not throw on double stop
      mm.stop();
    });
  });

  describe('cross-agent scenario', () => {
    it('should support multi-agent read/write with conflict detection', async () => {
      const mm = makeManager();
      let conflictDetected = false;
      mm.emitter.on('memory:conflict', () => { conflictDetected = true; });

      mm.createSpace({
        name: 'shared-kb',
        maxCapacity: 0,
        acl: {
          'researcher': ['read', 'write'],
          'analyst': ['read', 'write'],
          'viewer': ['read'],
        },
        shared: true,
        consolidationInterval: 0,
      });

      // Researcher writes
      const fact = await mm.encode({
        content: 'Market is trending up',
        type: 'semantic',
        source: 'researcher',
        namespace: 'shared-kb',
        tags: ['market'],
      });

      // Analyst updates the same memory
      await mm.update(fact.id, 'Market is trending up with high volume', 'analyst');

      // Conflict should be detected
      expect(conflictDetected).toBe(true);

      // Viewer can read but not write
      const found = await mm.get(fact.id);
      expect(found).not.toBeNull();

      await expect(mm.update(fact.id, 'hack', 'viewer'))
        .rejects.toThrow('does not have');

      mm.stop();
    });
  });
});
