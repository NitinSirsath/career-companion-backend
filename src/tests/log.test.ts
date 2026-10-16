import { afterEach, describe, expect, it, vi } from 'vitest';
import { logDebug, logError, logEvent, logWarn, runWithRequestId } from '../utils/log';

const originalLevel = process.env.LOG_LEVEL;
const originalEnv = process.env.NODE_ENV;

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore('LOG_LEVEL', originalLevel);
  restore('NODE_ENV', originalEnv);
  vi.restoreAllMocks();
});

const capture = (method: 'log' | 'warn' | 'error' | 'debug') =>
  vi.spyOn(console, method).mockImplementation(() => {});
const firstLine = (spy: ReturnType<typeof capture>) => String(spy.mock.calls[0]?.[0]);
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

describe('logger', () => {
  it('writes each level to its console method and skips levels below LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'warn';
    const debug = capture('debug');
    const info = capture('log');
    const warn = capture('warn');
    const error = capture('error');
    logDebug('debug_event');
    logEvent('info_event');
    logWarn('warn_event');
    logError('error_event');
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(JSON.parse(firstLine(warn))).toMatchObject({ event: 'warn_event', level: 'warn' });
    expect(JSON.parse(firstLine(error))).toMatchObject({ event: 'error_event', level: 'error' });
  });

  it('prints debug lines only with LOG_LEVEL=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    const debug = capture('debug');
    logDebug('debug_event', { count: 1 });
    const line = JSON.parse(firstLine(debug));
    expect(line).toMatchObject({ event: 'debug_event', level: 'debug', count: 1 });
    expect(line.time).toMatch(ISO_UTC);
  });

  it('stamps every JSON line with the ISO UTC time it was written', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-14T06:06:31.250+05:30'));
      const spy = capture('warn');
      logWarn('timed_event');
      expect(JSON.parse(firstLine(spy))).toMatchObject({
        time: '2026-10-14T00:36:31.250Z',
        event: 'timed_event',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an unknown LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'verbose';
    expect(() => logEvent('any')).toThrow('LOG_LEVEL must be debug, info, warn or error');
  });

  it('redacts secret and email-content fields', () => {
    const spy = capture('log');
    logEvent('redaction_test', {
      apiKey: 'secret-api-key',
      token: 'secret-token',
      body: 'email body',
      subject: 'email subject',
      sender: 'Recruiter <recruiter@example.com>',
      from: 'recruiter@example.com',
      to: 'owner@example.com',
      cc: 'manager@example.com',
      address: 'owner@example.com',
      input: 'email text sent to the AI provider',
      prompt: 'instructions with email text',
      response: 'the AI provider answer',
      raw: 'raw provider payload',
      userId: 'safe-user-id',
    });
    const line = JSON.parse(firstLine(spy));
    expect(line).toMatchObject({
      event: 'redaction_test',
      level: 'info',
      apiKey: '[redacted]',
      token: '[redacted]',
      body: '[redacted]',
      subject: '[redacted]',
      sender: '[redacted]',
      from: '[redacted]',
      to: '[redacted]',
      cc: '[redacted]',
      address: '[redacted]',
      input: '[redacted]',
      prompt: '[redacted]',
      response: '[redacted]',
      raw: '[redacted]',
      userId: 'safe-user-id',
    });
    expect(line.time).toMatch(ISO_UTC);
    expect(firstLine(spy)).not.toMatch(/example\.com|email text|answer|payload/);
  });

  it('adds the active request ID', () => {
    const spy = capture('log');
    runWithRequestId('request-123', () => logEvent('request_event'));
    logEvent('outside_request');
    expect(JSON.parse(String(spy.mock.calls[0][0])).requestId).toBe('request-123');
    expect(JSON.parse(String(spy.mock.calls[1][0]))).not.toHaveProperty('requestId');
  });

  it('says what broke and where, without the message, in tests and production', () => {
    for (const env of ['test', 'production']) {
      process.env.NODE_ENV = env;
      const spy = capture('error');
      const error = Object.assign(new Error('postgresql://secret'), { code: 'ECONNREFUSED' });
      logError('failure', { jobId: 'job-1' }, error);
      const line = firstLine(spy);
      expect(JSON.parse(line)).toMatchObject({
        event: 'failure',
        jobId: 'job-1',
        category: 'Error',
        code: 'ECONNREFUSED',
        where: expect.stringMatching(/^src\/tests\/log\.test\.ts:\d+$/),
      });
      expect(line).not.toContain('secret');
      vi.restoreAllMocks();
    }
  });

  it('prints a readable line with the message and stack on a developer machine', () => {
    process.env.NODE_ENV = 'development';
    const spy = capture('error');
    logError('request_failed', { method: 'PUT', status: 500 }, new Error('key is missing'));
    const [line, ...stack] = firstLine(spy).split('\n');
    expect(line).toMatch(
      /^\d\d:\d\d:\d\d ERROR request_failed method=PUT status=500 category=Error where=src\/tests\/log\.test\.ts:\d+ message=key is missing$/,
    );
    expect(stack[0]).toContain('log.test.ts');
  });
});
