/*
 * app.js — wiring for Batch Calendar.
 *
 * The list re-parses as you type. Anything you edit by hand is remembered
 * against its source line, so a later keystroke elsewhere does not undo it.
 */

import { parseText } from './parser.js';
import { buildICS, icsFilename } from './ics.js';

const $ = (id) => document.getElementById(id);

const el = {
  input: $('input'), lineCount: $('line-count'),
  paste: $('paste'), sample: $('sample'), clear: $('clear'),
  calendars: $('calendar-list'), calendarForm: $('calendar-form'), calendarNew: $('calendar-new'),
  dateOrder: $('date-order'), defaultTime: $('default-time'), defaultDuration: $('default-duration'),
  alarm: $('alarm'), rollForward: $('roll-forward'),
  previewCard: $('preview-card'), list: $('event-list'), count: $('event-count'),
  skipped: $('skipped'), skippedList: $('skipped-list'), empty: $('empty-state'),
  add: $('add'), download: $('download'), version: $('version'),
  banner: $('update-banner'), reload: $('update-reload'), dismiss: $('update-dismiss'),
};

const STORE = 'batch-calendar.v1';
const SAMPLE = [
  'Sep 3 9:30am Dentist @ Highbury Clinic',
  '12/09 School run',
  'Oct 2-5 Lisbon trip',
  '2026-11-01 19:00-22:00 Dinner with Sam // book a table',
  'Nov 14 all day Marathon',
].join('\n');

const localeIsDayFirst = !/^en-(US|PH)\b/i.test(navigator.language || 'en-GB');

const state = {
  text: '',
  calendars: ['Personal', 'Work'],
  calendar: 'Personal',
  options: {
    dateOrder: localeIsDayFirst ? 'DMY' : 'MDY',
    defaultTime: '09:00',
    defaultDuration: 60,
    rollForward: true,
    alarm: '',
  },
  events: [],
  skipped: [],
  edits: new Map(),   // "line#n" -> edited event
  removed: new Set(),
  openId: null,
};

/* ---------------------------------------------------------------- storage */

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
    if (Array.isArray(saved.calendars) && saved.calendars.length) state.calendars = saved.calendars;
    if (typeof saved.calendar === 'string') state.calendar = saved.calendar;
    if (saved.options) Object.assign(state.options, saved.options);
    if (typeof saved.text === 'string') state.text = saved.text;
  } catch { /* first run, or storage blocked in private mode */ }
  if (!state.calendars.includes(state.calendar)) state.calendar = state.calendars[0];
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      calendars: state.calendars, calendar: state.calendar, options: state.options, text: state.text,
    }));
  } catch { /* nothing worth breaking the app over */ }
}

/* ------------------------------------------------------------- formatting */

const asDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const dayYearFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function describe(event) {
  const thisYear = new Date().getFullYear();
  const format = asDate(event.date).getFullYear() === thisYear ? dayFormat : dayYearFormat;
  const start = format.format(asDate(event.date));
  const spansDays = event.endDate && event.endDate !== event.date;
  if (event.allDay) return spansDays ? `${start} – ${format.format(asDate(event.endDate))}` : `${start} · all day`;
  const time = `${event.startTime}–${event.endTime}`;
  return spansDays ? `${start} ${event.startTime} – ${format.format(asDate(event.endDate))} ${event.endTime}` : `${start} · ${time}`;
}

/* ----------------------------------------------------------------- parsing */

function refresh() {
  const { events, skipped } = parseText(state.text, state.options);
  const seen = new Map();
  state.events = [];
  for (const event of events) {
    const index = (seen.get(event.raw) || 0) + 1;
    seen.set(event.raw, index);
    const key = `${event.raw}#${index}`;
    if (state.removed.has(key)) continue;
    state.events.push(state.edits.has(key) ? { ...state.edits.get(key), key } : { ...event, key });
  }
  state.skipped = skipped;
  render();
}

/* ---------------------------------------------------------------- renderer */

/*
 * Replacing the list blurs whatever field is focused, and a blurred field
 * fires `change`, which asks for another render. Coalesce them so a render
 * never starts inside another one.
 */
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => { renderQueued = false; paint(); });
}

function paint() {
  const lines = state.text.split('\n').filter((line) => line.trim()).length;
  el.lineCount.textContent = `${lines} ${lines === 1 ? 'line' : 'lines'}`;

  const total = state.events.length;
  el.count.textContent = `${total} ${total === 1 ? 'event' : 'events'}`;
  el.count.classList.toggle('good', total > 0);
  el.previewCard.hidden = total === 0 && state.skipped.length === 0;
  el.empty.hidden = !el.previewCard.hidden;
  el.add.disabled = total === 0;
  el.add.textContent = total ? `Add ${total} ${total === 1 ? 'event' : 'events'} to Calendar` : 'Add to Calendar';
  el.download.hidden = total === 0;

  el.list.replaceChildren(...state.events.map(renderEvent));

  el.skipped.hidden = state.skipped.length === 0;
  el.skippedList.replaceChildren(...state.skipped.map((item) => {
    const li = document.createElement('li');
    li.textContent = item.raw;
    return li;
  }));
}

function renderEvent(event) {
  const li = document.createElement('li');
  li.className = `event${state.openId === event.key ? ' open' : ''}`;

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'event-head';
  head.setAttribute('aria-expanded', String(state.openId === event.key));
  head.innerHTML = '<span class="event-title"></span><span class="event-when"></span>';
  head.querySelector('.event-title').textContent = event.title;
  head.querySelector('.event-when').textContent = describe(event);
  head.addEventListener('click', () => {
    state.openId = state.openId === event.key ? null : event.key;
    render();
  });
  li.append(head);

  const edit = document.createElement('div');
  edit.className = 'event-edit';
  edit.innerHTML = `
    <div class="edit-grid">
      <label class="full">Title<input type="text" class="field" data-field="title"></label>
      <label>Starts<input type="date" class="field" data-field="date"></label>
      <label>Ends<input type="date" class="field" data-field="endDate"></label>
      <label class="time-cell">From<input type="time" class="field" data-field="startTime"></label>
      <label class="time-cell">To<input type="time" class="field" data-field="endTime"></label>
      <label class="full">Location<input type="text" class="field" data-field="location" placeholder="Optional"></label>
      <label class="full">Notes<input type="text" class="field" data-field="notes" placeholder="Optional"></label>
    </div>
    <div class="edit-actions">
      <label class="switch-inline">All day<input type="checkbox" data-field="allDay"></label>
      <button type="button" class="link-danger">Remove</button>
    </div>`;

  for (const field of edit.querySelectorAll('[data-field]')) {
    const name = field.dataset.field;
    if (field.type === 'checkbox') field.checked = !!event[name];
    else field.value = event[name] ?? '';
    field.addEventListener('change', () => {
      const value = field.type === 'checkbox' ? field.checked : field.value;
      const updated = { ...event, [name]: value };
      if (name === 'date' && updated.endDate < value) updated.endDate = value;
      state.edits.set(event.key, updated);
      refresh();
    });
  }
  for (const cell of edit.querySelectorAll('.time-cell')) cell.style.display = event.allDay ? 'none' : '';

  edit.querySelector('.link-danger').addEventListener('click', () => {
    state.removed.add(event.key);
    state.openId = null;
    refresh();
    toast('Event removed');
  });

  li.append(edit);
  return li;
}

/* --------------------------------------------------------------- calendars */

function renderCalendars() {
  el.calendars.replaceChildren(...state.calendars.map((calendarName) => {
    const chip = document.createElement('span');
    chip.className = `chip${calendarName === state.calendar ? ' chip-on' : ''}`;

    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'chip-name';
    choose.textContent = calendarName;
    choose.setAttribute('aria-pressed', String(calendarName === state.calendar));
    choose.addEventListener('click', () => {
      state.calendar = calendarName;
      save();
      renderCalendars();
    });
    chip.append(choose);

    if (state.calendars.length > 1) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chip-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${calendarName}`);
      remove.addEventListener('click', () => {
        state.calendars = state.calendars.filter((item) => item !== calendarName);
        if (state.calendar === calendarName) state.calendar = state.calendars[0];
        save();
        renderCalendars();
      });
      chip.append(remove);
    }
    return chip;
  }));
}

/* ---------------------------------------------------------------- delivery */

function icsForCurrentEvents() {
  return buildICS(state.events, {
    calendarName: state.calendar,
    alarmMinutes: state.options.alarm === '' ? null : Number(state.options.alarm),
  });
}

function saveFile(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function addToCalendar() {
  if (!state.events.length) return;
  const text = icsForCurrentEvents();
  const filename = icsFilename(state.calendar);
  const file = new File([text], filename, { type: 'text/calendar' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `${state.events.length} events` });
      toast('Choose Calendar, then Add All');
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;   // the user closed the share sheet
    }
  }
  saveFile(text, filename);
  toast('Saved — open the file to add the events');
}

/* ------------------------------------------------------------------- toast */

let toastTimer;
function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    node.setAttribute('role', 'status');
    document.body.append(node);
  }
  node.textContent = message;
  requestAnimationFrame(() => node.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2800);
}

/* ------------------------------------------------------------------ events */

let parseTimer;
el.input.addEventListener('input', () => {
  state.text = el.input.value;
  clearTimeout(parseTimer);
  parseTimer = setTimeout(() => { save(); refresh(); }, 200);
});

el.paste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return toast('Clipboard is empty');
    el.input.value = state.text = state.text ? `${state.text.replace(/\s*$/, '')}\n${text}` : text;
    save();
    refresh();
  } catch {
    toast('Paste straight into the box instead');
    el.input.focus();
  }
});

el.sample.addEventListener('click', () => {
  el.input.value = state.text = SAMPLE;
  save();
  refresh();
});

el.clear.addEventListener('click', () => {
  el.input.value = state.text = '';
  state.edits.clear();
  state.removed.clear();
  state.openId = null;
  save();
  refresh();
});

el.calendarForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = el.calendarNew.value.trim();
  if (!name) return;
  if (!state.calendars.includes(name)) state.calendars.push(name);
  state.calendar = name;
  el.calendarNew.value = '';
  el.calendarNew.blur();
  save();
  renderCalendars();
});

const optionInputs = [
  [el.dateOrder, 'dateOrder', (node) => node.value],
  [el.defaultTime, 'defaultTime', (node) => node.value || '09:00'],
  [el.defaultDuration, 'defaultDuration', (node) => Number(node.value)],
  [el.alarm, 'alarm', (node) => node.value],
  [el.rollForward, 'rollForward', (node) => node.checked],
];
for (const [node, key, read] of optionInputs) {
  node.addEventListener('change', () => {
    state.options[key] = read(node);
    save();
    refresh();
  });
}

el.add.addEventListener('click', addToCalendar);
el.download.addEventListener('click', () => {
  saveFile(icsForCurrentEvents(), icsFilename(state.calendar));
  toast('Saved to Files');
});

/* --------------------------------------------------- service worker updates */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((registration) => {
    const offerUpdate = (worker) => {
      if (!worker) return;
      el.banner.hidden = false;
      el.reload.onclick = () => {
        el.reload.textContent = 'Updating…';
        worker.postMessage({ type: 'SKIP_WAITING' });
      };
    };

    if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);

    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
      });
    });

    // Look for a new build on launch, when the app comes back to the front,
    // and once an hour if it is left open.
    const check = () => registration.update().catch(() => {});
    check();
    setInterval(check, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }).catch(() => { /* offline, or opened straight from the file system */ });

  el.dismiss.addEventListener('click', () => { el.banner.hidden = true; });
  showVersion();
}

function showVersion() {
  const worker = navigator.serviceWorker.controller;
  if (!worker) { el.version.textContent = 'not installed'; return; }
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => { el.version.textContent = `v${event.data?.version ?? '?'}`; };
  worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
}

/* -------------------------------------------------------------------- boot */

load();
el.input.value = state.text;
el.dateOrder.value = state.options.dateOrder;
el.defaultTime.value = state.options.defaultTime;
el.defaultDuration.value = String(state.options.defaultDuration);
el.alarm.value = state.options.alarm;
el.rollForward.checked = state.options.rollForward;
renderCalendars();
refresh();
registerServiceWorker();
