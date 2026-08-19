/*
 * parser.js — turns pasted free-form text into calendar events.
 *
 * Each line is scanned left to right for every date it mentions, then for a
 * time; whatever text is left over becomes the title shared by those dates.
 * So "Oct 26,27,28 Soccer" is three events and "Oct 2-5 Lisbon" is one.
 * No DOM access in here, so it can be unit-tested with `node --test`.
 */

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const ORD = '(?:st|nd|rd|th)?';
const DASH = '(?:-|–|—|to|until|through|thru|›|→)';
// A day number must not run into a time: not "Aug 09:00", not "Sep 3, 4pm".
const NOT_TIME = '(?![\\d:])(?!\\s*[ap]\\.?m\\b)';
// What separates the days in "Oct 26, 27 & 28".
const LIST_SEP = '(?:\\s*[,&+]\\s*|\\s+and\\s+)';
const LIST_ITEM = `${LIST_SEP}\\d{1,2}${ORD}${NOT_TIME}`;
const WEEKDAYS = /\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(day|sday|nesday|rsday|urday)?\b\.?/gi;

export const DEFAULTS = {
  dateOrder: 'MDY',        // how to read 3/4 — 'MDY' (US) or 'DMY'
  defaultTime: '09:00',    // used when a line has a date but no time
  defaultDuration: 60,     // minutes
  rollForward: true,       // a date with no year that has passed means next year
  reference: null,         // Date used as "today" (tests inject this)
};

const pad = (n) => String(n).padStart(2, '0');
const clampDay = (y, m, d) => Math.min(Math.max(d, 1), new Date(y, m, 0).getDate());
const makeDate = ({ y, m, d }) => new Date(y, m - 1, clampDay(y, m, d));

function nextDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** ISO yyyy-mm-dd for a {y,m,d} triple. */
export function toISODate({ y, m, d }) {
  return `${y}-${pad(m)}-${pad(clampDay(y, m, d))}`;
}

function fullYear(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (raw.length <= 2) return n + (n < 70 ? 2000 : 1900);
  return n;
}

/** Pull every 1-2 digit day out of a list tail like ", 27th & 28". */
const daysIn = (tail) => [...(tail || '').matchAll(/\d{1,2}/g)].map((m) => +m[0]);

/* ------------------------------------------------------------------ dates */

/*
 * Every matcher returns a group: one or more {y?,m,d} dates, and `range` when
 * the two dates are the ends of a single span rather than separate days.
 * Order matters — the first matcher to match at the earliest position wins, so
 * list and range forms are tried before the plain single date they contain.
 */
const DATE_MATCHERS = [
  { // 2026-08-19 to 2026-08-21
    re: new RegExp(`\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\s*${DASH}\\s*(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b`, 'i'),
    build: (m) => ({ dates: [{ y: +m[1], m: +m[2], d: +m[3] }, { y: +m[4], m: +m[5], d: +m[6] }], range: true }),
  },
  { // 2026-08-19
    re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/,
    build: (m) => ({ dates: [{ y: +m[1], m: +m[2], d: +m[3] }] }),
  },
  { // Oct 26, 27 & 28   /   October 26,27,28, 2026
    re: new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})${ORD}${NOT_TIME}((?:${LIST_ITEM})+)(?:\\s*,?\\s*(\\d{4}))?\\b`, 'i'),
    build: (m) => {
      const month = MONTHS[m[1].toLowerCase().replace('.', '')];
      const year = m[4] ? +m[4] : null;
      return { dates: [+m[2], ...daysIn(m[3])].map((d) => ({ y: year, m: month, d })) };
    },
  },
  { // 26, 27 & 28 Oct 2026
    re: new RegExp(`\\b(\\d{1,2})${ORD}${NOT_TIME}((?:${LIST_ITEM})+)\\s+${MON}\\.?(?:\\s*,?\\s*(\\d{4}))?\\b`, 'i'),
    build: (m) => {
      const month = MONTHS[m[3].toLowerCase().replace('.', '')];
      const year = m[4] ? +m[4] : null;
      return { dates: [+m[1], ...daysIn(m[2])].map((d) => ({ y: year, m: month, d })) };
    },
  },
  { // Aug 19 - Sep 2, 2026   /   August 19-21
    re: new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})${ORD}\\s*${DASH}\\s*(?:${MON}\\.?\\s+)?(\\d{1,2})${ORD}(?:\\s*,?\\s*(\\d{4}))?\\b`, 'i'),
    build: (m) => {
      const y = m[5] ? +m[5] : null;
      const m1 = MONTHS[m[1].toLowerCase().replace('.', '')];
      const m2 = m[3] ? MONTHS[m[3].toLowerCase().replace('.', '')] : m1;
      return { dates: [{ y, m: m1, d: +m[2] }, { y, m: m2, d: +m[4] }], range: true };
    },
  },
  { // 19-21 Aug 2026
    re: new RegExp(`\\b(\\d{1,2})${ORD}\\s*${DASH}\\s*(\\d{1,2})${ORD}\\s+${MON}\\.?(?:\\s*,?\\s*(\\d{4}))?\\b`, 'i'),
    build: (m) => {
      const y = m[4] ? +m[4] : null;
      const mo = MONTHS[m[3].toLowerCase().replace('.', '')];
      return { dates: [{ y, m: mo, d: +m[1] }, { y, m: mo, d: +m[2] }], range: true };
    },
  },
  { // Aug 19, 2026  /  Aug 19  /  August 19th
    re: new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})${ORD}${NOT_TIME}(?:\\s*,?\\s*(\\d{4}))?\\b`, 'i'),
    build: (m) => ({
      dates: [{ y: m[3] ? +m[3] : null, m: MONTHS[m[1].toLowerCase().replace('.', '')], d: +m[2] }],
    }),
  },
  { // 19 Aug 2026  /  19th of August
    re: new RegExp(`\\b(\\d{1,2})${ORD}(?:\\s+of)?\\s+${MON}\\.?${NOT_TIME}(?:\\s*,?\\s*(\\d{4}))?\\b`, 'i'),
    build: (m) => ({
      dates: [{ y: m[3] ? +m[3] : null, m: MONTHS[m[2].toLowerCase().replace('.', '')], d: +m[1] }],
    }),
  },
  { // 10/26, 27, 28 — the month carries across the list
    re: new RegExp(`\\b(\\d{1,2})([\\/.])(\\d{1,2})(?![\\/.\\d])((?:${LIST_SEP}\\d{1,2}(?!\\s*[\\/.]\\s*\\d)${NOT_TIME})+)`, 'i'),
    build: (m, order) => {
      const first = numeric(m[1], m[3], null, order, m[2]);
      return { dates: [first, ...daysIn(m[4]).map((d) => ({ y: null, m: first.m, d }))] };
    },
  },
  { // 8/19/2026 - 8/21/2026   /   8/19 - 8/21
    re: new RegExp(`\\b(\\d{1,2})([\\/.])(\\d{1,2})(?:\\2(\\d{2,4}))?\\s*${DASH}\\s*(\\d{1,2})\\2(\\d{1,2})(?:\\2(\\d{2,4}))?\\b`, 'i'),
    build: (m, order) => ({
      dates: [numeric(m[1], m[3], m[4], order, m[2]), numeric(m[5], m[6], m[7] ?? m[4], order, m[2])],
      range: true,
    }),
  },
  { // 8/19/2026  /  19.8.2026  /  8/19
    re: /\b(\d{1,2})([\/.])(\d{1,2})(?:\2(\d{2,4}))?\b/,
    build: (m, order) => ({ dates: [numeric(m[1], m[3], m[4], order, m[2])] }),
  },
];

function numeric(first, second, year, order, separator) {
  let mo, d;
  // 1.9.2026 is day-first everywhere the dot form is used.
  if (separator === '.') order = 'DMY';
  if (+first > 12) { d = +first; mo = +second; }        // 19/8 can only be D/M
  else if (+second > 12) { mo = +first; d = +second; }  // 8/19 can only be M/D
  else if (order === 'DMY') { d = +first; mo = +second; }
  else { mo = +first; d = +second; }
  return { y: fullYear(year), m: mo, d };
}

const plausible = (group) =>
  group?.dates?.length && group.dates.every(({ m, d }) => m >= 1 && m <= 12 && d >= 1 && d <= 31);

/** The first matcher to match earliest in `text` wins. */
function matchDate(text, opts) {
  let best = null;
  for (const matcher of DATE_MATCHERS) {
    const m = matcher.re.exec(text);
    if (!m) continue;
    const group = matcher.build(m, opts.dateOrder);
    if (!plausible(group)) continue;
    if (!best || m.index < best.index) best = { group, index: m.index, length: m[0].length };
  }
  return best;
}

/** Every date mentioned in the line, in the order they appear. */
function findDates(text, opts) {
  const groups = [];
  const spans = [];
  let cursor = 0;
  while (cursor < text.length && groups.length < 50) {
    const found = matchDate(text.slice(cursor), opts);
    if (!found) break;
    groups.push(found.group);
    spans.push({ index: cursor + found.index, length: found.length });
    cursor += found.index + found.length;
  }
  return { groups, spans };
}

/*
 * Fill in the missing years. A date with no year is this year, unless it has
 * already gone — then it is next year. Dates keep the order they were written
 * in, so "Dec 30, Jan 2" lands in consecutive years.
 */
function resolveYears(groups, opts) {
  const today = opts.reference ? new Date(opts.reference) : new Date();
  today.setHours(0, 0, 0, 0);
  let previous = null;

  return groups.map((group) => ({
    ...group,
    dates: group.dates.map((part) => {
      let resolved = { ...part };
      if (resolved.y == null) {
        resolved.y = today.getFullYear();
        if (opts.rollForward && makeDate(resolved) < today) resolved.y += 1;
        if (previous && makeDate(resolved) < previous) resolved.y += 1;
      }
      previous = makeDate(resolved);
      return resolved;
    }),
  }));
}

/* ------------------------------------------------------------------ times */

const MERIDIEM = '(a\\.?m\\.?|p\\.?m\\.?)';
const TIME_RANGE = new RegExp(
  `\\b(\\d{1,2})(?::(\\d{2}))?\\s*${MERIDIEM}?\\s*${DASH}\\s*(\\d{1,2})(?::(\\d{2}))?\\s*${MERIDIEM}?(?![\\d:])`, 'i');
const TIME_SINGLE = new RegExp(`\\b(\\d{1,2})(?::(\\d{2}))?\\s*${MERIDIEM}(?![\\d:])`, 'i');
const TIME_24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const NOON = /\b(noon|midday|midnight)\b/i;

function toMinutes(h, min, mer, fallbackMer) {
  let hour = h % 24;
  const suffix = (mer || fallbackMer || '').toLowerCase().replace(/\./g, '');
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  return hour * 60 + (min || 0);
}

function findTime(text) {
  let m = TIME_RANGE.exec(text);
  if (m && +m[1] <= 24 && +m[4] <= 24) {
    const endMer = m[6] || m[3];
    const start = toMinutes(+m[1], +(m[2] || 0), m[3], endMer);
    let end = toMinutes(+m[4], +(m[5] || 0), m[6], m[3]);
    // "9-5" is a working day; "22:00-01:00" genuinely crosses midnight.
    const bareHours = !m[2] && !m[5] && !m[3] && !m[6];
    if (end <= start && bareHours) end += 12 * 60;
    if (end <= start) end += 24 * 60;
    return { start, end, index: m.index, length: m[0].length };
  }
  m = TIME_SINGLE.exec(text);
  if (m) return { start: toMinutes(+m[1], +(m[2] || 0), m[3]), index: m.index, length: m[0].length };
  m = TIME_24.exec(text);
  if (m) return { start: +m[1] * 60 + +m[2], index: m.index, length: m[0].length };
  m = NOON.exec(text);
  if (m) {
    const word = m[1].toLowerCase();
    return { start: word === 'midnight' ? 0 : 12 * 60, index: m.index, length: m[0].length };
  }
  return null;
}

const hhmm = (mins) => `${pad(Math.floor((mins % 1440) / 60))}:${pad(mins % 60)}`;

function minutesOf(hhmmStr) {
  const [h, m] = hhmmStr.split(':').map(Number);
  return h * 60 + m;
}

/* ------------------------------------------------------------------ title */

function cleanTitle(text) {
  return text
    // "Oct 26 and Nov 2 Party" leaves the "and" stranded between the two gaps
    .replace(/(^|\s\s)\s*(?:and|&|\+)\s*(\s\s|$)/gi, ' ')
    .replace(WEEKDAYS, ' ')
    .replace(/\b(?:at|on|from|starts?(?:\s+at)?|the)\b/gi, ' ')
    .replace(/[\t|;]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,&\-–—:.|]+/, '')
    .replace(/[\s,&\-–—:.|]+$/, '')
    .trim();
}

/** Remove matched spans, last first so earlier indexes stay valid. */
function cutSpans(text, spans) {
  return [...spans].sort((a, b) => b.index - a.index)
    .reduce((out, span) => `${out.slice(0, span.index)} ${out.slice(span.index + span.length)}`, text);
}

/* ----------------------------------------------------------------- public */

let counter = 0;
const nextId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Parse a single line into one or more events.
 * @returns {{ok: true, events: object[]} | {ok: false, raw: string, reason: string}}
 */
export function parseLine(rawLine, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const raw = rawLine.trim();
  if (!raw || /^([#/]{1,2}|-{3,})/.test(raw)) return { ok: false, raw, reason: 'empty' };

  let rest = raw;

  // "@ location" and "// notes" are pulled out before anything else.
  let location = '';
  let notes = '';
  const noteSplit = rest.split(/\s+\/\/\s+/);
  if (noteSplit.length > 1) { rest = noteSplit[0]; notes = noteSplit.slice(1).join(' // ').trim(); }
  const locSplit = rest.split(/\s+@\s+/);
  if (locSplit.length > 1) { rest = locSplit[0]; location = locSplit.slice(1).join(' @ ').trim(); }

  const { groups, spans } = findDates(rest, opts);
  if (!groups.length) return { ok: false, raw, reason: 'No date found' };
  rest = cutSpans(rest, spans);

  let allDay = false;
  const allDayMatch = /\ball[\s-]?day\b/i.exec(rest);
  if (allDayMatch) {
    allDay = true;
    rest = `${rest.slice(0, allDayMatch.index)} ${rest.slice(allDayMatch.index + allDayMatch[0].length)}`;
  }

  const time = allDay ? null : findTime(rest);
  if (time) rest = `${rest.slice(0, time.index)} ${rest.slice(time.index + time.length)}`;

  const title = cleanTitle(rest) || 'Untitled event';
  const startTime = time ? hhmm(time.start) : opts.defaultTime;
  const endMinutes = time && time.end != null ? time.end : minutesOf(startTime) + opts.defaultDuration;
  const endTime = hhmm(endMinutes);

  const events = [];
  for (const group of resolveYears(groups, opts)) {
    const first = toISODate(group.dates[0]);
    const last = toISODate(group.dates[group.dates.length - 1]);

    if (group.range && last !== first) {           // Oct 2-5 — one event over four days
      events.push(makeEvent({ title, location, notes, raw, startTime, endTime, time, endMinutes,
        date: first, endDate: last, allDay: allDay || !time, spans: true }));
    } else {                                        // Oct 26,27,28 — one event each
      for (const part of group.dates.slice(0, group.range ? 1 : undefined)) {
        const date = toISODate(part);
        events.push(makeEvent({ title, location, notes, raw, startTime, endTime, time, endMinutes,
          date, endDate: date, allDay }));
      }
    }
  }
  return { ok: true, events };
}

function makeEvent({ title, location, notes, raw, startTime, endTime, endMinutes, date, endDate, allDay, spans }) {
  // An event that runs past midnight finishes on the following day.
  const finishes = !spans && !allDay && endMinutes >= 24 * 60 ? nextDay(date) : endDate;
  return { id: nextId(), title, date, endDate: finishes, allDay, startTime, endTime, location, notes, raw };
}

/** Parse a whole pasted blob. */
export function parseText(text, options = {}) {
  const events = [];
  const skipped = [];
  for (const line of String(text).split(/\r?\n/)) {
    const result = parseLine(line, options);
    if (result.ok) events.push(...result.events);
    else if (result.reason !== 'empty') skipped.push({ raw: result.raw, reason: result.reason });
  }
  return { events, skipped };
}

export { minutesOf, hhmm };
