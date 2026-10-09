// Render deck/index.html to media/talang-pitch-deck.pdf, one 1280x720 page per slide,
// plus deck/shots/NN.png per slide for checking layout.
//   node deck/render.mjs
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = pathToFileURL(join(HERE, 'index.html')).href;
const PDF = join(HERE, '..', 'media', 'talang-pitch-deck.pdf');
const SHOTS = join(HERE, 'shots');
await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// networkidle so the Google Fonts stylesheet lands; fonts.ready so glyphs are rasterised.
await page.goto(SRC, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.pdf({ path: PDF, width: '1280px', height: '720px', printBackground: true });
console.log('wrote', PDF);

const n = await page.locator('.slide').count();
await page.keyboard.press('Home');
for (let k = 1; k <= n; k++) {
  if (k > 1) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400); // fade between slides
  await page.screenshot({ path: join(SHOTS, `${String(k).padStart(2, '0')}.png`) });
}
console.log('wrote', n, 'shots to', SHOTS);
await browser.close();
