import { expect, it } from 'vitest';
import { latestSlot, nextSlot, parseGmailSchedule } from '../services/gmailSchedule';
it.each([
  ['2026-10-02T12:29:59Z', '2026-10-01T18:30:00Z', '2026-10-02T12:30:00Z'],
  ['2026-10-02T12:30:00Z', '2026-10-02T12:30:00Z', '2026-10-02T18:30:00Z'],
  ['2026-10-02T18:29:59Z', '2026-10-02T12:30:00Z', '2026-10-02T18:30:00Z'],
  ['2026-10-02T18:30:00Z', '2026-10-02T18:30:00Z', '2026-10-03T12:30:00Z'],
])('uses inclusive latest and exclusive next slots at %s', (now, latest, next) => {
  expect(latestSlot(new Date(now), 'Asia/Kolkata')).toEqual(new Date(latest));
  expect(nextSlot(new Date(now), 'Asia/Kolkata')).toEqual(new Date(next));
});
it('uses calendar times across daylight saving changes', () => {
  expect(nextSlot(new Date('2026-03-08T05:00:00Z'), 'America/New_York')).toEqual(
    new Date('2026-03-08T22:00:00Z'),
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
