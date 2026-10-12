// The desk with a real Grofty wallet (CIP-0103 browser extension, Canton TestNet), no stub:
// connect, two borrower commands signed in Grofty and checked by api/wallet-verify, then a
// venue-fee payment the wallet approves and executes on TestNet.
//
// Needs the unpacked Grofty extension and a Chromium profile already onboarded with a wallet
// (GROFTY_EXT, GROFTY_PROFILE, GROFTY_ACCOUNT: a text file with an "extension password: ..." line,
// read here and typed into the extension only). The desk ledger is any talang-repo ledger:
//   ENV_FILE=.env.local, or DEVNET_LEDGER_URL + LEDGER_USER_ID + TALANG_PARTIES
//   WALLET_PARTY=<the Grofty party> PAY_TO=<a TestNet party> node scripts/grofty-e2e.mjs
// Writes docs/evidence/grofty-wallet-testnet.json, docs/img/grofty-*.png and media/grofty-wallet.mp4.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = process.env.GROFTY_EXT ?? 'F:/hackathons/grofty-testnet-ext';
const PROFILE = process.env.GROFTY_PROFILE ?? 'F:/hackathons/grofty-profile';
const PW = /^extension password:\s*(.+)$/m.exec(readFileSync(process.env.GROFTY_ACCOUNT ?? 'F:/hackathons/grofty-testnet-account.txt', 'utf8'))[1].trim();
const { WALLET_PARTY, PAY_TO } = process.env;
if (!WALLET_PARTY || !PAY_TO) throw new Error('set WALLET_PARTY and PAY_TO');
const PORT = process.env.PORT ?? '8095';
const DESK = `http://localhost:${PORT}`;
const HOSTED = 'https://talang-desk.vercel.app/api/wallet-verify';
const RAW = join(ROOT, 'media', '.capture');
rmSync(RAW, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });
const shot = (p, name) => p.screenshot({ path: join(ROOT, 'docs', 'img', `grofty-${name}.png`) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT,
  TALANG_WALLET_ROLES: JSON.stringify({ borrower: WALLET_PARTY }), TALANG_TESTNET_VENUE: PAY_TO } });
await new Promise((r) => srv.stdout.once('data', r));

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, channel: 'chromium', viewport: { width: 1440, height: 900 },
  recordVideo: { dir: RAW, size: { width: 1440, height: 900 } }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
const marks = [];
let t0 = 0, deskVideo, popVideo;
const mark = (label) => { marks.push({ at: Number(((Date.now() - t0) / 1000).toFixed(2)), label }); console.log('·', label); };
const ev = { network: 'canton:da-testnet', wallet: 'Grofty (browser extension, Canton TestNet)', walletParty: WALLET_PARTY, steps: [] };
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const pop = await ctx.newPage();
  const popAt = Date.now();
  await pop.goto(`chrome-extension://${sw.url().split('/')[2]}/src/popup/index.html`);
  await pop.getByText(/Unlock Extension|TOTAL ASSETS/).first().waitFor({ timeout: 60000 });
  if (await pop.getByText('Unlock Extension').count()) {
    await pop.getByText('Unlock Extension').first().click();
    await pop.locator('input[type=password]').fill(PW);
    await pop.locator('button[type=submit]').click();
    await pop.getByText('TOTAL ASSETS').waitFor({ timeout: 90000 }); // Grofty restores its session slowly after unlock
    await pop.waitForTimeout(3000);
  }
  if (await pop.getByRole('button', { name: 'Later' }).count()) await pop.getByRole('button', { name: 'Later' }).click({ force: true });
  while (await pop.getByRole('button', { name: 'Reject' }).count()) { await pop.getByRole('button', { name: 'Reject' }).first().click({ force: true }); await pop.waitForTimeout(1500); }
  // Start from a wallet that has never seen this desk, so the connection request shows.
  await pop.evaluate(() => { location.hash = '#/settings/connected'; });
  await pop.waitForTimeout(2500);
  while (await pop.getByRole('button', { name: 'REVOKE' }).count()) { await pop.getByRole('button', { name: 'REVOKE' }).first().click({ force: true }); await pop.waitForTimeout(1500); }
  await pop.evaluate(() => { location.hash = '#/dashboard'; });
  // The popup runs as a tab here; a request shows up in it after a reload. Approve and wait.
  const approve = async (title, button, name) => {
    for (let i = 0; ; i++) {
      // Reloading while Grofty is still taking the request in loses it; look first, reload rarely.
      await pop.waitForTimeout(3000);
      if (i % 5 === 4) { await pop.reload(); await pop.waitForTimeout(3000); }
      if ((await pop.locator('body').innerText()).includes(title)) break;
      if (i === 40) throw new Error(`no "${title}" in Grofty`);
    }
    await pop.bringToFront(); await shot(pop, name);
    await pop.getByRole('button', { name: button }).click({ force: true });
    await wait(1500);
  };

  const d = await ctx.newPage();
  deskVideo = d.video(); popVideo = pop.video();
  t0 = Date.now();
  ev.videoPopupOffset = (popAt - t0) / 1000;
  d.on('console', (m) => m.type() === 'error' && console.error('desk console:', m.text()));
  d.on('pageerror', (e) => console.error('desk error:', e.message));
  await d.goto(`${DESK}/desk?role=borrower`);
  await d.waitForSelector('#view table, #view .card', { timeout: 30000 }).catch(() => {});
  mark('Local desk, borrower role bound to a Grofty TestNet wallet: its commands need that wallet\'s signature');
  await wait(2500);

  // 1. Connect
  await d.click('#wallet');
  mark('Connect: the dapp-sdk picker finds the Grofty extension');
  let pick;
  // The picker shows once; afterwards the SDK goes straight to the wallet it remembers.
  // ponytail: the first click sometimes opens nothing in a fresh browser; click again until it does.
  for (let i = 0; i < 60 && !pick; i++) {
    await wait(1000); pick = ctx.pages().find((x) => x.url().startsWith('blob:'));
    if (i % 15 === 14 && !pick) await d.click('#wallet');
  }
  if (pick) { await pick.waitForTimeout(1500); await pick.getByText('GROFTY Wallet').click(); }
  mark('Grofty asks to connect the desk');
  await approve('Connection Request', 'Connect', 'connect');
  await d.bringToFront();
  await d.waitForSelector('#wallet-pay', { timeout: 60000 });
  ev.steps.push({ step: 'connect', at: new Date().toISOString(), result: (await d.textContent('#wallet-pay')).replace(/\s+/g, ' ').trim().slice(0, 300) });
  mark('Connected on canton:da-testnet: the panel names the wallet party and the role it drives');
  await shot(d, 'connected');
  await wait(3000);
  // Keep what the wallet answers (same module instance the desk uses).
  await d.evaluate(async () => {
    const { wallet } = await import('/wallet.js');
    const pay = wallet.pay.bind(wallet);
    wallet.pay = async (a) => { const r = await pay(a); window.PAID = r; return r; };
  });

  // 2. Signed desk commands
  const signed = async (label, click, name) => {
    const before = await d.locator('#wallet-receipts [data-verify]').count();
    mark(label);
    await click();
    await approve('Signature Request', 'Approve', name);
    await d.bringToFront();
    await d.waitForFunction((n) => document.querySelectorAll('#wallet-receipts [data-verify]').length > n, before, { timeout: 120000 });
  };
  await signed('Send request: the desk answers with a challenge naming the exact command; Grofty signs it',
    () => d.click('text=Send request'), 'sign-request');
  mark('Signature checked (key fingerprint = party namespace), RepoRFQ created, receipt listed');
  await d.locator('#wallet-receipts').scrollIntoViewIfNeeded();
  await wait(2500);
  await d.locator('#wallet-receipts [data-verify]').last().click();
  await d.locator('#wallet-receipts >> text=valid:').first().waitFor({ timeout: 30000 });
  mark('Verify signature: the desk re-checks it without trusting the browser');
  await shot(d, 'signed');
  await wait(3000);
  await d.locator('text=Take this quote').first().scrollIntoViewIfNeeded();
  await signed('Take this quote: the award is a second command, signed again in Grofty',
    () => d.locator('text=Take this quote').first().click(), 'sign-award');
  mark('Award executed on the desk ledger with the wallet\'s signature');
  await d.locator('#wallet-receipts').scrollIntoViewIfNeeded();
  await wait(3000);

  // 3. Venue fee on TestNet
  await d.locator('#wallet-pay').scrollIntoViewIfNeeded();
  await d.fill('#wp-amount', '1');
  await d.selectOption('#wp-token', 'CC');
  mark('Pay the venue fee: 1 CC on Canton TestNet, prepared by the desk, executed by Grofty');
  await d.click('#wp-pay');
  await approve('Transaction Request', 'Approve', 'pay');
  await d.bringToFront();
  await d.waitForFunction(() => !/Waiting/.test(document.getElementById('wp-out').textContent), null, { timeout: 200000 });
  const out = await d.textContent('#wp-out');
  mark(/update id/.test(out) ? 'Paid on TestNet: the wallet returns the update id' : 'The wallet refused the payment');
  await shot(d, 'paid');
  const paid = await d.evaluate(() => window.PAID ?? null);
  ev.steps.push({ step: 'venue fee payment (Grofty prepareExecuteAndWait)', at: new Date().toISOString(), amount: '1', token: 'CC',
    sender: WALLET_PARTY, receiver: PAY_TO, deskShows: out.trim(), updateId: paid?.tx?.payload?.updateId ?? null, walletAnswer: paid });
  await wait(4000);

  // The wallet's own record of the transfer.
  await pop.bringToFront();
  await pop.evaluate(() => { location.hash = '#/activity'; }); await pop.reload(); await pop.waitForTimeout(5000);
  await pop.getByRole('button', { name: 'Activity' }).click({ force: true }).catch(() => {});
  await pop.waitForTimeout(3000);
  ev.walletActivity = (await pop.locator('body').innerText()).split('\n').slice(0, 20).join(' | ');
  await shot(pop, 'activity');

  // Receipts, re-verified by the hosted desk (a separate deployment) and placed on the ledger.
  const receipts = await d.evaluate(async () => (await fetch('/api/wallet-receipts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'borrower' }) })).json());
  for (const r of receipts) {
    const hosted = await (await fetch(HOSTED, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: r.message, signature: r.signature, publicKey: r.publicKey, partyId: r.signer }) })).json();
    const tampered = await (await fetch(HOSTED, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: r.message + ' ', signature: r.signature, publicKey: r.publicKey, partyId: r.signer }) })).json();
    let offset = null;
    try {
      const u = await (await fetch(`${process.env.DEVNET_LEDGER_URL}/v2/updates/update-by-id`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updateId: r.updateId, updateFormat: { includeTransactions: { eventFormat: { filtersByParty: {}, filtersForAnyParty: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] }, verbose: false }, transactionShape: 'TRANSACTION_SHAPE_ACS_DELTA' } } }) })).json();
      offset = u.update?.Transaction?.value?.offset ?? null;
    } catch {}
    ev.steps.splice(-1, 0, { step: `signed desk command: ${/^action: (.*)$/m.exec(r.message)[1]}`, at: r.at, role: r.role, signer: r.signer,
      publicKey: r.publicKey, signature: r.signature, signedMessage: r.message, deskLedgerUpdateId: r.updateId, deskLedgerOffset: offset, created: r.created,
      hostedWalletVerify: hosted, hostedWalletVerifyTamperedMessage: { ok: tampered.ok, reason: tampered.reason } });
  }
  mark('Done');
} catch (e) {
  for (const [i, pg] of ctx.pages().entries()) { console.error('page', i, pg.url()); await pg.screenshot({ path: join(RAW, `fail-${i}.png`) }).catch(() => {}); }
  throw e;
} finally {
  await ctx.close();
  srv.kill();
}

// Video: the desk page, with the wallet tab inset bottom-right, both clipped to the desk's span.
writeFileSync(join(ROOT, 'media', 'grofty-wallet.marks.json'), JSON.stringify(marks, null, 1) + '\n');
const ts = (s) => new Date(s * 1000).toISOString().slice(11, 23).replace('.', ',');
writeFileSync(join(ROOT, 'media', 'grofty-wallet.srt'), marks.slice(0, -1).map((m, i) => `${i + 1}\n${ts(m.at)} --> ${ts(marks[i + 1].at)}\n${m.label}\n`).join('\n'));
const vids = { desk: await deskVideo.path(), wallet: await popVideo.path() };
ev.video = 'media/grofty-wallet.mp4';
ev.marks = marks;
writeFileSync(join(ROOT, 'docs', 'evidence', 'grofty-wallet-testnet.json'), JSON.stringify(ev, null, 1) + '\n');
const pip = 'crop=900:620:0:0,scale=540:372,setpts=PTS-STARTPTS';
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', vids.desk, '-ss', String(-ev.videoPopupOffset), '-i', vids.wallet, '-filter_complex',
  `[1:v]${pip}[w];[0:v]setpts=PTS-STARTPTS[d];[d][w]overlay=W-w-16:H-h-16:eof_action=pass,drawbox=x=882:y=510:w=544:h=376:color=0x15121c@1:t=2,`
  + "pad=1440:980:0:0:color=0x15121c,subtitles=grofty-wallet.srt:force_style='FontSize=10,MarginV=6'",
  '-an', '-c:v', 'libx264', '-crf', '22', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'grofty-wallet.mp4'], { cwd: join(ROOT, 'media') });
console.log('wrote media/grofty-wallet.mp4');
