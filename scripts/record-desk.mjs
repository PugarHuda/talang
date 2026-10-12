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
const OUT = process.env.TALANG_OUT ?? join(ROOT, 'media', 'talang-desk.mp4');
await rm(RAW, { recursive: true, force: true });
await mkdir(RAW, { recursive: true });

const marks = [];
let t0 = Date.now();
const mark = (label) => { marks.push({ at: Number(((Date.now() - t0) / 1000).toFixed(2)), label }); console.log('·', label); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir: RAW, size: { width: 1600, height: 900 } } });
const p = await ctx.newPage();
t0 = Date.now(); // the capture starts with the page: marks are seconds into the video

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

// One request typed in from scratch, so every number on screen was entered on camera.
const REQ = { inst: 'UST5Y', qty: '60', cash: process.env.REQ_CASH ?? '5300000', term: process.env.REQ_TERM ?? '28' };
const PRINCIPAL = Number(REQ.cash).toLocaleString('en-US');
const TITLE = `${PRINCIPAL} USDC against 60 UST5Y, ${REQ.term} days`;
const MARKDOWN = process.env.MARKDOWN ?? '89500';
const QUOTES = [ // lender, rate bp, haircut %: B is cheapest but its haircut leaves the loan short
  ['lenderA', '470', '2'], ['lenderB', '455', '6'], ['lenderC', '495', '3']];
const card = `.card:has(h3:has-text("${TITLE}"))`;
// Every action ends in a toast; a red one stops the recording rather than filming a failure.
const done = async (text) => {
  await p.locator('#toast', { hasText: text }).waitFor({ timeout: 30000 });
  if (await p.locator('#toast.err').isVisible()) throw new Error('desk error: ' + await p.locator('#toast').innerText());
  await beat(1400);
};
const pick = async (sel, value) => { await (await point(sel)).selectOption(value); await beat(500); };

await p.goto(URL, { waitUntil: 'load' });
// Warm the slow reads (agent's marks, every node side by side) before filming starts,
// so the cut never sits on loading skeletons. Marks stay in video time (t0 = page open).
await as('agent');
await until('[data-act="mark"]', 90000);
await click('#side-by-side');
await until('#sbs', 90000);
await click('#side-by-side');
await as('borrower');
await until('#n-inst');
await beat(1500);

mark('Borrower: a new request, typed in. Collateral, units, cash wanted, term');
await pick('#n-inst', REQ.inst);
await type('#n-qty', REQ.qty);
await type('#n-cash', REQ.cash);
await type('#n-term', REQ.term);
mark('Asks three lenders, Lender C included');
await click('.n-lender[value="lenderC"]');
// No "give me bonds" here: the seed already holds the UST5Y, and any action repaints the
// form, which would wipe what was just typed.
await click('[data-act="request"]');
await done('Request sent');

for (const [role, rate, haircut] of QUOTES) {
  mark(`${role.replace('lender', 'Lender ')} quotes: ${rate} bp, haircut ${haircut}%, cash locked behind it`);
  await as(role);
  await until(`${card} [data-act="quote"]`);
  await click(`${card} [data-act="cash-for"]`);
  await done('Cash issued');
  await type(`${card} input[id^="r-"]`, rate);
  await type(`${card} input[id^="h-"]`, haircut);
  await click(`${card} [data-act="quote"]`);
  await done('Quote sealed');
  if (role === 'lenderA') {
    mark('Lender A\'s node: its own quotes only. Rival quotes never reached it');
    await p.locator('.proof').first().scrollIntoViewIfNeeded();
    await beat(2600);
  }
}

mark('Back to the borrower: three sealed quotes. The cheapest is short at the mark');
await as('borrower');
await until(`${card} table`);
await scroll(`${card} table`);
await beat(2600);
mark('It takes the cheapest quote that covers: Lender A');
await click(`${card} tr:has-text("Lender A") [data-act="award"]`);
await done('Repo opened');

mark('Lender B lost: told its rank, and nothing else');
await as('lenderB');
await scroll('text=Quotes you lost');
await beat(2600);

mark('The regulator: best execution, winner rank 2, no lender named, no losing rates');
await as('regulator');
await until('text=Best execution', 60000);
await beat(3400);

mark('Every node side by side, each reading only its own ledger');
await click('#side-by-side');
await until('#sbs', 60000);
await beat(5000);
await click('#side-by-side');
await beat(1200);

mark('The valuation agent types a new UST5Y mark and publishes it');
await as('agent');
await until('[data-act="mark"]', 60000);
await type('#m-inst', 'UST5Y');
await type('#m-price', MARKDOWN);
await click('[data-act="mark"]');
await done('Mark published');

mark('Lender A: at the new mark the repo is short, so it calls margin');
await as('lenderA');
const trade = `.card:has(h3:has-text("${PRINCIPAL} USDC against 60 UST5Y")):has([data-act="call"])`;
await scroll(`${trade} [data-act="call"]`);
await click(`${trade} [data-act="call"]`);
await done('Margin called');
await beat(1500);

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
