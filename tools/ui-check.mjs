/*
 * Loads the app in an iPhone-sized Chromium, drives the main flow and
 * screenshots it. Dev-only smoke test: node tools/ui-check.mjs
 */
import { chromium, devices } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  const file = join(root, path === '/' ? 'index.html' : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], isMobile: false, hasTouch: true });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });

const expect = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok' : 'FAIL'}  ${label}${ok ? '' : ` — ${detail}`}`);
  if (!ok) process.exitCode = 1;
};

await page.goto(base, { waitUntil: 'networkidle' });

await page.click('#sample');
await page.waitForFunction(() => document.querySelectorAll('.event').length > 0);
expect('example fills the preview', await page.locator('.event').count() === 5);
expect('add button counts events', (await page.textContent('#add')).includes('Add 5 events'));

const rows = await page.locator('.event').evaluateAll((nodes) => nodes.map((n) => n.innerText.replace(/\n/g, ' · ')));
console.log(rows.map((r) => `        ${r}`).join('\n'));

// Open an editor while the preview holds a mix of event shapes, so the
// grid is exercised at its widest.

await page.locator('.event-head').first().click();
await page.locator('.event.open input[data-field="title"]').fill('Dentist — moved');
await page.locator('.event.open input[data-field="title"]').dispatchEvent('change');
await page.fill('#input', (await page.inputValue('#input')) + '\nDec 1 Extra event');
await page.waitForFunction(() => document.querySelectorAll('.event').length === 6);
expect('hand edit survives re-parse', (await page.locator('.event-title').first().textContent()) === 'Dentist — moved');

// Calendar selection.
await page.fill('#calendar-new', 'Family');
await page.click('#calendar-form button');
await page.waitForFunction(() => document.querySelector('.chip-on')?.textContent.startsWith('Family'));
expect('new calendar is selected', (await page.locator('.chip-on').innerText()).startsWith('Family'));

// Unparseable lines are surfaced.
await page.fill('#input', 'Sep 3 9am Dentist\nthis line has no date');
await page.waitForFunction(() => !document.getElementById('skipped').hidden);
expect('bad line is listed', (await page.textContent('#skipped-list')).includes('no date'));

expect('save link hides when there is nothing to save', await page.evaluate(async () => {
  const input = document.getElementById('input');
  const previous = input.value;
  input.value = '';
  input.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 400));
  const hidden = !document.getElementById('download').checkVisibility();
  input.value = previous;
  input.dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 400));
  return hidden;
}));

// The download path produces a real .ics.
await page.fill('#input', 'Sep 3 9:30am Dentist @ Clinic\nOct 2-5 Lisbon trip');
await page.waitForFunction(() => document.querySelectorAll('.event').length === 2);
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
const stream = await download.createReadStream();
const ics = await new Promise((resolve) => { let out = ''; stream.on('data', (c) => (out += c)); stream.on('end', () => resolve(out)); });
expect('file is named after the calendar', download.suggestedFilename() === 'family.ics', download.suggestedFilename());
expect('ics carries both events', ics.split('BEGIN:VEVENT').length === 3);
expect('ics names the calendar', ics.includes('X-WR-CALNAME:Family'));
expect('all-day range is exclusive', ics.includes('DTEND;VALUE=DATE:20261006'), ics);

// Service worker installs and answers the version request.
await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
await page.waitForFunction(() => document.getElementById('version').textContent.startsWith('v'), null, { timeout: 5000 });
expect('service worker reports its version', (await page.textContent('#version')).startsWith('v'));

// Settings survive a reload.
await page.reload({ waitUntil: 'networkidle' });
expect('text is restored after reload', (await page.inputValue('#input')).includes('Lisbon'));
expect('calendar choice is restored', (await page.locator('.chip-on').innerText()).startsWith('Family'));

const swState = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return { installing: !!r.installing, waiting: !!r.waiting, active: !!r.active,
           banner: document.getElementById('update-banner').hidden };
});
console.log('        sw state:', JSON.stringify(swState));
expect('no update banner on a fresh install', swState.banner === true);
expect('update banner is really off screen', !(await page.locator('#update-banner').isVisible()));

const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
expect('page does not scroll sideways', overflow.scroll <= overflow.view, JSON.stringify(overflow));

await page.evaluate(() => window.scrollTo(0, 0));

await page.screenshot({ path: 'tools/screenshot-light.png' });
await page.emulateMedia({ colorScheme: 'dark' });
await page.locator('.event-head').first().click();
await page.evaluate(() => document.querySelector('.event.open').scrollIntoView({ block: 'center' }));
await page.screenshot({ path: 'tools/screenshot-dark.png' });

expect('no console or page errors', problems.length === 0, problems.join(' | '));

await browser.close();
server.close();
console.log(process.exitCode ? '\nFAILED' : '\nAll UI checks passed');
