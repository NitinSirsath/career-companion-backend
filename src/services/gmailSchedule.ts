import { CronExpressionParser } from 'cron-parser';
export const GMAIL_SCHEDULE_QUEUE = 'gmail-scheduled-sync-job';
export const GMAIL_SYNC_CRON = '0 0,18 * * *';
export function parseGmailSchedule(env: NodeJS.ProcessEnv) {
  const enabled = env.GMAIL_SCHEDULED_SYNC_ENABLED ?? 'true';
  if (!['true', 'false'].includes(enabled))
    throw new Error('GMAIL_SCHEDULED_SYNC_ENABLED must be true or false');
  const timezone = env.GMAIL_SCHEDULED_SYNC_TZ ?? 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error('GMAIL_SCHEDULED_SYNC_TZ must be a valid IANA timezone');
  }
  return { enabled: enabled === 'true', timezone };
}
let config: ReturnType<typeof parseGmailSchedule> | undefined;
export const gmailScheduleConfig = () => (config ??= parseGmailSchedule(process.env));
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
