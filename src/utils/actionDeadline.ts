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
  \`^(?:\${monthPattern} (\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)? \${monthPattern})(?:,? (\\d{4}))?$\`,
);
type Rejected = Extract<ParsedDeadline, { deadline: null }>;
/**
 * A date read from the text, before it is checked against the day the email arrived. \`day\`: the
 * calendar day as written, when a time with an offset moved the deadline off it.
 */
type Candidate = {
  deadline: Date;
  precision: 'DATE' | 'DATETIME';
  weekday?: number;
  day?: Date;
};
/** A time read next to a written date. \`offset\`: minutes from UTC; null when its zone is unclear. */
type Clock = { ms: number; offset: number | null };

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

/**
 * \`2026-10-03\`, then an optional time after \`T\` or a space. Its zone counts when it is \`Z\`, \`UTC\`,
 * \`GMT\` or an offset; any other zone name is read as no zone.
 */
const isoDate =
  /^(\\d{4})-(\\d{2})-(\\d{2})(?:[t ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,3}))?)?(?: ?(z|utc|gmt|[+-]\\d{2}:\\d{2})| [a-z]{2,5})?)?$/;
const weekdayPrefix =
  /^(sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat),? /;
/**
 * A clock time: \`11:59 PM IST\`, \`5 pm\`, \`17:00\`, \`05:30:00 AM +0000 GMT\`. Groups: hour, minute,
 * second and a/p of a time with minutes; hour and a/p of one without; a written offset; a zone
 * name (never a month or a weekday), plain or in brackets.
 */
const clock = \`(?:(\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?: ?([ap])\\.?m\\.?)?|(\\d{1,2}) ?([ap])\\.?m\\.?)(?: ?([+-]\\d{2}:?\\d{2}))?(?: (?!(?:\${months.join('|')}|\${weekdays.join('|')}))([a-z]{2,5})| \\(([a-z]{2,5})\\))?\`;
/** A time after a written date: \`, 11:59 PM IST\`, \` at 5 pm\`, \` 17:00\`. */
const timeSuffix = new RegExp(\`,? (?:at )?\${clock}$\`);
/** A time before a written date: \`11:59 PM IST, \`, \`5 pm on \`. */
const timePrefix = new RegExp(\`^\${clock},? (?:on )?\`);
const endOfDay = '(?:end of (?:the )?day|eod)';
/** \`End of day, 7 Nov 2026\`: the date alone is the deadline. */
const endOfDayPrefix = new RegExp(\`^\${endOfDay},? (?:on )?\`);
const endOfDaySuffix = new RegExp(\`,? (?:by )?\${endOfDay}$\`);

/** Deliberately narrow grammar: provider prose is never passed to JavaScript's date parser. */
export function parseActionDeadline(
  text: string | null | undefined,
  receivedAt: Date | null,
): ParsedDeadline {
  if (!text?.trim()) return reject('EMPTY');
  const value = text.trim().replace(/\\s+/g, ' ').toLowerCase();
  const anchor = dayBefore(receivedAt);
  const iso = isoDate.exec(value);
  const parsed = iso ? parseIsoDeadline(iso) : parseNamedDeadline(value, anchor);
  if (parsed.deadline === null) return parsed;
  if (anchor && parsed.deadline < anchor) return reject('BEFORE_RECEIVED');
  if (
    parsed.weekday !== undefined &&
    (parsed.day ?? parsed.deadline).getUTCDay() !== parsed.weekday
  )
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

/** \`2026-10-03\`, optionally with a time. A time counts only when it names its zone. */
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

/** Minutes from UTC of \`Z\`, \`UTC\`, \`GMT\` or \`+05:30\`; null for anything else. */
function zoneOffsetMinutes(zone: string): number | null {
  if (zone === 'z' || zone === 'utc' || zone === 'gmt') return 0;
  if (!/^[+-]\\d{2}:\\d{2}$/.test(zone)) return null;
  const hours = +zone.slice(1, 3),
    minutes = +zone.slice(4, 6);
  if (hours > 23 || minutes > 59) return null;
  return (hours * 60 + minutes) * (zone[0] === '+' ? 1 : -1);
}

/** The hour of the day from a 24-hour clock, or a 12-hour one with AM or PM; null when it cannot exist. */
function hourOfDay(hour: number, half: string | undefined): number | null {
  if (!half) return hour <= 23 ? hour : null;
  if (hour < 1 || hour > 12) return null;
  return (hour % 12) + (half === 'p' ? 12 : 0);
}

/**
 * A time's zone as minutes from UTC: clear only as a written offset (\`+0000\`, \`+05:30\`) or as UTC
 * or GMT by name, else unclear (\`offset: null\`). null when the written offset cannot exist.
 */
function clockZone(written: string | undefined, name: string | undefined) {
  if (!written) return { offset: name === 'utc' || name === 'gmt' ? 0 : null };
  const offset = zoneOffsetMinutes(
    written.includes(':') ? written : \`\${written.slice(0, 3)}:\${written.slice(3)}\`,
  );
  return offset === null ? null : { offset };
}

/** The time a \`clock\` match names; null when the time or its offset cannot exist. */
function clockOf(time: RegExpExecArray): Clock | null {
  const minute = +(time[2] ?? 0),
    second = +(time[3] ?? 0);
  const hour = hourOfDay(+(time[1] ?? time[5]), time[4] ?? time[6]);
  const zone = clockZone(time[7], time[8] ?? time[9]);
  if (hour === null || zone === null || minute > 59 || second > 59) return null;
  return { ms: ((hour * 60 + minute) * 60 + second) * 1000, offset: zone.offset };
}

/**
 * The text without a time or "end of day" at its end, with that time; null when the time cannot
 * exist.
 */
function withoutTime(value: string): { text: string; clock: Clock | null } | null {
  const end = endOfDaySuffix.exec(value);
  if (end) return { text: value.slice(0, end.index), clock: null };
  const time = timeSuffix.exec(value);
  if (!time) return { text: value, clock: null };
  const clock = clockOf(time);
  return clock && { text: value.slice(0, time.index), clock };
}

/**
 * The text without a time or "end of day" before the date, whether one was there, and that time;
 * null when the time cannot exist.
 */
function withoutLeadingTime(
  value: string,
): { text: string; found: boolean; clock: Clock | null } | null {
  const end = endOfDayPrefix.exec(value);
  if (end) return { text: value.slice(end[0].length), found: true, clock: null };
  const time = timePrefix.exec(value);
  if (!time) return { text: value, found: false, clock: null };
  const clock = clockOf(time);
  return clock && { text: value.slice(time[0].length), found: true, clock };
}

/** The deadline on a written day: at its time when the zone is clear, else the day alone. */
function onDay(day: Date, clock: Clock | null): Pick<Candidate, 'deadline' | 'precision'> {
  if (!clock || clock.offset === null) return { deadline: day, precision: 'DATE' };
  return {
    deadline: new Date(day.getTime() + clock.ms - clock.offset * 60_000),
    precision: 'DATETIME',
  };
}

/**
 * \`by Friday, March 6\`, \`6 Mar 2026\`. Without a year, the next such date after the email. A time
 * before or after the date is kept only when its zone is clear (\`05:30:00 AM +0000 GMT\`,
 * \`17:00 UTC\`); any other time is allowed but dropped: like an ISO time without an offset, its
 * zone is unclear (IST is India, Israel or Ireland). "End of day" reads as the day alone.
 */
function parseNamedDeadline(value: string, anchor: Date | null): Candidate | Rejected {
  const lead = withoutLeadingTime(value.replace(/^by /, ''));
  if (lead === null) return reject('INVALID_DATE');
  let remainder = lead.text;
  let weekday: number | undefined;
  const prefix = weekdayPrefix.exec(remainder);
  if (prefix) {
    weekday = weekdays.indexOf(prefix[1].slice(0, 3));
    remainder = remainder.slice(prefix[0].length);
  }
  // One time per deadline: after a leading time only the date may follow.
  const tail = lead.found ? { text: remainder, clock: null } : withoutTime(remainder);
  if (tail === null) return reject('INVALID_DATE');
  const match = namedDate.exec(tail.text);
  if (!match) return reject('UNCLEAR');
  const day = writtenDate(match, anchor);
  return day instanceof Date ? { ...onDay(day, lead.clock ?? tail.clock), weekday, day } : day;
}

/** The day a \`namedDate\` match names; without a year, the next such day after the email. */
function writtenDate(match: RegExpExecArray, anchor: Date | null): Date | Rejected {
  const month = months.indexOf((match[1] ?? match[4]).slice(0, 3)) + 1;
  const day = +(match[2] ?? match[3]);
  let year = match[5] ? +match[5] : anchor?.getUTCFullYear();
  if (year === undefined) return reject('MISSING_ANCHOR');
  const alreadyPassed =
    anchor &&
    (month < anchor.getUTCMonth() + 1 ||
      (month === anchor.getUTCMonth() + 1 && day < anchor.getUTCDate()));
  if (!match[5] && alreadyPassed) year++;
  return calendarDate(year, month, day) ?? reject('INVALID_DATE');
}
