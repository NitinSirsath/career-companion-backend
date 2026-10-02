import { describe, expect, it } from 'vitest';
import { syncWindow } from '../services/gmailSync';

const now = new Date('2026-10-02T12:00:00Z');
const day = 86400_000;
describe('bounded Gmail scan window', () => {
  it.each([
    [null, 7, 7, false],
    [0.2, 1, 1, false],
    [1, 1, 2, false],
    [3, 14, 14, false],
    [29 + 22 / 24, 1, 30, false],
    [45, 1, 30, true],
    [-1, 7, 7, false],
  ])('gap %s days, lookback %s', (gap, lookbackDays, days, capped) => {
    const lastSyncedAt = gap === null ? null : new Date(now.getTime() - gap * day);
    const result = syncWindow({ now, lastSyncedAt, lookbackDays });
    expect(result.windowDays).toBe(days);
    expect(result.windowStart.getTime()).toBe(now.getTime() - days * day);
    expect(Boolean(result.unscanned)).toBe(capped);
    if (result.unscanned)
      expect(result.unscanned).toEqual({
        from: new Date(lastSyncedAt!.getTime() - 3600_000),
        until: result.windowStart,
      });
  });
});
