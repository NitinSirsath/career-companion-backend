/**
 * Sealing for user-provided AI keys (ADR-0001 decision 6, architecture §7).
 *
 * - AES-256-GCM with a dedicated key (AI_CREDENTIAL_ENCRYPTION_KEY), never the Gmail token key.
 * - The ciphertext is bound to its owner through additional authenticated data, so a sealed key
 *   copied to another user's row cannot be opened.
 * - Format `v1:<iv base64>:<ciphertext+tag base64>`; the version allows a later key rotation.
 * - Plaintext exists only in the request or job that needs it. Opening a key is allowed only in
 *   services/ai/access.ts and services/ai/settings.ts (enforced by a boundary test).
 */
import { aiCredentialEncryptionKey } from '../../utils/config';
import { decrypt, encrypt } from '../../utils/gmailTokenEncryption';

const FORMAT = 'v1';

/** Thrown when a sealed key cannot be opened. Carries no key material. */
export class CredentialUnreadableError extends Error {
  constructor() {
    super('Stored AI credential cannot be read');
    this.name = 'CredentialUnreadableError';
  }
}

export function loadAICredentialKey(): Buffer {
  const hex = aiCredentialEncryptionKey();
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex))
    throw new Error('AI_CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  return Buffer.from(hex, 'hex');
}

const aad = (userId: string) => Buffer.from(`ai-credential:${FORMAT}:${userId}`, 'utf8');

export function sealApiKey(userId: string, apiKey: string): string {
  const { iv, ciphertext } = encrypt(apiKey, loadAICredentialKey(), aad(userId));
  return `${FORMAT}:${iv}:${ciphertext}`;
}

export function openApiKey(userId: string, sealed: string): string {
  const key = loadAICredentialKey();
  const [format, iv, ciphertext, extra] = sealed.split(':');
  if (format !== FORMAT || !iv || !ciphertext || extra !== undefined)
    throw new CredentialUnreadableError();
  try {
    return decrypt(ciphertext, iv, key, aad(userId));
  } catch {
    throw new CredentialUnreadableError();
  }
}
