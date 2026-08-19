import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, parseText } from '../assets/parser.js';

const REF = new Date('2026-08-19T00:00:00');
/** The single event a line is expected to produce. */
const parse = (line, opts = {}) => {
  const events = parseAll(line, opts);
  assert.equal(events.length, 1, `expected one event from "${line}", got ${events.length}`);
  return events[0];
};

/** Every event a line produces. */
const parseAll = (line, opts = {}) => {
  const r = parseLine(line, { reference: REF, ...opts });
  assert.ok(r.ok, `expected "${line}" to parse (${r.reason})`);
  return r.events;
};

test('ISO date with a 12-hour time', () => {
  const e = parse('2026-08-19 3pm Dentist');
  assert.equal(e.date, '2026-08-19');
  assert.equal(e.startTime, '15:00');
  assert.equal(e.endTime, '16:00');
  assert.equal(e.title, 'Dentist');
});

test('month name, year and a time range', () => {
  const e = parse('Aug 19, 2026 3-4:30pm Team sync');
  assert.deepEqual([e.date, e.startTime, e.endTime], ['2026-08-19', '15:00', '16:30']);
});

test('day-first month name is not confused by a 24h time', () => {
  const e = parse('19 Aug 09:00 Standup');
  assert.deepEqual([e.date, e.startTime, e.title], ['2026-08-19', '09:00', 'Standup']);
});

test('bare hour range reads as a working day', () => {
  const e = parse('3/4 9-5 Workshop');
  assert.deepEqual([e.startTime, e.endTime], ['09:00', '17:00']);
});

test('date order setting decides ambiguous numeric dates', () => {
  assert.equal(parse('3/4 Lunch', { dateOrder: 'MDY' }).date, '2027-03-04');
  assert.equal(parse('3/4 Lunch', { dateOrder: 'DMY' }).date, '2027-04-03');
  assert.equal(parse('19/8/2026 Lunch', { dateOrder: 'MDY' }).date, '2026-08-19', 'unambiguous wins over the setting');
  assert.equal(parse('1.9.2026 Review').date, '2026-09-01', 'dotted dates are day-first');
});

test('multi-day ranges become all-day spans', () => {
  const e = parse('Aug 19-21 Offsite');
  assert.deepEqual([e.date, e.endDate, e.allDay], ['2026-08-19', '2026-08-21', true]);
});

test('a range crossing new year rolls the end year', () => {
  const e = parse('Dec 28 - Jan 3 Holiday');
  assert.deepEqual([e.date, e.endDate], ['2026-12-28', '2027-01-03']);
});

test('a date with no year is this year unless it has gone', () => {
  assert.equal(parse('Aug 25 Review').date, '2026-08-25', 'still to come this year');
  assert.equal(parse('Dec 1 Review').date, '2026-12-01');
  assert.equal(parse('Feb 3 Ski trip').date, '2027-02-03', 'February 2026 has passed');
  assert.equal(parse('Aug 18 Review').date, '2027-08-18', 'yesterday means next year');
  assert.equal(parse('Aug 19 Review').date, '2026-08-19', 'today stays today');
  assert.equal(parse('Mar 3 Review', { rollForward: false }).date, '2026-03-03', 'switched off');
  assert.equal(parse('Feb 3 2026 Ski trip').date, '2026-02-03', 'a written year always wins');
});

test('all-day keyword, location and notes', () => {
  const e = parse('19/08/2026 all day Conference @ Barbican // bring badge', { dateOrder: 'DMY' });
  assert.equal(e.allDay, true);
  assert.equal(e.title, 'Conference');
  assert.equal(e.location, 'Barbican');
  assert.equal(e.notes, 'bring badge');
});

test('noon and midnight', () => {
  assert.equal(parse('12/25/2026 noon Christmas lunch').startTime, '12:00');
  assert.equal(parse('12/31/2026 midnight Fireworks').startTime, '00:00');
});

test('weekday names and filler words are stripped from the title', () => {
  assert.equal(parse('Mon 24 Aug at 10am Coffee with Sam').title, 'Coffee with Sam');
});

test('tab-separated paste from a spreadsheet', () => {
  const { events } = parseText('2026-09-01\tKickoff\t10am\n2026-09-02\tRetro\t2pm', { reference: REF });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.title), ['Kickoff', 'Retro']);
  assert.deepEqual(events.map((e) => e.startTime), ['10:00', '14:00']);
});

test('lines without a date are reported, blanks and comments ignored', () => {
  const { events, skipped } = parseText('# my list\n\nno date here\n2026-09-01 Kickoff', { reference: REF });
  assert.equal(events.length, 1);
  assert.deepEqual(skipped, [{ raw: 'no date here', reason: 'No date found' }]);
});

test('a date with no title still yields an event', () => {
  assert.equal(parse('2026-09-01').title, 'Untitled event');
});

test('custom default time and duration', () => {
  const e = parse('2026-09-01 Kickoff', { defaultTime: '08:30', defaultDuration: 90 });
  assert.deepEqual([e.startTime, e.endTime], ['08:30', '10:00']);
});

test('an event running past midnight ends the next day', () => {
  const e = parse('Sep 3 22:00-01:00 Party');
  assert.deepEqual([e.date, e.endDate, e.startTime, e.endTime], ['2026-09-03', '2026-09-04', '22:00', '01:00']);
});

test('several days on one line share the month and the title', () => {
  const events = parseAll('Oct 26,27,28 Soccer practice');
  assert.deepEqual(events.map((e) => e.date), ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.deepEqual([...new Set(events.map((e) => e.title))], ['Soccer practice']);
  assert.ok(events.every((e) => e.endDate === e.date && !e.allDay));
});

test('a numeric date carries its month across the list', () => {
  assert.deepEqual(parseAll('10/26,27,28 Soccer').map((e) => e.date),
    ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.deepEqual(parseAll('26/10, 27, 28 Soccer', { dateOrder: 'DMY' }).map((e) => e.date),
    ['2026-10-26', '2026-10-27', '2026-10-28']);
});

test('day lists accept spaces, ampersands, "and" and ordinals', () => {
  const expected = ['2026-10-26', '2026-10-27', '2026-10-28'];
  assert.deepEqual(parseAll('Oct 26, 27 & 28 Fair').map((e) => e.date), expected);
  assert.deepEqual(parseAll('Oct 26th, 27th and 28th Fair').map((e) => e.date), expected);
  assert.deepEqual(parseAll('26, 27 and 28 Oct Fair').map((e) => e.date), expected);
});

test('a time applies to every date in the list', () => {
  const events = parseAll('Oct 26,27,28 3-4:30pm Practice @ Gym');
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.startTime === '15:00' && e.endTime === '16:30' && e.location === 'Gym'));
});

test('a trailing year applies to the whole list', () => {
  assert.deepEqual(parseAll('Oct 26, 27, 28, 2028 Soccer').map((e) => e.date),
    ['2028-10-26', '2028-10-27', '2028-10-28']);
});

test('a comma before a year or a time is not a day list', () => {
  assert.equal(parse('Oct 26, 2026 Dentist').date, '2026-10-26');
  const dentist = parse('Sep 3, 4pm Dentist');
  assert.deepEqual([dentist.date, dentist.startTime], ['2026-09-03', '16:00']);
});

test('a list wrapping into January climbs a year', () => {
  assert.deepEqual(parseAll('Dec 30, Jan 2 Party').map((e) => e.date), ['2026-12-30', '2027-01-02']);
});

test('two full dates on one line make two events', () => {
  assert.deepEqual(parseAll('10/26, 11/2 Two things').map((e) => e.date), ['2026-10-26', '2026-11-02']);
  assert.deepEqual(parseAll('Oct 26 and Nov 2 Two things').map((e) => e.date), ['2026-10-26', '2026-11-02']);
});

test('a dash still means one event over several days', () => {
  const events = parseAll('Oct 26-28 Half term');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].date, events[0].endDate, events[0].allDay], ['2026-10-26', '2026-10-28', true]);
});

test('a list of dates in a paste is flattened', () => {
  const { events } = parseText('Oct 26,27,28 Soccer\nNov 3 Dentist', { reference: REF });
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.raw).filter((r) => r.startsWith('Oct')).length, 3);
});

test('every event gets its own id', () => {
  const events = parseAll('Oct 26,27,28 Soccer');
  assert.equal(new Set(events.map((e) => e.id)).size, 3);
});

test('a conjunction between two dates is not left in the title', () => {
  assert.deepEqual([...new Set(parseAll('Meeting 3/4 and 3/5').map((e) => e.title))], ['Meeting']);
  assert.deepEqual([...new Set(parseAll('Oct 26 & Nov 2 Party').map((e) => e.title))], ['Party']);
  assert.equal(parse('Sep 3 Fish and chips').title, 'Fish and chips', 'a real "and" survives');
});
