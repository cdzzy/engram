/**
 * Verifiable memory — content-bound signatures and tamper-evident chains.
 *
 * Every mainstream agent-memory system (Mem0, Letta, Zep, ...) stores content
 * with plain integrity hints: Letta's `version` is optimistic locking, Mem0's
 * `hash` is a deduplication digest. None of them *sign* a record, so a party
 * with write access to the store can rewrite a memory and no verifier can tell.
 * A content hash cannot fix that either — the algorithm is public, so anyone
 * can recompute it after editing.
 *
 * This module closes that gap with real signatures:
 *
 *   - **HMAC-SHA256** — symmetric; one shared secret, simplest to operate.
 *   - **Ed25519** — asymmetric; a writer signs with its private key and any
 *     other agent verifies with only the public key. This is the mode that
 *     matters for multi-agent fleets: a verifying agent must not need the
 *     writer's secret.
 *
 * Signed fields are the *immutable identity* of a memory — `content`, `type`,
 * `importance`, `source`, `namespace`, `tags`, `createdAt`, `id`. Runtime state
 * (`strength`, `accessCount`, `lastAccessedAt`, `status`, `metadata`) is
 * deliberately excluded: those change as the memory is recalled, decayed or
 * soft-deleted, and signing them would invalidate every record on first read.
 *
 * Each signature also embeds the previous record's digest, so a chain per
 * namespace is tamper-evident: deleting a record from the middle, reordering,
 * or splicing in a record from another namespace all break the chain.
 *
 * Usage::
 *
 *   const keys = MemorySigner.generateEd25519KeyPair();
 *   const signer = new MemorySigner({
 *     algorithm: 'ed25519',
 *     privateKeyPem: keys.privateKeyPem,
 *     publicKeyPem: keys.publicKeyPem,
 *   });
 *
 *   const memory = await manager.encode({ content: 'Q3 revenue +18%', ... });
 *   // manager.sign(...) attaches `memory.signature`
 *
 *   const verifier = new MemorySigner({ algorithm: 'ed25519', publicKeyPem: keys.publicKeyPem });
 *   verifier.verify(memory, memory.signature);        // true
 *   verifier.verifyChains(await store.query({}));      // whole-store audit
 */

import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  sign as signPayload,
  timingSafeEqual,
  verify as verifyPayload,
} from 'node:crypto';
import type { Engram } from './types.js';

export type SignatureAlgorithm = 'hmac-sha256' | 'ed25519';

/** Fields whose values are bound by the signature (documentation only). */
export const SIGNED_ENGRAM_FIELDS = [
  'id',
  'content',
  'type',
  'importance',
  'source',
  'namespace',
  'tags',
  'createdAt',
] as const;

export interface MemorySignature {
  /** Signature algorithm used. */
  alg: SignatureAlgorithm;
  /** Base64-encoded signature over the canonical payload. */
  value: string;
  /** Hex SHA-256 digest of the canonical payload (chain link + fast compare). */
  digest: string;
  /** Digest of the previous record in this namespace's chain, or null. */
  prev: string | null;
  /** Agent id that signed the record. */
  signer: string;
  /** Epoch ms when the signature was created. */
  signedAt: number;
}

export interface MemorySignerConfig {
  /** Defaults to `hmac-sha256`. */
  algorithm?: SignatureAlgorithm;
  /** Required for `hmac-sha256` (both signing and verifying). */
  hmacSecret?: string;
  /** Required to sign with `ed25519` (PKCS#8 PEM). */
  privateKeyPem?: string;
  /** Required to verify `ed25519` signatures (SPKI PEM). */
  publicKeyPem?: string;
}

export type ChainErrorType =
  | 'hash_mismatch'
  | 'signature_invalid'
  | 'chain_break'
  | 'missing_signature'
  | 'duplicate_id';

export interface ChainError {
  engramId: string;
  namespace: string;
  type: ChainErrorType;
  message: string;
}

export interface ChainVerificationResult {
  valid: boolean;
  /** Number of signed records inspected. */
  checked: number;
  /** Records with no signature at all (unsigned stores are not "invalid"). */
  unsigned: number;
  errors: ChainError[];
}

/**
 * Build the canonical payload a signature covers.
 *
 * Serialized with an explicit field order (never spread from the object) so
 * key ordering can never change the digest, and `undefined` values are
 * normalized so a field going from absent to explicit-null cannot silently
 * produce a different but still "valid" record.
 */
export function canonicalMemoryPayload(engram: Engram, prevDigest: string | null): string {
  return JSON.stringify({
    id: engram.id,
    content: engram.content,
    type: engram.type,
    importance: engram.importance,
    source: engram.source,
    namespace: engram.namespace,
    tags: engram.tags,
    createdAt: engram.createdAt,
    prev: prevDigest,
  });
}

/** Hex SHA-256 of the canonical payload. */
export function memoryDigest(engram: Engram, prevDigest: string | null): string {
  return createHash('sha256')
    .update(canonicalMemoryPayload(engram, prevDigest))
    .digest('hex');
}

export class MemorySigner {
  private readonly algorithm: SignatureAlgorithm;
  private readonly hmacSecret?: string;
  private readonly privateKeyPem?: string;
  private readonly publicKeyPem?: string;

  constructor(config: MemorySignerConfig = {}) {
    this.algorithm = config.algorithm ?? 'hmac-sha256';
    this.hmacSecret = config.hmacSecret;
    this.privateKeyPem = config.privateKeyPem;
    this.publicKeyPem = config.publicKeyPem;

    // Fail at construction, not at first sign() deep in a write path.
    if (this.algorithm === 'hmac-sha256' && !this.hmacSecret) {
      throw new Error(
        "MemorySigner: 'hmacSecret' is required for algorithm 'hmac-sha256'",
      );
    }
    if (this.algorithm === 'ed25519' && !this.privateKeyPem && !this.publicKeyPem) {
      throw new Error(
        "MemorySigner: 'privateKeyPem' (to sign) or 'publicKeyPem' (to verify) "
          + "is required for algorithm 'ed25519'",
      );
    }
  }

  /** Generate a fresh Ed25519 key pair in PEM form. */
  static generateEd25519KeyPair(): { publicKeyPem: string; privateKeyPem: string } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
  }

  /**
   * Derive the matching public key from an Ed25519 private key.
   * Useful when the signing agent publishes only the verification half.
   */
  static derivePublicKey(privateKeyPem: string): string {
    return createPublicKey(privateKeyPem)
      .export({ type: 'spki', format: 'pem' })
      .toString();
  }

  /** Digest of a record, given the previous digest in its chain. */
  digest(engram: Engram, prevDigest: string | null): string {
    return memoryDigest(engram, prevDigest);
  }

  /** Sign a memory, optionally extending a chain. */
  sign(engram: Engram, prevSignature?: MemorySignature | null): MemorySignature {
    if (!this.privateKeyPem && this.algorithm === 'ed25519') {
      throw new Error(
        'MemorySigner: signing with ed25519 requires a private key; '
          + 'this instance was created for verification only',
      );
    }
    const prevDigest = prevSignature?.digest ?? null;
    const payload = canonicalMemoryPayload(engram, prevDigest);
    const digest = memoryDigest(engram, prevDigest);

    let value: string;
    if (this.algorithm === 'hmac-sha256') {
      value = createHmac('sha256', this.hmacSecret as string)
        .update(payload)
        .digest('base64');
    } else {
      value = signPayload(null, Buffer.from(payload), this.privateKeyPem as string)
        .toString('base64');
    }

    return {
      alg: this.algorithm,
      value,
      digest,
      prev: prevDigest,
      signer: engram.source,
      signedAt: Date.now(),
    };
  }

  /**
   * Verify one record against its signature.
   *
   * Recomputes the canonical payload from the memory as it exists *now*, so
   * any edit to a signed field makes verification fail. Also checks the
   * embedded digest, which catches a signature that was copied onto a
   * different record.
   */
  verify(engram: Engram, signature: MemorySignature): boolean {
    if (signature.alg !== this.algorithm) {
      return false;
    }

    const prevDigest = signature.prev ?? null;
    const expectedDigest = memoryDigest(engram, prevDigest);
    if (!constantTimeEqualsHex(signature.digest, expectedDigest)) {
      return false;
    }

    const payload = canonicalMemoryPayload(engram, prevDigest);

    if (this.algorithm === 'hmac-sha256') {
      if (!this.hmacSecret) {
        return false;
      }
      const expected = createHmac('sha256', this.hmacSecret).update(payload).digest();
      const actual = Buffer.from(signature.value, 'base64');
      if (actual.length !== expected.length) {
        return false;
      }
      return timingSafeEqual(actual, expected);
    }

    if (!this.publicKeyPem) {
      return false;
    }
    try {
      return verifyPayload(
        null,
        Buffer.from(payload),
        this.publicKeyPem,
        Buffer.from(signature.value, 'base64'),
      );
    } catch {
      return false;
    }
  }

  /**
   * Verify one namespace's chain end to end.
   *
   * Order is defined by the `prev` pointers, not by timestamps: two memories
   * written in the same millisecond would be ambiguous under a time sort (ids
   * are random UUIDs), and a chain is a linked list — its topology is the
   * pointer, exactly like a blockchain.
   *
   * The walk starts at records whose `prev` is null (chain roots), follows
   * `digest → prev` until it runs out, then reports anything it never reached
   * as an orphan. Deleting a middle record therefore surfaces as an orphaned
   * successor rather than silently reordering.
   */
  verifyChain(engrams: Engram[]): ChainVerificationResult {
    const errors: ChainError[] = [];
    const seenIds = new Set<string>();
    let unsigned = 0;
    let checked = 0;

    interface Signed {
      engram: Engram;
      signature: MemorySignature;
    }
    const signed: Signed[] = [];

    for (const engram of engrams) {
      if (seenIds.has(engram.id)) {
        errors.push({
          engramId: engram.id,
          namespace: engram.namespace,
          type: 'duplicate_id',
          message: `Duplicate memory id '${engram.id}' in namespace '${engram.namespace}'`,
        });
        continue;
      }
      seenIds.add(engram.id);

      const signature = engram.signature as MemorySignature | undefined;
      if (!signature) {
        unsigned++;
        continue;
      }

      checked++;
      if (!this.verify(engram, signature)) {
        errors.push({
          engramId: engram.id,
          namespace: engram.namespace,
          type: 'signature_invalid',
          message: `Signature does not match the current content of memory '${engram.id}'`,
        });
      }
      signed.push({ engram, signature });
    }

    // prev → record, so the walk is O(1) per hop.
    const byPrev = new Map<string, Signed>();
    for (const item of signed) {
      if (item.signature.prev !== null) {
        byPrev.set(item.signature.prev, item);
      }
    }

    const roots = signed.filter((item) => item.signature.prev === null);
    const visited = new Set<string>();

    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];

      // A namespace is one write domain, so it gets one chain. Extra roots
      // mean two independent chains were merged into a single store.
      if (index > 0) {
        errors.push({
          engramId: root.engram.id,
          namespace: root.engram.namespace,
          type: 'chain_break',
          message: `Memory '${root.engram.id}' starts a second chain in namespace '${root.engram.namespace}'`,
        });
      }

      let cursor: Signed | undefined = root;
      while (cursor) {
        if (visited.has(cursor.signature.digest)) {
          errors.push({
            engramId: cursor.engram.id,
            namespace: cursor.engram.namespace,
            type: 'chain_break',
            message: `Cycle detected at memory '${cursor.engram.id}'`,
          });
          break;
        }
        visited.add(cursor.signature.digest);
        cursor = byPrev.get(cursor.signature.digest);
      }
    }

    // Records the walk never reached: their predecessor is missing, or they
    // were spliced in from a chain that was never fully imported.
    for (const item of signed) {
      if (visited.has(item.signature.digest)) {
        continue;
      }
      errors.push({
        engramId: item.engram.id,
        namespace: item.engram.namespace,
        type: 'missing_signature',
        message:
          `Memory '${item.engram.id}' links to a predecessor that is not present `
            + `in namespace '${item.engram.namespace}'`,
      });
    }

    return {
      valid: errors.length === 0,
      checked,
      unsigned,
      errors,
    };
  }

  /**
   * Verify all namespaces independently and roll the results up.
   *
   * Chains are per namespace by design: a shared space and a private one are
   * separate write domains, so a gap in one must not be reported as corruption
   * in the other.
   */
  verifyChains(engrams: Engram[]): ChainVerificationResult {
    const byNamespace = new Map<string, Engram[]>();
    for (const engram of engrams) {
      const bucket = byNamespace.get(engram.namespace);
      if (bucket) {
        bucket.push(engram);
      } else {
        byNamespace.set(engram.namespace, [engram]);
      }
    }

    const combined: ChainVerificationResult = {
      valid: true,
      checked: 0,
      unsigned: 0,
      errors: [],
    };

    for (const [, bucket] of byNamespace) {
      const result = this.verifyChain(bucket);
      combined.checked += result.checked;
      combined.unsigned += result.unsigned;
      combined.errors.push(...result.errors);
      if (!result.valid) {
        combined.valid = false;
      }
    }

    return combined;
  }
}

function constantTimeEqualsHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
