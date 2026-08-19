/*
 * ics.js — builds an RFC 5545 calendar file from the parsed events.
 *
 * Times are written as "floating" local times (no TZID, no Z) so an event
 * pasted as 3pm lands at 3pm on the phone, whatever timezone it is in.
 */

const pad = (n) => String(n).padStart(2, '0');

const escapeText = (value = '') =>
  String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

/** RFC 5545 says lines wrap at 75 octets, continuations start with a space. */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const charSize = new TextEncoder().encode(char).length;
    if (size + charSize > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      size = 1; // the leading space on a continuation line
    }
    current += char;
    size += charSize;
  }
  out.push(current);
  return out.join('\r\n ');
}

const stampUTC = (date = new Date()) =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
  `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;

const dateValue = (iso) => iso.replace(/-/g, '');
const dateTimeValue = (iso, time) => `${dateValue(iso)}T${time.replace(':', '')}00`;

/** All-day DTEND is exclusive, so it points at the morning after. */
function dayAfter(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

function uid() {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${random}@batch-calendar`;
}

/** One event's timed span, keeping the end after the start. */
function timedSpan(event) {
  let endDate = event.endDate || event.date;
  let endTime = event.endTime || event.startTime;
  if (`${endDate}T${endTime}` <= `${event.date}T${event.startTime}`) {
    endDate = event.date;
    const [h, m] = event.startTime.split(':').map(Number);
    const total = h * 60 + m + 60;
    if (total >= 24 * 60) {
      endDate = dayAfter(event.date);
      endTime = `${pad(Math.floor((total - 24 * 60) / 60))}:${pad(total % 60)}`;
    } else {
      endTime = `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
    }
  }
  return [
    `DTSTART:${dateTimeValue(event.date, event.startTime)}`,
    `DTEND:${dateTimeValue(endDate, endTime)}`,
  ];
}

export function buildEvent(event, { alarmMinutes = null, stamp = new Date() } = {}) {
  const lines = ['BEGIN:VEVENT', `UID:${uid()}`, `DTSTAMP:${stampUTC(stamp)}`];

  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dateValue(event.date)}`);
    lines.push(`DTEND;VALUE=DATE:${dateValue(dayAfter(event.endDate || event.date))}`);
  } else {
    lines.push(...timedSpan(event));
  }

  lines.push(`SUMMARY:${escapeText(event.title || 'Untitled event')}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.notes) lines.push(`DESCRIPTION:${escapeText(event.notes)}`);
  lines.push('TRANSP:OPAQUE');

  if (alarmMinutes != null && alarmMinutes !== '') {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(event.title || 'Reminder')}`,
      `TRIGGER:-PT${Number(alarmMinutes)}M`,
      'END:VALARM',
    );
  }

  lines.push('END:VEVENT');
  return lines;
}

export function buildICS(events, { calendarName = 'Batch Calendar', alarmMinutes = null, stamp } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Batch Calendar//Batch Add for iPhone//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const event of events) lines.push(...buildEvent(event, { alarmMinutes, stamp }));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** A filename that will not upset iOS or a Mac. */
export function icsFilename(calendarName) {
  const safe = String(calendarName || 'events').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase();
  return `${safe || 'events'}.ics`;
}
