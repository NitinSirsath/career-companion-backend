import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWorkers } from '../jobs/startWorkers';
import { errorCategory } from '../utils/errorCategory';
import { defaultWorkers } from '../jobs/startWorkers';
import { QUEUE_NAMES } from '../services/queue';
afterEach(() => vi.restoreAllMocks());
describe('bounded worker registration', () => {
  it('registers once without waiting when ready', async () => {
    const start = vi.fn().mockResolvedValue(undefined),
      sleep = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      await startWorkers([{ queue: 'one', start, failureEvent: 'one_failed' }], { sleep }),
    ).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('workers_ready'));
  });
  it('retries only failed registrations and gives up after the bounded backoff', async () => {
    const secret = Object.assign(new Error('postgresql://secret'), { code: 'ECONNREFUSED' });
    const good = vi.fn().mockResolvedValue(undefined),
      bad = vi.fn().mockRejectedValue(secret);
    const sleep = vi.fn().mockResolvedValue(undefined),
      stop = vi.fn().mockResolvedValue(undefined),
      onGiveUp = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await startWorkers(
        [
          { queue: 'good', start: good, failureEvent: 'good_failed' },
          { queue: 'bad', start: bad, failureEvent: 'bad_failed' },
        ],
        { sleep, stop, onGiveUp },
      ),
    ).toBe(false);
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(8);
    expect(sleep.mock.calls.flat()).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    expect(JSON.parse(log.mock.calls[7][0])).toMatchObject({
      attempt: 8,
      retryInMs: null,
      code: 'ECONNREFUSED',
    });
    expect(JSON.parse(log.mock.calls[8][0])).toMatchObject({
      event: 'worker_start_gave_up',
      queues: ['bad'],
    });
  });
  it('recovers after two startup failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error())
      .mockRejectedValueOnce(new Error())
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await startWorkers([{ queue: 'one', start, failureEvent: 'failed' }], { sleep })).toBe(
      true,
    );
    expect(sleep.mock.calls.flat()).toEqual([2000, 4000]);
  });
  it('does not restart or give up after shutdown starts during a wait', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let closing = false;
    const start = vi.fn().mockRejectedValue(new Error()),
      onGiveUp = vi.fn();
    await startWorkers([{ queue: 'one', start, failureEvent: 'failed' }], {
      sleep: async () => {
        closing = true;
      },
      isShuttingDown: () => closing,
      onGiveUp,
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(onGiveUp).not.toHaveBeenCalled();
  });
  it('allows only short uppercase driver codes', () => {
    expect(errorCategory('secret')).toEqual({ category: 'UnknownError' });
    for (const code of ['secret', 'A'.repeat(41)])
      expect(errorCategory(Object.assign(new Error(), { code }))).toEqual({ category: 'Error' });
    expect(errorCategory(Object.assign(new Error(), { code: '3D000' }))).toEqual({
      category: 'Error',
      code: '3D000',
    });
  });
});

it('registers triage without changing the existing queue positions', () => {
  const queues = defaultWorkers().map((worker) => worker.queue);
  expect(queues).toContain(QUEUE_NAMES[3]);
  expect(queues).toContain(QUEUE_NAMES[0]);
  expect(queues).toContain(QUEUE_NAMES[1]);
  expect(queues).toContain(QUEUE_NAMES[2]);
});
