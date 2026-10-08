import { afterEach, describe, expect, it, vi } from 'vitest';
import { logDebug, logError, logEvent, logWarn, runWithRequestId } from '../utils/log';

const originalLevel = process.env.LOG_LEVEL;
const originalEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.LOG_LEVEL = originalLevel;
  process.env.NODE_ENV = originalEnv;
  vi.restoreAllMocks();
});

function line(spy: ReturnType<typeof vi.spyOn>) {
  return String(spy.mock.calls[0]?.[0]);
}

describe('logger', () => {
  it('filters events below LOG_LEVEL', () => {
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'warn';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logDebug('debug_event');
    logEvent('info_event');
    logWarn('warn_event');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(line(spy)).toContain('"event":"warn_event"');
  });

  it('redacts sensitive top-level fields', () => {
    process.env.NODE_ENV = 'test';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logEvent('redaction_test', {
      apiKey: 'secret-api-key',
      token: 'secret-token',
      body: 'email body',
      userId: 'safe-user-id',
    });
    const output = line(spy);
    expect(output).not.toContain('secret-api-key');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('email body');
    expect(output).toContain('[redacted]');
    expect(output).toContain('safe-user-id');
  });

  it('writes the JSON event shape in tests', () => {
    process.env.NODE_ENV = 'test';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logEvent('shape_test', { count: 2 });
    expect(JSON.parse(line(spy))).toEqual({ level: 'info', event: 'shape_test', count: 2 });
  });

  it('adds message and stack outside production', () => {
    process.env.NODE_ENV = 'test';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = Object.assign(new Error('boom'), { code: 'SOMETHING_BROKE' });
    logError('failure', undefined, error);
    const output = JSON.parse(line(spy));
    expect(output.errorName).toBe('Error');
    expect(output.code).toBe('SOMETHING_BROKE');
    expect(output.message).toBe('boom');
    expect(output.stack).toContain('log.test.ts');
    expect(output.where).toContain('log.test.ts');
  });

  it('keeps production errors free of messages and stacks', () => {
    process.env.NODE_ENV = 'production';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = Object.assign(new Error('provider secret must not escape'), { code: 'PROVIDER_FAIL' });
    logError('failure', undefined, error);
    const output = JSON.parse(line(spy));
    expect(output.errorName).toBe('Error');
    expect(output.code).toBe('PROVIDER_FAIL');
    expect(output.where).toBeDefined();
    expect(output.message).toBeUndefined();
    expect(output.stack).toBeUndefined();
    expect(line(spy)).not.toContain('provider secret must not escape');
  });

  it('adds the active request ID', () => {
    process.env.NODE_ENV = 'test';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runWithRequestId('request-123', () => logEvent('request_event'));
    expect(JSON.parse(line(spy)).requestId).toBe('request-123');
  });
});
