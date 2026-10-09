// The 1200x630 share card (OG / Twitter), in the landing's lavender glass.
// Laid out in the browser and screenshotted, like deck/render.mjs.
//   node scripts/make-social.mjs   -> media/og-card.png and web/og-card.png (Vercel serves web/)
import { chromium } from 'playwright';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'media', 'og-card.png');
await mkdir(dirname(OUT), { recursive: true });

const html = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@200..700&family=Geist+Mono:wght@400;500&display=swap">
<style>
  * { box-sizing: border-box }
  body { margin: 0; width: 1200px; height: 630px; overflow: hidden; color: #120d24; font-family: Geist, system-ui, sans-serif;
    background:
      radial-gradient(60% 60% at 85% 10%, rgba(173,140,255,.5), transparent 70%),
      radial-gradient(50% 45% at 0% 80%, rgba(255,190,230,.35), transparent 70%),
      radial-gradient(70% 50% at 50% 115%, rgba(150,120,255,.35), transparent 70%), #e9e5f6; }
  .wrap { position: absolute; inset: 0; padding: 56px 64px; display: flex; flex-direction: column; justify-content: space-between }
  .brand { display: flex; align-items: center; gap: 12px; font-size: 30px; font-weight: 500; letter-spacing: -.03em }
  .eyebrow { font-size: 22px; color: #3b3552; margin: 0 0 14px }
  h1 { margin: 0; font-weight: 250; font-size: 100px; line-height: .95; letter-spacing: -.055em }
  .foot { display: flex; gap: 12px; font: 500 17px "Geist Mono", monospace }
  .pill { padding: 6px 14px; border-radius: 10px; background: rgba(255,255,255,.6); border: 1px solid #fff }
  .pill.d { background: #0f0b1c; color: #f3f0ff; border-color: #0f0b1c }
  .card { position: absolute; right: 64px; top: 150px; width: 360px; padding: 22px; border-radius: 26px; rotate: -4deg;
    background: rgba(255,255,255,.62); border: 1px solid #fff; box-shadow: 0 30px 60px -24px rgba(30,15,80,.45); font-size: 17px }
  .head { display: flex; justify-content: space-between; font-weight: 500; margin-bottom: 12px }
  dl { margin: 0; padding: 16px 18px; border-radius: 16px; background: linear-gradient(135deg, #1a1530, #3a2380); color: #f3f0ff }
  dl div { display: flex; justify-content: space-between; padding: 4px 0 }
  dt { color: #a49cc4 } dd { margin: 0; font-family: "Geist Mono", monospace }
  .vis { display: flex; justify-content: space-between; margin-top: 14px; color: #6c6683 }
  .vis b { color: #6a2cf0 }
  .tag { position: absolute; padding: 8px 14px; border-radius: 12px; font-size: 18px; box-shadow: 0 14px 30px -12px rgba(30,15,80,.35) }
  .tag b { font-weight: 600 }
</style>
<div class="wrap">
  <div class="brand"><svg viewBox="0 0 32 32" width="40" height="40"><path d="M16 3 28 10v12L16 29 4 22V10z" fill="#120d24"/><path d="M16 3 28 10 16 17 4 10z" fill="#3a2b66"/><path d="M16 17v12L4 22V10z" fill="#1d1538"/><circle cx="16" cy="17" r="3.2" fill="#8b5cff"/></svg>talang</div>
  <div>
    <p class="eyebrow">Sealed-bid repo desk on Canton</p>
    <h1>Repo quotes,<br>behind glass</h1>
  </div>
  <div class="foot"><span class="pill d">talang-desk.vercel.app</span><span class="pill">BitSafe 2-of-3 marks</span><span class="pill">CBTC on DevNet</span></div>
</div>
<div class="card">
  <div class="head">Sealed quote <span style="color:#6c6683">Lender A → Borrower</span></div>
  <dl><div><dt>Rate</dt><dd>525 bp</dd></div><div><dt>Haircut</dt><dd>2.0%</dd></div><div><dt>Locked</dt><dd>full principal</dd></div></dl>
  <div class="vis"><span>Observers</span><b>none</b></div>
</div>
<span class="tag" style="right:300px; top:110px; background:#e6ff4f"><b>Borrower</b> sees every quote</span>
<span class="tag" style="right:56px; top:430px; background:#ffb3a7"><b>Lender B</b> sees nothing of rivals</span>
<span class="tag" style="right:150px; top:490px; background:#ddd0ff"><b>Regulator</b> sees reports only</span>`;

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: OUT });
await b.close();
await copyFile(OUT, join(ROOT, 'web', 'og-card.png'));
console.log('wrote', OUT, 'and web/og-card.png');
