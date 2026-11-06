import { describe, it, expect } from 'vitest';
import { MemoryManager } from '../src/memory-manager';
import { InMemoryStore } from '../src/storage/in-memory';
import {
  MemorySigner,
  canonicalMemoryPayload,
  memoryDigest,
  SIGNED_ENGRAM_FIELDS,
} from '../src/verifiable-memory';
import type { Engram, MemorySignature } from '../src/types';

function hmacSigner(secret = 'test-secret') {
  return new MemorySigner({ algorithm: 'hmac-sha256', hmacSecret: secret });
}

async function seed(manager: MemoryManager, content: string, namespace = 'default') {
  return await manager.encode({
    content,
    type: 'semantic',
    source: 'agent-a',
    namespace,
  });
}

describe('MemorySigner — construction', () => {
  it('requires an hmac secret for hmac-sha256', () => {
    expect(() => new MemorySigner({ algorithm: 'hmac-sha256' })).toThrow(/hmacSecret/);
  });

  it('requires a key for ed25519', () => {
    expect(() => new MemorySigner({ algorithm: 'ed25519' })).toThrow(/privateKeyPem/);
  });

  it('defaults to hmac-sha256', () => {
    expect(() => new MemorySigner({ hmacSecret: 's' })).not.toThrow();
  });

  it('generates a usable ed25519 key pair', () => {
    const keys = MemorySigner.generateEd25519KeyPair();
    expect(keys.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(keys.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('derives the public key from a private key', () => {
    const keys = MemorySigner.generateEd25519KeyPair();
    expect(MemorySigner.derivePublicKey(keys.privateKeyPem)).toBe(keys.publicKeyPem);
  });
});

describe('MemorySigner — canonical payload', () => {
  function makeEngram(overrides: Partial<Engram> = {}): Engram {
    return {
      id: 'm1',
      content: 'hello',
      type: 'semantic',
      importance: 'medium',
      status: 'active',
      strength: 1,
      stability: 1,
      lastAccessedAt: 0,
      accessCount: 0,
      createdAt: 1000,
      tags: [],
      source: 'agent-a',
      namespace: 'default',
      metadata: {},
      version: 1,
      previousVersionId: null,
      supersededBy: null,
      compressedFrom: [],
      embedding: null,
      ...overrides,
    };
  }

  it('binds the immutable identity fields', () => {
    const payload = JSON.parse(canonicalMemoryPayload(makeEngram(), null));
    for (const field of SIGNED_ENGRAM_FIELDS) {
      expect(payload).toHaveProperty(field);
    }
  });

  it('excludes mutable runtime state', () => {
    const payload = JSON.parse(canonicalMemoryPayload(makeEngram(), null));
    // These change on recall/decay/soft-delete; signing them would make every
    // stored record fail verification after its first read.
    for (const field of ['strength', 'stability', 'accessCount', 'lastAccessedAt', 'status', 'metadata', 'version']) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it('changes when content changes', () => {
    const a = memoryDigest(makeEngram(), null);
    const b = memoryDigest(makeEngram({ content: 'tampered' }), null);
    expect(a).not.toBe(b);
  });

  it('changes when the chain predecessor changes', () => {
    const a = memoryDigest(makeEngram(), null);
    const b = memoryDigest(makeEngram(), 'deadbeef');
    expect(a).not.toBe(b);
  });

  it('is stable across key insertion order', () => {
    const base = makeEngram();
    const reordered = { ...base };
    expect(memoryDigest(base, null)).toBe(memoryDigest(reordered, null));
  });

  it('ignores mutable state changes', () => {
    const a = makeEngram({ strength: 0.2, accessCount: 5, status: 'decayed' });
    const b = makeEngram({ strength: 1, accessCount: 0, status: 'active' });
    expect(memoryDigest(a, null)).toBe(memoryDigest(b, null));
  });
});

describe('MemorySigner — sign and verify', () => {
  function makeEngram(): Engram {
    return {
      id: 'm1', content: 'secret fact', type: 'semantic', importance: 'high',
      status: 'active', strength: 1, stability: 1, lastAccessedAt: 0,
      accessCount: 0, createdAt: 1000, tags: ['x'], source: 'agent-a',
      namespace: 'default', metadata: {}, version: 1, previousVersionId: null,
      supersededBy: null, compressedFrom: [], embedding: null,
    };
  }

  it('round-trips with hmac-sha256', () => {
    const signer = hmacSigner();
    const engram = makeEngram();
    const signature = signer.sign(engram);
    expect(signer.verify(engram, signature)).toBe(true);
  });

  it('rejects content tampering', () => {
    const signer = hmacSigner();
    const engram = makeEngram();
    const signature = signer.sign(engram);
    const tampered = { ...engram, content: 'injected instruction' };
    expect(signer.verify(tampered, signature)).toBe(false);
  });

  it('rejects a signature copied onto another record', () => {
    const signer = hmacSigner();
    const original = makeEngram();
    const signature = signer.sign(original);
    const different = { ...original, id: 'm2', content: 'other content' };
    expect(signer.verify(different, signature)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const engram = makeEngram();
    const signature = hmacSigner('secret-a').sign(engram);
    expect(hmacSigner('secret-b').verify(engram, signature)).toBe(false);
  });

  it('rejects a signature from another algorithm', () => {
    const keys = MemorySigner.generateEd25519KeyPair();
    const ed = new MemorySigner({
      algorithm: 'ed25519',
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });
    const engram = makeEngram();
    const signature = ed.sign(engram);
    expect(hmacSigner().verify(engram, signature)).toBe(false);
  });

  it('signs and verifies with ed25519 asymmetrically', () => {
    const keys = MemorySigner.generateEd25519KeyPair();
    const writer = new MemorySigner({
      algorithm: 'ed25519',
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });
    const verifier = new MemorySigner({
      algorithm: 'ed25519',
      publicKeyPem: keys.publicKeyPem,
    });

    const engram = makeEngram();
    const signature = writer.sign(engram);
    expect(verifier.verify(engram, signature)).toBe(true);
  });

  it('refuses to sign with a verify-only ed25519 instance', () => {
    const keys = MemorySigner.generateEd25519KeyPair();
    const verifier = new MemorySigner({
      algorithm: 'ed25519',
      publicKeyPem: keys.publicKeyPem,
    });
    expect(() => verifier.sign(makeEngram())).toThrow(/private key/);
  });

  it('verify returns false when the public key does not match', () => {
    const keys = MemorySigner.generateEd25519KeyPair();
    const otherKeys = MemorySigner.generateEd25519KeyPair();
    const writer = new MemorySigner({
      algorithm: 'ed25519',
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem,
    });
    const engram = makeEngram();
    const signature = writer.sign(engram);
    const wrongKey = new MemorySigner({
      algorithm: 'ed25519',
      publicKeyPem: otherKeys.publicKeyPem,
    });
    expect(wrongKey.verify(engram, signature)).toBe(false);
  });
});

describe('MemorySigner — chain verification', () => {
  function makeEngram(id: string, createdAt: number, namespace = 'default'): Engram {
    return {
      id, content: `content ${id}`, type: 'semantic', importance: 'medium',
      status: 'active', strength: 1, stability: 1, lastAccessedAt: 0,
      accessCount: 0, createdAt, tags: [], source: 'agent-a', namespace,
      metadata: {}, version: 1, previousVersionId: null, supersededBy: null,
      compressedFrom: [], embedding: null,
    };
  }

  function buildChain(signer: MemorySigner, namespace = 'default', count = 3): Engram[] {
    const records: Engram[] = [];
    let prev: MemorySignature | null = null;
    for (let i = 0; i < count; i += 1) {
      const engram = makeEngram(`m${i}`, 1000 + i, namespace);
      const signature = signer.sign(engram, prev);
      engram.signature = signature;
      prev = signature;
      records.push(engram);
    }
    return records;
  }

  it('accepts an intact chain', () => {
    const signer = hmacSigner();
    const chain = buildChain(signer);
    const result = signer.verifyChain(chain);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it('orders by prev pointers, not array order', () => {
    const signer = hmacSigner();
    const chain = buildChain(signer);
    const shuffled = [chain[2], chain[0], chain[1]];
    expect(signer.verifyChain(shuffled).valid).toBe(true);
  });

  it('detects a deleted middle record', () => {
    const signer = hmacSigner();
    const chain = buildChain(signer);
    const withGap = [chain[0], chain[2]];
    const result = signer.verifyChain(withGap);
    expect(result.valid).toBe(false);
    // The successor's prev now points at a record that isn't there, so the
    // walk never reaches it: an orphaned record, not a mis-linked one.
    expect(result.errors.some((e) => e.type === 'missing_signature')).toBe(true);
  });

  it('detects a tampered record inside the chain', () => {
    const signer = hmacSigner();
    const chain = buildChain(signer);
    chain[1].content = 'rewritten';
    const result = signer.verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'signature_invalid')).toBe(true);
  });

  it('counts unsigned records without failing them', () => {
    const signer = hmacSigner();
    const unsigned = makeEngram('u1', 500);
    const result = signer.verifyChain([unsigned]);
    expect(result.unsigned).toBe(1);
    expect(result.checked).toBe(0);
    expect(result.valid).toBe(true);
  });

  it('flags a record that links to a missing predecessor', () => {
    const signer = hmacSigner();
    const chain = buildChain(signer);
    // Only keep the last signed record: its prev points at a record that is
    // no longer present.
    const result = signer.verifyChain([chain[2]]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'missing_signature')).toBe(true);
  });

  it('flags duplicate ids', () => {
    const signer = hmacSigner();
    const chain = buildChain(signer);
    const duplicated = [...chain, { ...chain[0] }];
    const result = signer.verifyChain(duplicated as Engram[]);
    expect(result.errors.some((e) => e.type === 'duplicate_id')).toBe(true);
  });

  it('keeps namespaces independent', () => {
    const signer = hmacSigner();
    const a = buildChain(signer, 'team', 2);
    const b = buildChain(signer, 'private', 2);

    const combined = signer.verifyChains([...a, ...b]);
    expect(combined.valid).toBe(true);
    expect(combined.checked).toBe(4);

    // A gap in one namespace must not be reported as corruption in the other.
    const broken = [a[0], a[1], b[0], b[1]];
    broken.splice(0, 1);
    const result = signer.verifyChains(broken as Engram[]);
    expect(result.errors.some((e) => e.namespace === 'team')).toBe(true);
    expect(result.errors.some((e) => e.namespace === 'private')).toBe(false);
  });
});

describe('MemoryManager — verifiable memory integration', () => {
  it('signs every encoded memory when a signer is configured', async () => {
    const manager = new MemoryManager({ signer: hmacSigner() }, new InMemoryStore());
    const memory = await seed(manager, 'first fact');
    expect(memory.signature).toBeDefined();
    expect((memory.signature as MemorySignature).signer).toBe('agent-a');
  });

  it('leaves memories unsigned when no signer is configured', async () => {
    const manager = new MemoryManager({}, new InMemoryStore());
    const memory = await seed(manager, 'plain fact');
    expect(memory.signature).toBeUndefined();
  });

  it('verifyMemory confirms an untouched record', async () => {
    const manager = new MemoryManager({ signer: hmacSigner() }, new InMemoryStore());
    const memory = await seed(manager, 'fact');
    expect(await manager.verifyMemory(memory.id)).toBe(true);
  });

  it('verifyMemory fails after the stored content is rewritten', async () => {
    const store = new InMemoryStore();
    const manager = new MemoryManager({ signer: hmacSigner() }, store);
    const memory = await seed(manager, 'original');

    const tampered = { ...memory, content: 'attacker injected instruction' };
    await store.put(tampered);

    expect(await manager.verifyMemory(memory.id)).toBe(false);
  });

  it('verifyMemory returns false for an unknown id', async () => {
    const manager = new MemoryManager({ signer: hmacSigner() }, new InMemoryStore());
    expect(await manager.verifyMemory('nope')).toBe(false);
  });

  it('links consecutive writes into one chain', async () => {
    const manager = new MemoryManager({ signer: hmacSigner() }, new InMemoryStore());
    const first = await seed(manager, 'one');
    const second = await seed(manager, 'two');

    const secondSig = second.signature as MemorySignature;
    expect(secondSig.prev).toBe((first.signature as MemorySignature).digest);

    const result = await manager.verifyNamespace('default');
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(2);
  });

  it('verifyNamespace detects a deleted record', async () => {
    const store = new InMemoryStore();
    const manager = new MemoryManager({ signer: hmacSigner() }, store);
    const first = await seed(manager, 'one');
    await seed(manager, 'two');
    await store.delete(first.id);

    const result = await manager.verifyNamespace('default');
    expect(result.valid).toBe(false);
  });

  it('verifyAll audits every namespace at once', async () => {
    const manager = new MemoryManager({ signer: hmacSigner() }, new InMemoryStore());
    manager.createSharedSpace('team', 'agent-a');
    await seed(manager, 'a', 'default');
    await seed(manager, 'b', 'team');

    const result = await manager.verifyAll();
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(2);
  });

  it('throws when verifying without a configured signer', async () => {
    const manager = new MemoryManager({}, new InMemoryStore());
    await expect(manager.verifyAll()).rejects.toThrow(/No signer configured/);
  });

  it('keeps verification passing after a recall (mutable state changed)', async () => {
    const manager = new MemoryManager({ signer: hmacSigner() }, new InMemoryStore());
    const memory = await seed(manager, 'recalled fact');

    // A recall mutates strength / accessCount / lastAccessedAt. Those are
    // deliberately outside the signed payload.
    await manager.query({ text: 'recalled' });
    expect(await manager.verifyMemory(memory.id)).toBe(true);
  });
});
