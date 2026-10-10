import { GMAIL_SYNC_EXPIRE_SECONDS } from '../services/enqueue';
import { SYNC_ATTEMPT_BUDGET_MS } from '../services/googleTransport';
import { describe, it, expect, vi } from 'vitest';
import { extractHeaders, GmailAuthError } from '../services/gmailSync';
import { googleAuthFailure, googleStatus } from '../services/gmailClient';

vi.mock('../services/enqueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/enqueue')>()),
  enqueueEmailProcessingJob: vi.fn().mockResolvedValue(undefined),
}));

describe('gmailSync helpers', () => {
  describe('extractHeaders', () => {
    it('extracts Subject, From, and Date correctly', () => {
      const headers = [
        { name: 'Return-Path', value: '<foo@bar.com>' },
        { name: 'From', value: 'Recruiter <recruiter@company.com>' },
        { name: 'Subject', value: 'Interview Invitation' },
        { name: 'Date', value: 'Wed, 12 Sep 2026 10:00:00 +0000' },
      ];

      const { subject, sender, receivedAt } = extractHeaders(headers);

      expect(subject).toBe('Interview Invitation');
      expect(sender).toBe('Recruiter <recruiter@company.com>');
      expect(receivedAt).toBeInstanceOf(Date);
      expect(receivedAt?.toISOString()).toBe('2026-09-12T10:00:00.000Z');
    });

    it('is case-insensitive for header names', () => {
      const headers = [
        { name: 'from', value: 'recruiter@company.com' },
        { name: 'SUBJECT', value: 'Offer' },
        { name: 'DaTe', value: 'Wed, 12 Sep 2026 10:00:00 +0000' },
      ];

      const { subject, sender } = extractHeaders(headers);
      expect(subject).toBe('Offer');
      expect(sender).toBe('recruiter@company.com');
    });

    it('returns nulls when headers are missing', () => {
      const { subject, sender, receivedAt } = extractHeaders([]);
      expect(subject).toBeNull();
      expect(sender).toBeNull();
      expect(receivedAt).toBeNull();
    });

    it('handles undefined headers array safely', () => {
      const { subject, sender, receivedAt } = extractHeaders(undefined);
      expect(subject).toBeNull();
      expect(sender).toBeNull();
      expect(receivedAt).toBeNull();
    });

    it('ignores invalid dates safely', () => {
      const headers = [{ name: 'Date', value: 'Not a real date' }];
      const { receivedAt } = extractHeaders(headers);
      expect(receivedAt).toBeNull();
    });
  });

  // ─── GmailAuthError ────────────────────────────────────────────────────────

  describe('GmailAuthError', () => {
    it('has the correct code and name', () => {
      const err = new GmailAuthError('test message');
      expect(err.code).toBe('GMAIL_AUTH_FAILED');
      expect(err.name).toBe('GmailAuthError');
      expect(err.message).toBe('test message');
      expect(err).toBeInstanceOf(Error);
    });

    it('is instanceof GmailAuthError (not just Error)', () => {
      const err = new GmailAuthError('test');
      expect(err instanceof GmailAuthError).toBe(true);
    });
  });

  describe('production Google error classification', () => {
    it.each([
      [{ status: 401 }, 401, true],
      [{ response: { status: 403 } }, 403, false],
      [{ status: 429 }, 429, false],
      [{ response: { data: { error: 'invalid_grant' } } }, undefined, true],
      [Object.assign(new Error('Gmail request failed'), { status: 401 }), 401, true],
      [new Error('401 invalid_grant in unrelated text'), undefined, false],
    ])('classifies structured errors without guessing from messages', (error, status, auth) => {
      expect(googleStatus(error)).toBe(status);
      expect(googleAuthFailure(error)).toBe(auth);
    });
  });
});

it('ends the attempt at least 30 seconds before queue expiry', () => {
  expect(GMAIL_SYNC_EXPIRE_SECONDS * 1000 - SYNC_ATTEMPT_BUDGET_MS).toBeGreaterThanOrEqual(30_000);
});
