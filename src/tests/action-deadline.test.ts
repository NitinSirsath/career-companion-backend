import { describe, expect, it } from 'vitest';
import { parseActionDeadline } from '../utils/actionDeadline';
const received = new Date('2026-11-12T10:00:00Z');
describe('action deadlines anchored to the email', () => {
  it.each([
    '2026-11-20',
    'Nov 20',
    'November 20',
    '20 November',
    '20th Nov',
    'Nov. 20th',
    'by Nov 20',
    'Friday, November 20',
    'Nov 20, 2026',
    '2026-11-20T17:00:00',
    ' BY   NOV 20 ',
    'Nov 20 at 5 PM',
    'Nov 20 at 5 p.m.',
    'Nov 20, 11:59 PM IST',
    'Friday, November 20, 5:30pm (IST)',
    '20 November 2026 17:00',
    'by Nov 20, 2026 at 5:30 pm',
  ])('accepts %s as a calendar date', (text) => {
    expect(parseActionDeadline(text, received)).toEqual({
      deadline: new Date('2026-11-20T00:00:00Z'),
      precision: 'DATE',
      reason: null,
    });
  });
  it.each([
    '2026-02-30',
    '2026-13-01',
    '2026-11-20T25:00:00Z',
    '2026-11-20T17:60:00',
    '2026-11-20T17:00:00+25:00',
    'Thursday, November 20',
    'Nov 20, 2024',
    '2001-11-10',
    'by Friday',
    'Friday',
    'next Monday',
    'tomorrow',
    'ASAP',
    '10/11',
    '10/11/2026',
    '25/11/2026',
    '11.10.2026',
    'November',
    '2026',
    'Nov 32',
    '20 de noviembre',
    '',
    ' ',
    null,
  ])('rejects %s', (text) => {
    expect(parseActionDeadline(text, received).deadline).toBeNull();
  });
  it.each([
    ['Nov 10', '2026-11-12', '2027-11-10'],
    ['Nov 11', '2026-11-12', '2026-11-11'],
    ['Jan 5', '2026-12-20', '2027-01-05'],
    ['Feb 29', '2027-12-01', '2028-02-29'],
    ['Dec 31', '2027-01-01', '2026-12-31'],
  ])('infers %s from %s', (text, anchor, expected) => {
    expect(parseActionDeadline(text, new Date(anchor)).deadline?.toISOString()).toBe(
      expected + 'T00:00:00.000Z',
    );
  });
  it('does not skip years to invent a leap-day deadline', () =>
    expect(parseActionDeadline('Feb 29', new Date('2026-03-01')).deadline).toBeNull());
  it('requires receivedAt only for year inference', () => {
    expect(parseActionDeadline('Nov 20', null).deadline).toBeNull();
    expect(parseActionDeadline('Nov 20, 2024', null).deadline?.toISOString()).toBe(
      '2024-11-20T00:00:00.000Z',
    );
  });
  it('reads the date of a deadline written with a time (17 Oct 2026 full-flow test)', () => {
    expect(
      parseActionDeadline(
        'Friday, 30 October 2026, 11:59 PM IST',
        new Date('2026-10-17T09:24:00Z'),
      ),
    ).toEqual({ deadline: new Date('2026-10-30T00:00:00Z'), precision: 'DATE', reason: null });
  });
  it.each([
    ['30 October 2026, 25:00', 'INVALID_DATE'],
    ['Nov 20, 17:60', 'INVALID_DATE'],
    ['Nov 20, 13 PM', 'INVALID_DATE'],
    ['Nov 20 at 0 am', 'INVALID_DATE'],
    ['30 October 2026, 11', 'UNCLEAR'],
    ['Nov 20 at noon', 'UNCLEAR'],
    ['Thursday, November 20, 5 PM', 'WEEKDAY_MISMATCH'],
  ])('rejects the date and time %s as %s', (text, reason) => {
    expect(parseActionDeadline(text, received)).toEqual({
      deadline: null,
      precision: null,
      reason,
    });
  });
  it.each([
    ['2026-11-20T17:00:00Z', '2026-11-20T17:00:00.000Z'],
    ['2026-11-20T17:00:00+05:30', '2026-11-20T11:30:00.000Z'],
  ])('keeps explicit-zone %s', (text, expected) => {
    expect(parseActionDeadline(text, received)).toEqual({
      deadline: new Date(expected),
      precision: 'DATETIME',
      reason: null,
    });
  });
});
