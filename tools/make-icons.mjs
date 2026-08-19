/*
 * Renders icons/icon.svg into the PNG sizes iOS and the manifest need.
 * Run with: node tools/make-icons.mjs   (requires Playwright's Chromium)
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'icons/icon.svg'), 'utf8');

// name, pixel size, padding — maskable icons keep art inside the safe zone.
const TARGETS = [
  ['icons/apple-touch-icon.png', 180, 0],
  ['icons/icon-192.png', 192, 0],
  ['icons/icon-512.png', 512, 0],
  ['icons/icon-maskable-512.png', 512, 0.1],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();

for (const [file, size, pad] of TARGETS) {
  const inset = Math.round(size * pad);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>
      html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:#d93a3f;overflow:hidden}
      svg{display:block;width:${size - inset * 2}px;height:${size - inset * 2}px;margin:${inset}px}
    </style>${svg}`);
  writeFileSync(join(root, file), await page.screenshot({ omitBackground: false }));
  console.log(`wrote ${file} (${size}px)`);
}

await browser.close();
