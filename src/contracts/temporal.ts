import { z } from 'zod';

export const CalendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Use a valid calendar date');
export const TemporalInputSchema = z.strictObject({
  date: z.string().max(10).nullable(),
  time: z.string().max(5).nullable(),
  sourceTimeZone: z.string().max(100).nullable(),
});
export type TemporalInput = z.infer<typeof TemporalInputSchema>;
export const TemporalValueSchema = z.object({
  precision: z.enum(['DATE', 'DATETIME', 'UNRESOLVED']),
  date: CalendarDateSchema.nullable(),
  instant: z.iso.datetime().nullable(),
  time: z.string().nullable(),
  sourceTimeZone: z.string().nullable(),
});
export type TemporalValue = z.infer<typeof TemporalValueSchema>;

/** Source facts only: a display timezone is never a source timezone. Enumerating the actual
 * offsets on either side rejects DST folds (two instants) and gaps (zero instants). */
export function resolveTemporal(input: TemporalInput): TemporalValue {
  const unresolved: TemporalValue = {
    precision: 'UNRESOLVED',
    date: null,
    instant: null,
    time: input.time,
    sourceTimeZone: input.sourceTimeZone,
  };
  if (!input.date || !CalendarDateSchema.safeParse(input.date).success) return unresolved;
  if (!input.time) return { ...unresolved, precision: 'DATE', date: input.date };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time) || !input.sourceTimeZone) return unresolved;
  const local = Date.parse(`${input.date}T${input.time}:00.000Z`);
  const zone = input.sourceTimeZone;
  if (/^(Z|UTC|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(zone)) {
    if (/^[+-]14:/.test(zone) && !zone.endsWith(':00')) return unresolved;
    const offset =
      zone === 'Z' || zone === 'UTC'
        ? 0
        : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) * (zone[0] === '+' ? 1 : -1);
    return {
      ...input,
      precision: 'DATETIME',
      instant: new Date(local - offset * 60000).toISOString(),
    };
  }
  if (!zone.includes('/')) return unresolved;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const wall = (epoch: number) => {
      const p = Object.fromEntries(
        formatter.formatToParts(new Date(epoch)).map((part) => [part.type, part.value]),
      );
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    };
    const offsets = new Set<number>();
    for (let hours = -36; hours <= 36; hours += 6) {
      const probe = local + hours * 3600000;
      offsets.add(Date.parse(`${wall(probe)}:00Z`) - probe);
    }
    const matches = [...offsets]
      .map((offset) => local - offset)
      .filter((epoch) => wall(epoch) === `${input.date}T${input.time}`);
    if (matches.length !== 1) return unresolved;
    return { ...input, precision: 'DATETIME', instant: new Date(matches[0]).toISOString() };
  } catch {
    return unresolved;
  }
}
