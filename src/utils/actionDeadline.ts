export type ParsedDeadline =
  | { deadline: Date; precision: 'DATE' | 'DATETIME'; reason: null }
  | {
      deadline: null;
      precision: null;
      reason:
        | 'EMPTY'
        | 'UNCLEAR'
        | 'INVALID_DATE'
        | 'MISSING_ANCHOR'
        | 'BEFORE_RECEIVED'
        | 'WEEKDAY_MISMATCH';
    };

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const monthPattern =
  '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec)\\.?';
const namedDate = new RegExp(
  `^(?:${monthPattern} (\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)? ${monthPattern})(?:,? (\\d{4}))?$`,
);
type Rejected = Extract<ParsedDeadline, { deadline: null }>;
/** A date read from the text, before it is checked against the day the email arrived. */
type Candidate = { deadline: Date; precision: 'DATE' | 'DATETIME'; weekday?: number };

const reject = (reason: Rejected['reason']): Rejected => ({
  deadline: null,
  precision: null,
  reason,
});
function calendarDate(year: number, month: number, day: number): Date | null {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

const isoDate =
  /^(\d{4})-(\d{2})-(\d{2})(?:t(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(z|[+-]\d{2}:\d{2})?)?$/;
const weekdayPrefix =
  /^(sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat),? /;

/** Deliberately narrow grammar: provider prose is never passed to JavaScript's date parser. */
export function parseActionDeadline(
  text: string | null | undefined,
  receivedAt: Date | null,
): ParsedDeadline {
  if (!text?.trim()) return reject('EMPTY');
  const value = text.trim().replace(/\s+/g, ' ').toLowerCase();
  const anchor = dayBefore(receivedAt);
  const iso = isoDate.exec(value);
  const parsed = iso ? parseIsoDeadline(iso) : parseNamedDeadline(value, anchor);
  if (parsed.deadline === null) return parsed;
  if (anchor && parsed.deadline < anchor) return reject('BEFORE_RECEIVED');
  if (parsed.weekday !== undefined && parsed.deadline.getUTCDay() !== parsed.weekday)
    return reject('WEEKDAY_MISMATCH');
  return { deadline: parsed.deadline, precision: parsed.precision, reason: null };
}

/** The earliest day a deadline may fall on: one day of slack for the sender's time zone. */
function dayBefore(receivedAt: Date | null): Date | null {
  if (!receivedAt || !Number.isFinite(receivedAt.getTime())) return null;
  const anchor = new Date(0);
  anchor.setUTCFullYear(
    receivedAt.getUTCFullYear(),
    receivedAt.getUTCMonth(),
    receivedAt.getUTCDate() - 1,
  );
  return anchor;
}

/** `2026-10-03`, optionally with a time. A time counts only when it names its zone. */
function parseIsoDeadline(iso: RegExpExecArray): Candidate | Rejected {
  const date = calendarDate(+iso[1], +iso[2], +iso[3]);
  if (!date) return reject('INVALID_DATE');
  if (iso[4] === undefined) return { deadline: date, precision: 'DATE' };
  const hour = +iso[4],
    minute = +iso[5],
    second = +(iso[6] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return reject('INVALID_DATE');
  const zone = iso[8];
  if (!zone) return { deadline: date, precision: 'DATE' };
  const offset = zoneOffsetMinutes(zone);
  if (offset === null) return reject('INVALID_DATE');
  const deadline = new Date(
    date.getTime() +
      (hour * 60 + minute - offset) * 60_000 +
      second * 1000 +
      +(iso[7] ?? '').padEnd(3, '0'),
  );
  return { deadline, precision: 'DATETIME' };
}

function zoneOffsetMinutes(zone: string): number | null {
  if (zone === 'z') return 0;
  const hours = +zone.slice(1, 3),
    minutes = +zone.slice(4, 6);
  if (hours > 23 || minutes > 59) return null;
  return (hours * 60 + minutes) * (zone[0] === '+' ? 1 : -1);
}

/** `by Friday, March 6`, `6 Mar 2026`. Without a year, the next such date after the email. */
function parseNamedDeadline(value: string, anchor: Date | null): Candidate | Rejected {
  let remainder = value.replace(/^by /, '');
  let weekday: number | undefined;
  const prefix = weekdayPrefix.exec(remainder);
  if (prefix) {
    weekday = weekdays.indexOf(prefix[1].slice(0, 3));
    remainder = remainder.slice(prefix[0].length);
  }
  const match = namedDate.exec(remainder);
  if (!match) return reject('UNCLEAR');
  const month = months.indexOf((match[1] ?? match[4]).slice(0, 3)) + 1;
  const day = +(match[2] ?? match[3]);
  let year = match[5] ? +match[5] : anchor?.getUTCFullYear();
  if (year === undefined) return reject('MISSING_ANCHOR');
  const alreadyPassed =
    anchor &&
    (month < anchor.getUTCMonth() + 1 ||
      (month === anchor.getUTCMonth() + 1 && day < anchor.getUTCDate()));
  if (!match[5] && alreadyPassed) year++;
  const date = calendarDate(year, month, day);
  if (!date) return reject('INVALID_DATE');
  return { deadline: date, precision: 'DATE', weekday };
}
