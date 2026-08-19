import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, parseText } from '../assets/parser.js';

const REF = new Date('2026-08-19T00:00:00');
const parse = (line, opts = {}) => {
  const r = parseLine(line, { reference: REF, ...opts });
  assert.ok(r.ok, `expected "${line}" to parse (${r.reason})`);
  return r.event;
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

test('a bare past date rolls forward to next year', () => {
  assert.equal(parse('Mar 3 Review').date, '2027-03-03');
  assert.equal(parse('Aug 25 Review').date, '2026-08-25');
  assert.equal(parse('Mar 3 Review', { rollForward: false }).date, '2026-03-03');
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
