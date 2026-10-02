import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryManager } from '../src/memory-manager';
import { FileStore } from '../src/storage/file-store';
import { ThreeLayerExtension } from '../src/three-layer-interface';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Unwrap a three-layer toolResult: { content: [{ type: 'text', text }] } */
const unwrap = (r: any) => JSON.parse(r.content[0].text);

describe('bi-temporal facts (v0.10)', () => {
  describe('MemoryManager.updateFact', () => {
    it('closes the old version and opens a new one sharing the factId', async () => {
      const mm = new MemoryManager();
      const closedEvents: any[] = [];
      mm.emitter.on('memory:fact-closed', (e) => { closedEvents.push(e); });

      const t0 = Date.now();
      const original = await mm.encode({
        content: 'User lives in Shanghai',
        type: 'semantic',
        importance: 'high',
        source: 'agent-1',
      });
      await tick();

      const updated = await mm.updateFact(original.id, 'User lives in Beijing', 'agent-1');
      const t1 = Date.now();

      // New version: same factId (lazily minted from the original id), fresh window
      expect(updated.factId).toBe(original.id);
      expect(updated.content).toBe('User lives in Beijing');
      expect(updated.validFrom).toBeGreaterThanOrEqual(t0);
      expect(updated.validFrom).toBeLessThanOrEqual(t1);
      expect(updated.validUntil).toBeUndefined();

      // Old version: closed (validUntil set), status untouched for back-compat
      const old = await mm.store.get(original.id);
      expect(old).not.toBeNull();
      expect(old!.validUntil).toBeGreaterThanOrEqual(t0);
      expect(old!.status).toBe('active');

      expect(closedEvents).toHaveLength(1);
      expect(closedEvents[0].id).toBe(original.id);
      mm.stop();
    });

    it('keeps the factId stable across successive updates', async () => {
      const mm = new MemoryManager();
      const v1 = await mm.encode({
        content: 'Deploy target is v1',
        type: 'semantic',
        source: 'agent-1',
      });
      await tick();

      const v2 = await mm.updateFact(v1.id, 'Deploy target is v2', 'agent-1');
      await tick();
      const v3 = await mm.updateFact(v2.factId!, 'Deploy target is v3', 'agent-1');

      expect(v2.factId).toBe(v1.id);
      expect(v3.factId).toBe(v1.id);

      // All three versions remain queryable by factId
      const lineage = await mm.store.query({ factId: v1.id });
      expect(lineage).toHaveLength(3);
      mm.stop();
    });

    it('throws for unknown fact ids', async () => {
      const mm = new MemoryManager();
      await expect(
        mm.updateFact('no-such-fact', 'irrelevant', 'agent-1'),
      ).rejects.toThrow('not found');
      mm.stop();
    });
  });

  describe('time-travel recall', () => {
    const setupFact = async () => {
      const mm = new MemoryManager();
      const t0 = Date.now();
      const original = await mm.encode({
        content: 'The API base URL is api.example.com/v1',
        type: 'semantic',
        importance: 'high',
        source: 'agent-1',
      });
      await tick();
      await mm.updateFact(original.id, 'The API base URL is api.example.com/v2', 'agent-1');
      return { mm, original, t0 };
    };

    it('recalls only the current version by default', async () => {
      const { mm } = await setupFact();
      const results = await mm.query({ text: 'API base URL' });
      expect(results).toHaveLength(1);
      expect(results[0].engram.content).toContain('/v2');
      mm.stop();
    });

    it('recalls the version that was valid at validAt (time travel)', async () => {
      const { mm, original, t0 } = await setupFact();
      const results = await mm.query({ text: 'API base URL', validAt: t0 });
      expect(results).toHaveLength(1);
      expect(results[0].engram.id).toBe(original.id);
      expect(results[0].engram.content).toContain('/v1');
      mm.stop();
    });

    it('includeInvalidated exposes closed versions in the present', async () => {
      const { mm, original } = await setupFact();
      const results = await mm.query({ text: 'API base URL', includeInvalidated: true });
      const ids = results.map((r) => r.engram.id).sort();
      expect(ids).toHaveLength(2);
      expect(ids).toContain(original.id);
      mm.stop();
    });
  });

  describe('FileStore bi-temporal filtering', () => {
    it('honors validAt and factId filters on the filesystem store', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-bi-temporal-'));
      try {
        const store = new FileStore(dir);
        await store.init();
        const mm = new MemoryManager({}, store);
        const t0 = Date.now();

        const original = await mm.encode({
          content: 'Feature flag dark-mode is off',
          type: 'semantic',
          importance: 'high',
          source: 'agent-1',
        });
        await tick();
        await mm.updateFact(original.id, 'Feature flag dark-mode is on', 'agent-1');

        // Direct store-level time travel: only the version valid at t0
        const past = await store.query({ factId: original.id, validAt: t0 });
        expect(past).toHaveLength(1);
        expect(past[0].content).toContain('off');

        // factId query returns the full lineage (closed + current)
        const lineage = await store.query({ factId: original.id });
        expect(lineage).toHaveLength(2);

        // Present-time snapshot: only the new version
        const present = await store.query({ factId: original.id, validAt: Date.now() });
        expect(present).toHaveLength(1);
        expect(present[0].content).toContain('on');

        // Manager-level recall through FileStore honors validity too
        const recalled = await mm.query({ text: 'dark-mode' });
        expect(recalled).toHaveLength(1);
        expect(recalled[0].engram.content).toContain('on');
        mm.stop();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('three-layer interface', () => {
    it('factQuery asOf travels back to the previously asserted value', async () => {
      const mm = new MemoryManager();
      const tui = new ThreeLayerExtension(mm);

      await tui.factAssert({ subject: 'vitest', predicate: 'version', value: '2.1.9' });
      await tick();
      const tMid = Date.now();
      await tick();
      await tui.factAssert({ subject: 'vitest', predicate: 'version', value: '3.0.0' });

      // Present: only the newest value
      const now = unwrap(await tui.factQuery({ subject: 'vitest', predicate: 'version' }));
      expect(now.facts).toHaveLength(1);
      expect(now.facts[0].value).toBe('3.0.0');

      // Time travel: the superseded version was valid at tMid
      const past = unwrap(
        await tui.factQuery({ subject: 'vitest', predicate: 'version', asOf: tMid }),
      );
      expect(past.facts).toHaveLength(1);
      expect(past.facts[0].value).toBe('2.1.9');
      expect(past.facts[0].validUntil).not.toBeNull();
      mm.stop();
    });

    it('factRetract closes the validity window', async () => {
      const mm = new MemoryManager();
      const tui = new ThreeLayerExtension(mm);

      const asserted = unwrap(
        await tui.factAssert({ subject: 'node', predicate: 'lts', value: '20' }),
      );
      await tick();

      const retracted = unwrap(await tui.factRetract({ id: asserted.id, reason: 'outdated' }));
      expect(retracted.validUntil).toBeGreaterThan(0);

      // Retracted facts disappear from the default query…
      const now = unwrap(await tui.factQuery({ subject: 'node' }));
      expect(now.facts).toHaveLength(0);

      // …but remain visible in the past
      const past = unwrap(await tui.factQuery({ subject: 'node', asOf: Date.now() - 1000 }));
      expect(past.facts).toHaveLength(1);
      mm.stop();
    });
  });
});
