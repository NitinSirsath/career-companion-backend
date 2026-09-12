import { describe, it, expect } from 'vitest';
import { extractHeaders } from '../services/gmailSync';

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
});
