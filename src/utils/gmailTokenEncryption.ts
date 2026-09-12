/**
 * AES-256-GCM encryption/decryption for Gmail OAuth tokens.
 *
 * Design principles (COM-19):
 * - Each token is encrypted with a unique random IV (12 bytes).
 * - Produces base64-encoded ciphertext and base64-encoded IV stored separately.
 * - Encryption key is loaded from GMAIL_TOKEN_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 * - Decryption failure throws — callers must handle this as a terminal processing error.
 * - Raw token values MUST NEVER appear in logs or API responses.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag

export interface EncryptedToken {
  /** Base64-encoded ciphertext (includes GCM auth tag appended). */
  ciphertext: string;
  /** Base64-encoded 12-byte IV. Unique per encryption. */
  iv: string;
}

/**
 * Returns the 32-byte encryption key from env, or throws if missing/invalid.
 * Does not throw at module load time — routes can degrade gracefully if called
 * before the key is set, returning a 500 rather than crashing the process.
 */
export function loadEncryptionKey(): Buffer {
  const hex = process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.trim() === '') {
    throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY is not set');
  }
  if (hex.length !== 64) {
    throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error('GMAIL_TOKEN_ENCRYPTION_KEY produced an invalid key buffer');
  }
  return buf;
}

/**
 * Encrypts a plaintext token string using AES-256-GCM with a fresh random IV.
 *
 * @param plaintext - The raw OAuth token string (accessToken or refreshToken).
 * @param key       - 32-byte encryption key (from loadEncryptionKey()).
 * @returns EncryptedToken containing base64-encoded ciphertext+authTag and IV.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedToken {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Append auth tag to ciphertext so they travel together.
  const ciphertextWithTag = Buffer.concat([encrypted, authTag]);

  return {
    ciphertext: ciphertextWithTag.toString('base64'),
    iv: iv.toString('base64'),
  };
}

/**
 * Decrypts a ciphertext previously produced by encrypt().
 *
 * @param ciphertext - Base64-encoded ciphertext+authTag.
 * @param iv         - Base64-encoded IV used during encryption.
 * @param key        - 32-byte encryption key (must be the same key used for encryption).
 * @returns The original plaintext token string.
 * @throws If decryption or authentication tag verification fails.
 */
export function decrypt(ciphertext: string, iv: string, key: Buffer): string {
  const ciphertextBuf = Buffer.from(ciphertext, 'base64');
  const ivBuf = Buffer.from(iv, 'base64');

  if (ciphertextBuf.length < AUTH_TAG_LENGTH) {
    throw new Error('Ciphertext is too short to contain an auth tag');
  }

  // Auth tag was appended during encryption — split it off.
  const authTag = ciphertextBuf.subarray(ciphertextBuf.length - AUTH_TAG_LENGTH);
  const encryptedData = ciphertextBuf.subarray(0, ciphertextBuf.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, ivBuf, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Convenience: encrypt token using the key from GMAIL_TOKEN_ENCRYPTION_KEY env var.
 * Returns a pipe-separated string "iv|ciphertext" suitable for storing in a single DB column.
 */
export function encryptToken(plaintext: string): string {
  const key = loadEncryptionKey();
  const { ciphertext, iv } = encrypt(plaintext, key);
  return `${iv}|${ciphertext}`;
}

/**
 * Convenience: decrypt a token stored as "iv|ciphertext" (from encryptToken).
 * Throws if GMAIL_TOKEN_ENCRYPTION_KEY is not set or decryption fails.
 */
export function decryptToken(stored: string): string {
  const key = loadEncryptionKey();
  const pipeIndex = stored.indexOf('|');
  if (pipeIndex === -1) {
    throw new Error('Invalid encrypted token format: missing pipe separator');
  }
  const iv = stored.substring(0, pipeIndex);
  const ciphertext = stored.substring(pipeIndex + 1);
  return decrypt(ciphertext, iv, key);
}
