/**
 * Unit tests for GmailTokenEncryption (COM-19).
 * Tests run without real Google credentials or DB access.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';
import {
  encrypt,
  decrypt,
  encryptToken,
  decryptToken,
  loadEncryptionKey,
} from '../utils/gmailTokenEncryption';

// ── Test key (32 bytes = 64 hex chars) ─────────────────────────────────────
const TEST_KEY_HEX = 'a'.repeat(64); // Not a real key — test fixture only
const TEST_KEY = Buffer.from(TEST_KEY_HEX, 'hex');

describe('GmailTokenEncryption', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('decrypt(encrypt(token)) === original token', () => {
      const original = 'ya29.a0AfB_byC_test_access_token_value';
      const { ciphertext, iv } = encrypt(original, TEST_KEY);
      const decrypted = decrypt(ciphertext, iv, TEST_KEY);
      expect(decrypted).toBe(original);
    });

    it('handles short token strings', () => {
      const original = 'short';
      const { ciphertext, iv } = encrypt(original, TEST_KEY);
      expect(decrypt(ciphertext, iv, TEST_KEY)).toBe(original);
    });

    it('handles long token strings (typical Google OAuth token length)', () => {
      const original = 'a'.repeat(512) + '_refresh_token_end';
      const { ciphertext, iv } = encrypt(original, TEST_KEY);
      expect(decrypt(ciphertext, iv, TEST_KEY)).toBe(original);
    });

    it('handles unicode/special characters', () => {
      const original = 'token_with_special=chars/and+base64?symbols&more';
      const { ciphertext, iv } = encrypt(original, TEST_KEY);
      expect(decrypt(ciphertext, iv, TEST_KEY)).toBe(original);
    });
  });

  describe('IV uniqueness', () => {
    it('encrypting the same plaintext twice produces different IVs', () => {
      const token = 'same_access_token';
      const result1 = encrypt(token, TEST_KEY);
      const result2 = encrypt(token, TEST_KEY);
      expect(result1.iv).not.toBe(result2.iv);
    });

    it('encrypting the same plaintext twice produces different ciphertexts', () => {
      const token = 'same_access_token';
      const result1 = encrypt(token, TEST_KEY);
      const result2 = encrypt(token, TEST_KEY);
      expect(result1.ciphertext).not.toBe(result2.ciphertext);
    });
  });

  describe('authentication tag verification', () => {
    it('throws when ciphertext is tampered with', () => {
      const { ciphertext, iv } = encrypt('valid_token', TEST_KEY);
      // Flip the first byte of ciphertext to corrupt it
      const tampered = Buffer.from(ciphertext, 'base64');
      tampered[0] ^= 0xff;
      expect(() => decrypt(tampered.toString('base64'), iv, TEST_KEY)).toThrow();
    });

    it('throws when IV is wrong', () => {
      const { ciphertext } = encrypt('valid_token', TEST_KEY);
      const wrongIv = randomBytes(12).toString('base64');
      expect(() => decrypt(ciphertext, wrongIv, TEST_KEY)).toThrow();
    });

    it('throws when key is wrong', () => {
      const { ciphertext, iv } = encrypt('valid_token', TEST_KEY);
      const wrongKey = Buffer.alloc(32, 0xbb);
      expect(() => decrypt(ciphertext, iv, wrongKey)).toThrow();
    });

    it('throws for ciphertext that is too short to contain an auth tag', () => {
      const shortBuf = Buffer.from('tooshort');
      expect(() => decrypt(shortBuf.toString('base64'), 'aGVsbG8=', TEST_KEY)).toThrow();
    });
  });

  describe('encryptToken / decryptToken convenience wrappers', () => {
    beforeEach(() => {
      process.env.GMAIL_TOKEN_ENCRYPTION_KEY = TEST_KEY_HEX;
    });

    afterEach(() => {
      delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
    });

    it('encryptToken → decryptToken round-trip', () => {
      const original = 'ya29.real_access_token_here';
      const stored = encryptToken(original);
      expect(stored).toContain('|'); // iv|ciphertext format
      expect(decryptToken(stored)).toBe(original);
    });

    it('encryptToken produces "iv|ciphertext" format', () => {
      const stored = encryptToken('some_token');
      const parts = stored.split('|');
      expect(parts).toHaveLength(2);
      expect(parts[0].length).toBeGreaterThan(0); // iv
      expect(parts[1].length).toBeGreaterThan(0); // ciphertext
    });

    it('decryptToken throws on invalid format (no pipe)', () => {
      expect(() => decryptToken('no_pipe_separator_here')).toThrow('Invalid encrypted token format');
    });
  });

  describe('loadEncryptionKey', () => {
    afterEach(() => {
      delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
    });

    it('throws when GMAIL_TOKEN_ENCRYPTION_KEY is not set', () => {
      delete process.env.GMAIL_TOKEN_ENCRYPTION_KEY;
      expect(() => loadEncryptionKey()).toThrow('GMAIL_TOKEN_ENCRYPTION_KEY is not set');
    });

    it('throws when GMAIL_TOKEN_ENCRYPTION_KEY is empty', () => {
      process.env.GMAIL_TOKEN_ENCRYPTION_KEY = '';
      expect(() => loadEncryptionKey()).toThrow('GMAIL_TOKEN_ENCRYPTION_KEY is not set');
    });

    it('throws when GMAIL_TOKEN_ENCRYPTION_KEY has wrong length', () => {
      process.env.GMAIL_TOKEN_ENCRYPTION_KEY = 'abc123'; // Too short
      expect(() => loadEncryptionKey()).toThrow('64-character hex string');
    });

    it('returns a 32-byte Buffer when key is valid', () => {
      process.env.GMAIL_TOKEN_ENCRYPTION_KEY = TEST_KEY_HEX;
      const key = loadEncryptionKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });
  });
});
