import { describe, it, expect } from 'vitest';
import { VersionManager } from '../src/version-manager';
import { InMemoryStore } from '../src/storage/in-memory';
import { TypedEmitter } from '../src/types';
import { createEngram } from '../src/engram';

describe('VersionManager', () => {
  const makeSetup = () => {
    const store = new InMemoryStore();
    const emitter = new TypedEmitter();
    const vm = new VersionManager(store, emitter);
    return { store, emitter, vm };
  };

  const makeEngram = (content = 'original content') =>
    createEngram({
      content,
      type: 'semantic',
      source: 'agent-1',
    });

  describe('recordCreation', () => {
    it('should record initial version', () => {
      const { vm } = makeSetup();
      const engram = makeEngram();
      vm.recordCreation(engram);

      const history = vm.getHistory(engram.id);
      expect(history.length).toBe(1);
      expect(history[0].version).toBe(1);
      expect(history[0].changeType).toBe('created');
      expect(history[0].content).toBe('original content');
    });
  });

  describe('update', () => {
    it('should create a new version with updated content', async () => {
      const { store, vm } = makeSetup();
      const engram = makeEngram();
      await store.put(engram);
      vm.recordCreation(engram);

      const updated = await vm.update(engram.id, 'updated content', 'agent-1');
      expect(updated.content).toBe('updated content');
      expect(updated.version).toBe(2);

      const history = vm.getHistory(engram.id);
      expect(history.length).toBe(2);
      expect(history[1].changeType).toBe('updated');
    });

    it('should throw for non-existent memory', async () => {
      const { vm } = makeSetup();
      await expect(vm.update('fake-id', 'content', 'agent-1'))
        .rejects.toThrow('not found');
    });
  });

  describe('supersede', () => {
    it('should mark old memory as superseded and link to new', async () => {
      const { store, emitter, vm } = makeSetup();
      const old = makeEngram('old fact');
      await store.put(old);
      vm.recordCreation(old);

      const replacement = makeEngram('corrected fact');

      let supersedEvent = false;
      emitter.on('memory:superseded', () => { supersedEvent = true; });

      const result = await vm.supersede(old.id, replacement, 'agent-1');

      expect(result.old.status).toBe('superseded');
      expect(result.old.supersededBy).toBe(replacement.id);
      expect(result.new.previousVersionId).toBe(old.id);
      expect(supersedEvent).toBe(true);
    });

    it('should throw for non-existent source', async () => {
      const { vm } = makeSetup();
      const newEngram = makeEngram('new');
      await expect(vm.supersede('fake-id', newEngram, 'agent-1'))
        .rejects.toThrow('not found');
    });
  });

  describe('restore', () => {
    it('should restore content from a previous version', async () => {
      const { store, vm } = makeSetup();
      const engram = makeEngram('version 1');
      await store.put(engram);
      vm.recordCreation(engram);

      await vm.update(engram.id, 'version 2', 'agent-1');
      await vm.update(engram.id, 'version 3', 'agent-1');

      const restored = await vm.restore(engram.id, 1, 'agent-1');
      expect(restored.content).toBe('version 1');
      expect(restored.version).toBe(4);
      expect(restored.status).toBe('active');

      const history = vm.getHistory(engram.id);
      expect(history.length).toBe(4);
      expect(history[3].changeType).toBe('restored');
    });

    it('should throw for non-existent version', async () => {
      const { store, vm } = makeSetup();
      const engram = makeEngram();
      await store.put(engram);
      vm.recordCreation(engram);

      await expect(vm.restore(engram.id, 99, 'agent-1'))
        .rejects.toThrow('Version 99 not found');
    });
  });

  describe('resolveLatest', () => {
    it('should follow supersession chain', async () => {
      const { store, vm } = makeSetup();

      const v1 = makeEngram('fact v1');
      await store.put(v1);
      vm.recordCreation(v1);

      const v2 = makeEngram('fact v2');
      await vm.supersede(v1.id, v2, 'agent-1');

      const v3 = makeEngram('fact v3');
      await vm.supersede(v2.id, v3, 'agent-1');

      const latest = await vm.resolveLatest(v1.id);
      expect(latest).not.toBeNull();
      expect(latest!.content).toBe('fact v3');
    });

    it('should return self if not superseded', async () => {
      const { store, vm } = makeSetup();
      const engram = makeEngram('current');
      await store.put(engram);

      const latest = await vm.resolveLatest(engram.id);
      expect(latest!.id).toBe(engram.id);
    });
  });

  describe('getVersion', () => {
    it('should return specific version record', () => {
      const { vm } = makeSetup();
      const engram = makeEngram();
      vm.recordCreation(engram);

      const record = vm.getVersion(engram.id, 1);
      expect(record).not.toBeNull();
      expect(record!.version).toBe(1);
    });

    it('should return null for non-existent version', () => {
      const { vm } = makeSetup();
      expect(vm.getVersion('fake', 1)).toBeNull();
    });
  });

  describe('getLatestVersion', () => {
    it('should return highest version number', async () => {
      const { store, vm } = makeSetup();
      const engram = makeEngram();
      await store.put(engram);
      vm.recordCreation(engram);
      await vm.update(engram.id, 'v2', 'agent-1');
      await vm.update(engram.id, 'v3', 'agent-1');

      expect(vm.getLatestVersion(engram.id)).toBe(3);
    });

    it('should return 0 for unknown engram', () => {
      const { vm } = makeSetup();
      expect(vm.getLatestVersion('unknown')).toBe(0);
    });
  });

  describe('version events', () => {
    it('should emit memory:version-created on each change', async () => {
      const { store, emitter, vm } = makeSetup();
      const events: any[] = [];
      emitter.on('memory:version-created', (record) => { events.push(record); });

      const engram = makeEngram();
      await store.put(engram);
      vm.recordCreation(engram);
      await vm.update(engram.id, 'v2', 'agent-1');

      expect(events.length).toBe(2);
      expect(events[0].changeType).toBe('created');
      expect(events[1].changeType).toBe('updated');
    });
  });
});
