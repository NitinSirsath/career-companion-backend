import { expect, it } from 'vitest';
import { latestSlot, nextSlot } from '../services/gmailSchedule';
import { parseGmailSchedule } from '../utils/config';
// Every hour on the hour in Asia/Kolkata (UTC+5:30): at half past each UTC hour.
it.each([
  ['2026-10-02T12:29:59Z', '2026-10-02T11:30:00Z', '2026-10-02T12:30:00Z'],
  ['2026-10-02T12:30:00Z', '2026-10-02T12:30:00Z', '2026-10-02T13:30:00Z'],
  ['2026-10-02T23:59:59Z', '2026-10-02T23:30:00Z', '2026-10-03T00:30:00Z'],
])('uses inclusive latest and exclusive next slots at %s', (now, latest, next) => {
  expect(latestSlot(new Date(now), 'Asia/Kolkata')).toEqual(new Date(latest));
  expect(nextSlot(new Date(now), 'Asia/Kolkata')).toEqual(new Date(next));
});
it('uses calendar times across daylight saving changes', () => {
  // 01:30 EST; 02:00 does not exist that night, so the next hour is 03:00 EDT.
  expect(nextSlot(new Date('2026-03-08T06:30:00Z'), 'America/New_York')).toEqual(
    new Date('2026-03-08T07:00:00Z'),
  );
});
it('validates configuration in every environment', () => {
  expect(parseGmailSchedule({})).toEqual({ enabled: true, timezone: 'Asia/Kolkata' });
  expect(parseGmailSchedule({ GMAIL_SCHEDULED_SYNC_ENABLED: 'false' }).enabled).toBe(false);
  for (const value of ['', '1', 'TRUE'])
    expect(() => parseGmailSchedule({ GMAIL_SCHEDULED_SYNC_ENABLED: value })).toThrow(
      'true or false',
    );
  expect(() => parseGmailSchedule({ GMAIL_SCHEDULED_SYNC_TZ: 'Invalid/Zone' })).toThrow('timezone');
});
