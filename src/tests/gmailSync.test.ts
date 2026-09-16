import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractHeaders, GmailAuthError } from '../services/gmailSync';
import { GaxiosError } from 'gaxios';

vi.mock('../jobs/emailProcessingJob', () => ({
  enqueueEmailProcessingJob: vi.fn().mockResolvedValue(undefined),
}));

describe('GmailSyncService Helpers', () => {
  describe('extractHeaders', () => {
    it('extracts Subject, From, and Date correctly', () => {
      const headers = [
        { name: 'Return-Path', value: '<foo@bar.com>' },
        { name: 'From', value: 'Recruiter <recruiter@company.com>' },
        { name: 'Subject', value: 'Interview Invitation' },
        { name: 'Date', value: 'Wed, 12 Sep 2026 10:00:00 +0000' }
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
        { name: 'DaTe', value: 'Wed, 12 Sep 2026 10:00:00 +0000' }
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

  // ─── GaxiosError detection ─────────────────────────────────────────────────

  describe('GaxiosError 401/403 detection', () => {
    it('GaxiosError with status 401 is detectable for reclassification', () => {
      // Simulate the detection logic used in syncUser's inner catch
      const err = new GaxiosError('Unauthorized', { headers: new Headers(), url: new URL('https://test.com') }, {
        status: 401,
        statusText: 'Unauthorized',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: {} as any,
        headers: {} as any,
        config: {} as any,
        request: {} as any,
      });

      const isGmailAuthFailure =
        err instanceof GaxiosError && (err.status === 401 || err.status === 403);
      expect(isGmailAuthFailure).toBe(true);
    });

    it('GaxiosError with status 429 is NOT reclassified as auth failure', () => {
      const err = new GaxiosError('Too Many Requests', { headers: new Headers(), url: new URL('https://test.com') }, {
        status: 429,
        statusText: 'Too Many Requests',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: {} as any,
        headers: {} as any,
        config: {} as any,
        request: {} as any,
      });

      const isGmailAuthFailure =
        err instanceof GaxiosError && (err.status === 401 || err.status === 403);
      expect(isGmailAuthFailure).toBe(false);
    });
  });
});

