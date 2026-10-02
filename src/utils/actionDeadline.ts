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
const reject = (reason: Extract<ParsedDeadline, { deadline: null }>['reason']): ParsedDeadline => ({
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

/** Deliberately narrow grammar: provider prose is never passed to JavaScript's date parser. */
export function parseActionDeadline(
  text: string | null | undefined,
  receivedAt: Date | null,
): ParsedDeadline {
  if (!text?.trim()) return reject('EMPTY');
  const value = text.trim().replace(/\s+/g, ' ').toLowerCase();
  const anchor =
    receivedAt && Number.isFinite(receivedAt.getTime())
      ? calendarDate(
          receivedAt.getUTCFullYear(),
          receivedAt.getUTCMonth() + 1,
          receivedAt.getUTCDate(),
        )!
      : null;
  if (anchor) anchor.setUTCDate(anchor.getUTCDate() - 1);
  let deadline: Date;
  let precision: 'DATE' | 'DATETIME' = 'DATE';
  let weekday: number | undefined;
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:t(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(z|[+-]\d{2}:\d{2})?)?$/.exec(
      value,
    );
  if (iso) {
    const date = calendarDate(+iso[1], +iso[2], +iso[3]);
    if (!date) return reject('INVALID_DATE');
    deadline = date;
    if (iso[4] !== undefined) {
      const hour = +iso[4],
        minute = +iso[5],
        second = +(iso[6] ?? 0);
      if (hour > 23 || minute > 59 || second > 59) return reject('INVALID_DATE');
      const zone = iso[8];
      if (zone) {
        let offset = 0;
        if (zone !== 'z') {
          const hours = +zone.slice(1, 3),
            minutes = +zone.slice(4, 6);
          if (hours > 23 || minutes > 59) return reject('INVALID_DATE');
          offset = (hours * 60 + minutes) * (zone[0] === '+' ? 1 : -1);
        }
        deadline = new Date(
          date.getTime() +
            (hour * 60 + minute - offset) * 60_000 +
            second * 1000 +
            +(iso[7] ?? '').padEnd(3, '0'),
        );
        precision = 'DATETIME';
      }
    }
  } else {
    let remainder = value.replace(/^by /, '');
    const prefix =
      /^(sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat),? /.exec(
        remainder,
      );
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
    if (
      !match[5] &&
      anchor &&
      (month < anchor.getUTCMonth() + 1 ||
        (month === anchor.getUTCMonth() + 1 && day < anchor.getUTCDate()))
    )
      year++;
    const date = calendarDate(year, month, day);
    if (!date) return reject('INVALID_DATE');
    deadline = date;
  }
  if (anchor && deadline < anchor) return reject('BEFORE_RECEIVED');
  if (weekday !== undefined && deadline.getUTCDay() !== weekday) return reject('WEEKDAY_MISMATCH');
  return { deadline, precision, reason: null };
}
