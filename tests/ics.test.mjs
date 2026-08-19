import test from 'node:test';
import assert from 'node:assert/strict';
import { buildICS, icsFilename } from '../assets/ics.js';

const STAMP = new Date('2026-08-19T12:00:00Z');
const timed = { title: 'Dentist', date: '2026-08-19', endDate: '2026-08-19', startTime: '15:00', endTime: '16:00', allDay: false };
const build = (events, opts = {}) => buildICS(events, { stamp: STAMP, ...opts });

test('wraps events in a valid calendar envelope', () => {
  const ics = build([timed], { calendarName: 'Work' });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.match(ics, /VERSION:2\.0/);
  assert.doesNotMatch(ics, /METHOD:/, 'no METHOD — the file is events to import, not a feed');
  assert.match(ics, /X-WR-CALNAME:Work/);
  assert.match(ics, /DTSTAMP:20260819T120000Z/);
  assert.equal(ics.split('BEGIN:VEVENT').length - 1, 1);
});

test('timed events use floating local times', () => {
  const ics = build([timed]);
  assert.match(ics, /DTSTART:20260819T150000\r\n/);
  assert.match(ics, /DTEND:20260819T160000\r\n/);
  assert.doesNotMatch(ics, /DTSTART:[^\r\n]*Z/);
});

test('all-day events use exclusive DATE ends', () => {
  const ics = build([{ title: 'Offsite', date: '2026-08-19', endDate: '2026-08-21', allDay: true }]);
  assert.match(ics, /DTSTART;VALUE=DATE:20260819/);
  assert.match(ics, /DTEND;VALUE=DATE:20260822/);
});

test('an end at or before the start is pushed out by an hour', () => {
  const ics = build([{ ...timed, endTime: '15:00' }]);
  assert.match(ics, /DTEND:20260819T160000/);
});

test('an event ending past midnight rolls onto the next day', () => {
  const ics = build([{ ...timed, startTime: '23:30', endTime: '23:30' }]);
  assert.match(ics, /DTEND:20260820T003000/);
});

test('special characters are escaped', () => {
  const ics = build([{ ...timed, title: 'Lunch; with Sam, then', location: 'Bar\\Grill', notes: 'line1\nline2' }]);
  assert.match(ics, /SUMMARY:Lunch\; with Sam\\, then/);
  assert.match(ics, /LOCATION:Bar\\\\Grill/);
  assert.match(ics, /DESCRIPTION:line1\\nline2/);
});

test('an alarm is added when requested, omitted otherwise', () => {
  assert.match(build([timed], { alarmMinutes: 30 }), /BEGIN:VALARM[\s\S]*TRIGGER:-PT30M[\s\S]*END:VALARM/);
  assert.doesNotMatch(build([timed]), /VALARM/);
});

test('long lines fold at 75 octets with a leading space', () => {
  const ics = build([{ ...timed, title: 'x'.repeat(200) }]);
  for (const line of ics.split('\r\n')) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `line too long: ${line.length}`);
  }
  assert.match(ics, /\r\n [x]/);
});

test('every event gets a unique UID', () => {
  const ics = build([timed, timed, timed]);
  const uids = [...ics.matchAll(/UID:(.+)\r\n/g)].map((m) => m[1]);
  assert.equal(new Set(uids).size, 3);
});

test('filenames are safe', () => {
  assert.equal(icsFilename('Work / Personal!'), 'work-personal.ics');
  assert.equal(icsFilename(''), 'events.ics');
});
