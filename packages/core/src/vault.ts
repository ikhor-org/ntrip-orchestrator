import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;
const TAG_LEN = 16;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

/**
 * Parse VAULT_KEK / VAULT_MASTER_KEY from hex (64 chars) or base64 (32 bytes).
 * Dev-only key material — never log the raw key.
 */
export function parseKek(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === '') {
    throw new VaultError(
      'VAULT_KEK or VAULT_MASTER_KEY is required (32-byte hex or base64)',
    );
  }
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === 32) return buf;
  } catch {
    /* fall through */
  }
  throw new VaultError(
    'VAULT_KEK must be 32 bytes as 64-char hex or base64',
  );
}

export interface EncryptedBlob {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

export function encrypt(
  kek: Buffer,
  plaintext: Buffer | string,
  keyVersion = 1,
): EncryptedBlob {
  if (kek.length !== 32) {
    throw new VaultError('KEK must be 32 bytes for AES-256-GCM');
  }
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, kek, nonce);
  const pt =
    typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const enc = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([enc, tag]),
    nonce,
    keyVersion,
  };
}

export function decrypt(kek: Buffer, blob: EncryptedBlob): Buffer {
  if (kek.length !== 32) {
    throw new VaultError('KEK must be 32 bytes for AES-256-GCM');
  }
  if (blob.ciphertext.length < TAG_LEN) {
    throw new VaultError('ciphertext too short');
  }
  const data = blob.ciphertext.subarray(0, blob.ciphertext.length - TAG_LEN);
  const tag = blob.ciphertext.subarray(blob.ciphertext.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, kek, blob.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function encryptJson(
  kek: Buffer,
  value: unknown,
  keyVersion = 1,
): EncryptedBlob {
  return encrypt(kek, JSON.stringify(value), keyVersion);
}

export function decryptJson<T>(kek: Buffer, blob: EncryptedBlob): T {
  const raw = decrypt(kek, blob).toString('utf8');
  return JSON.parse(raw) as T;
}

/** Generate a random 32-byte KEK as hex (for .env.example docs / tests). */
export function generateKekHex(): string {
  return randomBytes(32).toString('hex');
}
