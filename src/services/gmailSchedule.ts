import { CronExpressionParser } from 'cron-parser';
import { gmailScheduleConfig } from '../utils/config';
export const GMAIL_SCHEDULE_QUEUE = 'gmail-scheduled-sync-job';
export const GMAIL_SYNC_CRON = '0 0,18 * * *';
let registered = false;
export const isGmailScheduleRegistered = () => registered;
export const setGmailScheduleRegistered = (value: boolean) => {
  registered = value;
};
export function latestSlot(now: Date, timezone = gmailScheduleConfig().timezone) {
  return CronExpressionParser.parse(GMAIL_SYNC_CRON, {
    tz: timezone,
    currentDate: new Date(now.getTime() + 1),
  })
    .prev()
    .toDate();
}
export function nextSlot(now: Date, timezone = gmailScheduleConfig().timezone) {
  return CronExpressionParser.parse(GMAIL_SYNC_CRON, { tz: timezone, currentDate: now })
    .next()
    .toDate();
}
export function nextScheduledSyncAt(connected: boolean) {
  return connected && gmailScheduleConfig().enabled && registered
    ? nextSlot(new Date()).toISOString()
    : null;
}
