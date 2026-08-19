/*
 * parser.js — turns pasted free-form text into calendar events.
 *
 * One line = one event. The line is scanned for a date (or date range), then
 * for a time (or time range); whatever text is left over becomes the title.
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
const NOT_TIME = '(?![\\d:])';   // stops "Aug 09:00" being read as Aug 9th
const DASH = '(?:-|–|—|to|until|through|thru|›|→)';
const WEEKDAYS = /\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(day|sday|nesday|rsday|urday)?\b\.?/gi;

export const DEFAULTS = {
  dateOrder: 'MDY',        // how to read 3/4 — 'MDY' (US) or 'DMY'
  defaultTime: '09:00',    // used when a line has a date but no time
  defaultDuration: 60,     // minutes
  rollForward: true,       // a bare "Mar 3" that already passed means next year
  reference: null,         // Date used as "today" (tests inject this)
};

const pad = (n) => String(n).padStart(2, '0');
const clampDay = (y, m, d) => Math.min(Math.max(d, 1), new Date(y, m, 0).getDate());

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

/* ------------------------------------------------------------------ dates */

// Each matcher returns { a, b } — start and (optional) end {y?,m,d}.
const DATE_MATCHERS = [
  { // 2026-08-19 to 2026-08-21
    re: new RegExp(`\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\s*${DASH}\\s*(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b`, 'i'),
    build: (m) => ({
      a: { y: +m[1], m: +m[2], d: +m[3] },
      b: { y: +m[4], m: +m[5], d: +m[6] },
    }),
  },
  { // 2026-08-19
    re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/,
    build: (m) => ({ a: { y: +m[1], m: +m[2], d: +m[3] } }),
  },
  { // Aug 19 - Sep 2, 2026   /   August 19-21
    re: new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})${ORD}\\s*${DASH}\\s*(?:${MON}\\.?\\s+)?(\\d{1,2})${ORD}(?:\\s*,?\\s*(\\d{4}))?\\b`, 'i'),
    build: (m) => {
      const y = m[5] ? +m[5] : null;
      const m1 = MONTHS[m[1].toLowerCase().replace('.', '')];
      const m2 = m[3] ? MONTHS[m[3].toLowerCase().replace('.', '')] : m1;
      return { a: { y, m: m1, d: +m[2] }, b: { y, m: m2, d: +m[4] } };
    },
  },
  { // 19-21 Aug 2026
    re: new RegExp(`\\b(\\d{1,2})${ORD}\\s*${DASH}\\s*(\\d{1,2})${ORD}\\s+${MON}\\.?(?:\\s*,?\\s*(\\d{4}))?\\b`, 'i'),
    build: (m) => {
      const y = m[4] ? +m[4] : null;
      const mo = MONTHS[m[3].toLowerCase().replace('.', '')];
      return { a: { y, m: mo, d: +m[1] }, b: { y, m: mo, d: +m[2] } };
    },
  },
  { // Aug 19, 2026  /  Aug 19  /  August 19th
    re: new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})${ORD}${NOT_TIME}(?:\\s*,?\\s*(\\d{4}))?\\b`, 'i'),
    build: (m) => ({
      a: { y: m[3] ? +m[3] : null, m: MONTHS[m[1].toLowerCase().replace('.', '')], d: +m[2] },
    }),
  },
  { // 19 Aug 2026  /  19th of August
    re: new RegExp(`\\b(\\d{1,2})${ORD}(?:\\s+of)?\\s+${MON}\\.?${NOT_TIME}(?:\\s*,?\\s*(\\d{4}))?\\b`, 'i'),
    build: (m) => ({
      a: { y: m[3] ? +m[3] : null, m: MONTHS[m[2].toLowerCase().replace('.', '')], d: +m[1] },
    }),
  },
  { // 8/19/2026 - 8/21/2026   /   8/19 - 8/21
    re: new RegExp(`\\b(\\d{1,2})([\\/.])(\\d{1,2})(?:\\2(\\d{2,4}))?\\s*${DASH}\\s*(\\d{1,2})\\2(\\d{1,2})(?:\\2(\\d{2,4}))?\\b`, 'i'),
    build: (m, order) => ({
      a: numeric(m[1], m[3], m[4], order, m[2]),
      b: numeric(m[5], m[6], m[7] ?? m[4], order, m[2]),
    }),
  },
  { // 8/19/2026  /  19.8.2026  /  8/19
    re: /\b(\d{1,2})([\/.])(\d{1,2})(?:\2(\d{2,4}))?\b/,
    build: (m, order) => ({ a: numeric(m[1], m[3], m[4], order, m[2]) }),
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

function findDate(text, opts) {
  // Matchers are ordered most-specific first, but a later matcher that starts
  // earlier in the line wins — "19 Aug 09:00" is the 19th, not the 9th.
  let best = null;
  for (const matcher of DATE_MATCHERS) {
    const m = matcher.re.exec(text);
    if (!m) continue;
    const parts = matcher.build(m, opts.dateOrder);
    if (!parts.a || !parts.a.m || !parts.a.d) continue;
    if (!best || m.index < best.index) best = { ...parts, index: m.index, length: m[0].length };
  }
  return best;
}

function resolveYears(found, opts) {
  const today = opts.reference ? new Date(opts.reference) : new Date();
  today.setHours(0, 0, 0, 0);
  const a = { ...found.a };
  const b = found.b ? { ...found.b } : null;

  if (a.y == null) {
    a.y = today.getFullYear();
    if (opts.rollForward) {
      const cutoff = new Date(today);
      cutoff.setDate(cutoff.getDate() - 30);
      if (new Date(a.y, a.m - 1, clampDay(a.y, a.m, a.d)) < cutoff) a.y += 1;
    }
  }
  if (b) {
    if (b.y == null) b.y = a.y;
    // "Dec 28 - Jan 3" wraps into the following year
    if (new Date(b.y, b.m - 1, b.d) < new Date(a.y, a.m - 1, a.d)) b.y += 1;
  }
  return { a, b };
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
    let start = toMinutes(+m[1], +(m[2] || 0), m[3], endMer);
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

/* ------------------------------------------------------------------ title */

function cleanTitle(text) {
  return text
    .replace(WEEKDAYS, ' ')
    .replace(/\b(?:at|on|from|starts?(?:\s+at)?|the)\b/gi, ' ')
    .replace(/[\t|;]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,\-–—:.|]+/, '')
    .replace(/[\s,\-–—:.|]+$/, '')
    .trim();
}

function cut(text, span) {
  return span ? text.slice(0, span.index) + ' ' + text.slice(span.index + span.length) : text;
}

/* ----------------------------------------------------------------- public */

/**
 * Parse a single line.
 * @returns {{ok: true, event: object} | {ok: false, raw: string, reason: string}}
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

  const found = findDate(rest, opts);
  if (!found) return { ok: false, raw, reason: 'No date found' };
  rest = cut(rest, found);

  let allDay = false;
  const allDayMatch = /\ball[\s-]?day\b/i.exec(rest);
  if (allDayMatch) { allDay = true; rest = cut(rest, { index: allDayMatch.index, length: allDayMatch[0].length }); }

  const time = allDay ? null : findTime(rest);
  if (time) rest = cut(rest, time);

  const { a, b } = resolveYears(found, opts);
  const multiDay = !!b && toISODate(b) !== toISODate(a);
  if (multiDay && !time) allDay = true;

  const startTime = time ? hhmm(time.start) : opts.defaultTime;
  const endMinutes = time && time.end != null ? time.end : minutesOf(startTime) + opts.defaultDuration;
  const startDate = toISODate(a);
  // An event that runs past midnight finishes on the following day.
  const endDate = multiDay ? toISODate(b)
    : (!allDay && endMinutes >= 24 * 60 ? nextDay(startDate) : startDate);

  return {
    ok: true,
    event: {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      title: cleanTitle(rest) || 'Untitled event',
      date: startDate,
      endDate,
      allDay,
      startTime,
      endTime: hhmm(endMinutes),
      location,
      notes,
      raw,
    },
  };
}

function minutesOf(hhmmStr) {
  const [h, m] = hhmmStr.split(':').map(Number);
  return h * 60 + m;
}

/** Parse a whole pasted blob. */
export function parseText(text, options = {}) {
  const events = [];
  const skipped = [];
  for (const line of String(text).split(/\r?\n/)) {
    const result = parseLine(line, options);
    if (result.ok) events.push(result.event);
    else if (result.reason !== 'empty') skipped.push({ raw: result.raw, reason: result.reason });
  }
  return { events, skipped };
}

export { minutesOf, hhmm };
