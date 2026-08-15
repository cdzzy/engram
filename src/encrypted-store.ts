/**
 * EncryptedStore — AES-256-GCM encryption-at-rest for Engram memories.
 *
 * Wraps any MemoryStore and transparently encrypts memory content before it is
 * persisted, and decrypts it on read. Structural fields (id, type, status,
 * tags, strength, timestamps) remain in plaintext so filtering and the decay
 * engine still work; only the sensitive `content` field (and optionally
 * `metadata`) is encrypted.
 *
 * Key management:
 *   - `key`: a 32-byte Buffer, a 64-char hex string, or a passphrase (hashed).
 *   - `keySource`: read the key from an env var, e.g. 'env:ENGRAM_ENCRYPTION_KEY'.
 *
 * Usage:
 *   import { EncryptedStore } from './encrypted-store';
 *   import { FileStore } from './storage/file-store';
 *
 *   const inner = new FileStore('/data/engram');
 *   await inner.init();
 *
 *   const store = new EncryptedStore(inner, {
 *     keySource: 'env:ENGRAM_ENCRYPTION_KEY',
 *   });
 */

import * as crypto from 'crypto';
import type { Engram, MemoryStore, MemoryFilter } from './types';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;      // 96-bit IV (recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag
const ENCRYPTED_FLAG = '__engram_encrypted__';

export interface EncryptedStoreConfig {
  /** 32-byte key (Buffer), 64-char hex string, or passphrase (hashed to key). */
  key?: Buffer | string;
  /** Read key from env var, e.g. 'env:ENGRAM_ENCRYPTION_KEY'. */
  keySource?: string;
  /** Also encrypt the metadata object (default: true). */
  encryptMetadata?: boolean;
}

export class EncryptedStore implements MemoryStore {
  private inner: MemoryStore;
  private key: Buffer;
  private encryptMetadata: boolean;

  constructor(inner: MemoryStore, config: EncryptedStoreConfig) {
    this.inner = inner;
    this.key = resolveKey(config);
    this.encryptMetadata = config.encryptMetadata ?? true;
  }

  // ── MemoryStore interface ───────────────────────────────────────────────

  async get(id: string): Promise<Engram | null> {
    const engram = await this.inner.get(id);
    return engram ? this.decrypt(engram) : null;
  }

  async getMany(ids: string[]): Promise<Engram[]> {
    const engrams = await this.inner.getMany(ids);
    return engrams.map((e) => this.decrypt(e));
  }

  async put(engram: Engram): Promise<void> {
    await this.inner.put(this.encrypt(engram));
  }

  async delete(id: string): Promise<void> {
    await this.inner.delete(id);
  }

  async query(filter: MemoryFilter): Promise<Engram[]> {
    const engrams = await this.inner.query(filter);
    return engrams.map((e) => this.decrypt(e));
  }

  async count(filter?: MemoryFilter): Promise<number> {
    return this.inner.count(filter);
  }

  async clear(): Promise<void> {
    await this.inner.clear();
  }

  // ── Encryption primitives ───────────────────────────────────────────────

  private encrypt(engram: Engram): Engram {
    const payload: { content: string; metadata?: Record<string, unknown> } = {
      content: engram.content,
    };
    if (this.encryptMetadata && engram.metadata) {
      payload.metadata = engram.metadata;
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf-8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Pack: iv (12) + authTag (16) + ciphertext
    const blob = Buffer.concat([iv, authTag, encrypted]).toString('base64');

    return {
      ...engram,
      content: blob,
      metadata: {
        ...engram.metadata,
        [ENCRYPTED_FLAG]: true,
      },
    };
  }

  private decrypt(engram: Engram): Engram {
    const isEncrypted = engram.metadata?.[ENCRYPTED_FLAG] === true;
    if (!isEncrypted) return engram; // legacy / unencrypted entry

    const blob = Buffer.from(engram.content, 'base64');
    const iv = blob.subarray(0, IV_LENGTH);
    const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    const payload = JSON.parse(decrypted.toString('utf-8')) as {
      content: string;
      metadata?: Record<string, unknown>;
    };

    const { [ENCRYPTED_FLAG]: _flag, ...restMetadata } = engram.metadata;

    return {
      ...engram,
      content: payload.content,
      metadata: payload.metadata ?? restMetadata,
    };
  }
}

// ── Key resolution ──────────────────────────────────────────────────────────

function resolveKey(config: EncryptedStoreConfig): Buffer {
  let raw: Buffer | string | undefined = config.key;

  if (config.keySource) {
    if (!config.keySource.startsWith('env:')) {
      throw new Error("keySource must be of the form 'env:ENV_VAR_NAME'");
    }
    const envName = config.keySource.slice('env:'.length);
    const value = process.env[envName];
    if (!value) {
      throw new Error(`Encryption key not found in environment variable '${envName}'`);
    }
    raw = value;
  }

  if (!raw) {
    throw new Error(
      'EncryptedStore requires either `key` or `keySource` to be configured',
    );
  }

  if (Buffer.isBuffer(raw)) {
    if (raw.length !== 32) {
      throw new Error(`AES-256-GCM requires a 32-byte key (got ${raw.length})`);
    }
    return raw;
  }

  const str = raw as string;
  // 64-char hex string → direct key
  if (/^[0-9a-fA-F]{64}$/.test(str)) {
    return Buffer.from(str, 'hex');
  }

  // Otherwise treat as a passphrase and derive a 32-byte key via SHA-256
  return crypto.createHash('sha256').update(str).digest();
}

/** Convenience: generate a random 32-byte key (hex-encoded) for AES-256-GCM. */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}
