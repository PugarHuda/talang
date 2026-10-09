// Record the desk being used for real: a screen capture with a visible cursor, at
// human speed, against a seeded ledger. Every number on screen is read from the
// ledger at the moment it is shown. Adapted from Tirai's recorder.
//
// The flow is the pitch's: a borrower's request with sealed quotes, a third lender
// seals its own, a rival sees only its own quote, the borrower takes the best one
// that covers, the losers learn their rank and nothing more, the regulator gets a
// best-execution record with no names, then every node side by side.
//
//   daml sandbox ... && node scripts/local.mjs && ENV_FILE=.env.local npm run seed
//   ENV_FILE=.env.local npm run desk
//   node scripts/record-desk.mjs        (TALANG_URL to point elsewhere)
// Writes media/talang-desk.mp4 and media/talang-desk.marks.json (caption timeline).
import { chromium } from 'playwright';
import { readdir, rm, mkdir, writeFile, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.env.TALANG_URL ?? 'http://localhost:8090/desk';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'media', '.capture');
const OUT = join(ROOT, 'media', 'talang-desk.mp4');
await rm(RAW, { recursive: true, force: true });
await mkdir(RAW, { recursive: true });

const marks = [];
let t0 = Date.now();
const mark = (label) => { marks.push({ at: Number(((Date.now() - t0) / 1000).toFixed(2)), label }); console.log('·', label); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir: RAW, size: { width: 1600, height: 900 } } });
const p = await ctx.newPage();

// Playwright draws no pointer; a demo where controls change with no cursor looks fake.
await p.addInitScript(() => {
  const put = () => {
    if (document.getElementById('rec-cursor')) return;
    const c = document.createElement('div');
    c.id = 'rec-cursor';
    c.style.cssText = 'position:fixed;z-index:99999;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;'
      + 'background:rgba(139,92,255,.25);border:2px solid #8b5cff;pointer-events:none;transition:transform .18s ease-out;left:0;top:0';
    document.body.appendChild(c);
  };
  document.addEventListener('DOMContentLoaded', put);
});

const beat = (ms = 1200) => p.waitForTimeout(ms);
const point = async (sel) => {
  const el = p.locator(sel).first();
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  if (!b) return el;
  const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
  await p.evaluate(([x, y]) => { const c = document.getElementById('rec-cursor'); if (c) c.style.transform = `translate(${x}px,${y}px)`; }, [x, y]);
  await p.mouse.move(x, y, { steps: 18 });
  await beat(420);
  return el;
};
const click = async (sel) => { await (await point(sel)).click(); await beat(900); };
const type = async (sel, text) => { const el = await point(sel); await el.fill(''); await el.type(text, { delay: 60 }); await beat(300); };
// The desk re-renders after every ledger read; wait until the action's result shows.
const until = (sel, timeout = 30000) => p.locator(sel).first().waitFor({ timeout });
const as = async (role) => { await click(`#roles [data-role="${role}"]`); await beat(2200); };
const scroll = async (sel) => { await p.locator(sel).first().scrollIntoViewIfNeeded(); await beat(1800); };

await p.goto(URL, { waitUntil: 'load' });
await as('borrower');
await until('[data-act="award"]');
t0 = Date.now();

mark('Borrower: a request for 5.4M USDC against Treasury notes, priced at today\'s US Treasury yield');
await scroll('[data-act="award"]');
await beat(2000);

mark('Lender C was asked too. It seals its own quote, locking the cash');
await as('lenderC');
await click('[data-act="cash-for"]');
await until('[data-act="quote"]');
await type('.card:has([data-act="quote"]) input[id^="r-"]', '490');
await type('.card:has([data-act="quote"]) input[id^="h-"]', '2');
await click('[data-act="quote"]');
await until('.pill.ok');
mark('Its node shows one quote, its own. The rivals\' quotes never reached it');
await p.locator('.proof').first().scrollIntoViewIfNeeded();
await beat(2600);

mark('Lender A, in its own session: still only its own quote');
await as('lenderA');
await beat(2400);

mark('Back to the borrower: three sealed quotes, checked against the mark');
await as('borrower');
await scroll('[data-act="award"]');
await beat(2400);
mark('It takes the cheapest quote whose haircut covers the loan');
await click('[data-act="award"]:not([disabled])');
await beat(3000);

mark('A losing lender is told its rank, and nothing else');
await as('lenderB');
await scroll('text=Quotes you lost');
await beat(2400);

mark('The regulator: a best-execution record, with no lender names and no losing rates');
await as('regulator');
await beat(3200);

mark('Every node side by side, each reading only its own ledger');
await click('#side-by-side');
await beat(5000);
await click('#side-by-side');
await beat(1200);

mark('end');
await ctx.close();
await browser.close();

const webm = (await readdir(RAW)).find((f) => f.endsWith('.webm'));
if (!webm) throw new Error('no capture was written');
try {
  execFileSync('ffmpeg', ['-y', '-i', join(RAW, webm), '-c:v', 'libx264', '-crf', '20', '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['ignore', 'ignore', 'pipe'] });
  await rm(RAW, { recursive: true, force: true });
} catch {
  await rename(join(RAW, webm), OUT.replace(/\.mp4$/, '.webm'));
  console.log('ffmpeg failed; kept the webm');
}
await writeFile(OUT.replace(/\.mp4$/, '.marks.json'), JSON.stringify(marks, null, 2) + '\n');
console.log('wrote', OUT);
