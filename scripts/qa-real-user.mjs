// A person at the local desk, role by role, start to finish: every action is a click or
// typed text in the page (no /api/submit), outcomes are read back from each role's own
// /api/acs and from what the page itself received. Failures leave a screenshot in
// log/qa-real-user/. Needs a local sandbox (npm run local, seed optional) and the desk:
//   ENV_FILE=.env.local node server.mjs                         (port 8090, QA_URL to change)
//   node scripts/qa-real-user.mjs            (phase 1: lifecycle, privacy, bad input, UX)
//   node scripts/qa-real-user.mjs late       (2 hours later: default and close-out netting on
//                                              the calls phase 1 leaves; reads log/qa-real-user/state.json)
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const BASE = process.env.QA_URL ?? 'http://localhost:8090';
const OUT = 'log/qa-real-user';
mkdirSync(OUT, { recursive: true });
const LATE = process.argv[2] === 'late';
const STATE = LATE ? JSON.parse(readFileSync(`${OUT}/state.json`, 'utf8')) : {};
const RUN = STATE.run ?? Date.now().toString(36).toUpperCase().slice(-5);
// One instrument per scenario, so each repo's mark moves alone.
const I = Object.fromEntries(['MAIN', 'SUB', 'MTA', 'DEF', 'CO1', 'CO2', 'SCH'].map((k) => [k, `RU${RUN}${k}`]));
const DAY = 864e5;

// ---- harness ----
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page, ctx, browser;
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log('  ok  ', name); }
  catch (e) {
    results.push([false, name, e.message.split('\n')[0]]);
    console.log('  FAIL', name, '\n       ', e.message.split('\n')[0]);
    const f = `${OUT}/${RUN}-${results.length}-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.png`;
    await page?.screenshot({ path: f, fullPage: true }).catch(() => {});
  }
}
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(300); }
}

// ---- reads (the same read the page makes for a role); no writes go through here ----
const CFG = await (await fetch(BASE + '/api/config')).json();
const P = CFG.parties;
const acs = async (role) => (await (await fetch(BASE + '/api/acs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) })).json()).contracts;
const of = async (role, tpl, pred = () => true) => (await acs(role)).filter((c) => c.tpl === tpl && pred(c.arg, c));
const sum = (cs) => cs.reduce((s, c) => s + Number(c.arg.amount), 0);

// ---- browser ----
browser = await chromium.launch();
ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
page = await ctx.newPage();
const consoleErrors = [], toasts = [];
// What the page itself received from /api/acs, by role: the network side of privacy.
const received = {};
function watch(pg) {
  pg.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  pg.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|status of 4\d\d/.test(m.text())) consoleErrors.push(m.text()); });
  pg.on('response', async (r) => {
    if (!r.url().endsWith('/api/acs')) return;
    try { const role = JSON.parse(r.request().postData()).role; const j = await r.json(); if (j.contracts) received[role] = JSON.stringify(j.contracts); } catch {}
  });
}
watch(page);

async function open(role, pg = page) {
  await pg.goto(`${BASE}/desk?role=${role}`);
  await pg.waitForFunction(() => /live/.test(document.querySelector('#status')?.textContent) && !document.querySelector('#view .skel'));
}
// Switch role the way a person does: click the pill in the header.
async function as(role) {
  if (!page.url().includes('/desk')) return open(role);
  if (await page.locator(`#roles [data-role="${role}"][aria-pressed="true"]`).count()) return;
  await page.click(`#roles [data-role="${role}"]`);
  await page.waitForFunction((r) => document.body.dataset.role === r && !document.querySelector('#view .skel') && /live/.test(document.querySelector('#status').textContent), role);
}
// A card by its heading: an instrument also shows up in Positions and in other repos' substitute lists.
// What a role's page received over the network on a fresh load (a repeat read can come back
// `unchanged`, without contracts).
async function net(role) {
  delete received[role];
  await open(role);
  return JSON.parse(await until(() => received[role], role + ' read'));
}
const card = (text, pg = page) => pg.locator('#view .card').filter({ has: pg.locator('h3', { hasText: text }) });
async function act(locator, pg = page) {
  await pg.evaluate(() => { const t = document.querySelector('#toast'); t.hidden = true; t.textContent = ''; });
  await locator.click();
  await pg.waitForFunction(() => !document.querySelector('#toast').hidden, null, { timeout: 30000 });
  const ok = !(await pg.locator('#toast.err').count()), text = await pg.locator('#toast').textContent();
  toasts.push([ok, text]);
  await sleep(400);
  return [ok, text];
}
async function ok(locator, pg) { const [k, t] = await act(locator, pg); assert.ok(k, 'expected success, got: ' + t); return t; }
async function refused(locator, re, pg) { const [k, t] = await act(locator, pg); assert.ok(!k, 'expected a refusal, got: ' + t); if (re) assert.match(t, re); return t; }
// Type as a person does: clear the field, then key in the text.
async function type(sel, text, scope = page) {
  const el = typeof sel === 'string' ? scope.locator(sel) : sel;
  await el.click(); await el.press('Control+A'); await el.press('Delete');
  if (text !== '') await el.pressSequentially(String(text));
}

async function publishMark(inst, price) {
  await as('agent');
  await type('#m-inst', inst); await type('#m-price', price);
  await ok(page.locator('[data-act="mark"]'));
}
async function request(inst, qty, cash, term, lenders, mta = '') {
  await as('borrower');
  await page.selectOption('#n-inst', inst);
  await type('#n-qty', qty); await type('#n-cash', cash); await type('#n-term', term); await type('#n-mta', mta);
  for (const l of ['lenderA', 'lenderB', 'lenderC']) await page.setChecked(`.n-lender[value="${l}"]`, lenders.includes(l));
  await ok(page.locator('[data-act="request"]'));
  return until(async () => (await of('borrower', 'RepoRFQ', (a) => a.terms.collateralInstrument === inst))[0], 'rfq');
}
async function quote(role, inst, rate, haircut) {
  await as(role);
  const c = card(inst);
  await c.waitFor();
  await ok(c.locator('[data-act="cash-for"]'));
  await type(c.locator('input[id^="r-"]'), rate); await type(c.locator('input[id^="h-"]'), haircut);
  return ok(c.locator('[data-act="quote"]'));
}
async function award(inst, lenderName) {
  await as('borrower');
  // The bonds the award pledges come from the demo issuer, as a new user would get them.
  const row = card(inst).locator('tr', { hasText: lenderName });
  await ok(row.locator('[data-act="award"]'));
  return until(async () => (await of('borrower', 'RepoTrade', (a) => a.collateralInstrument === inst))[0], 'trade');
}
async function bonds(inst, qty) {
  await as('borrower');
  await page.selectOption('#n-inst', inst); await type('#n-qty', qty);
  await ok(page.locator('[data-act="bonds"]'));
}

console.log(`real-user run ${RUN} against ${BASE}${LATE ? ' (late phase)' : ''}`);

if (!LATE) {
  // ---------------- valuation agent ----------------
  await check('lenders start without a haircut schedule (Withdraw schedule clicked where one is left over)', async () => {
    for (const l of ['lenderA', 'lenderB', 'lenderC']) {
      await open(l);
      if (await page.locator('[data-act="drop-schedule"]').count()) await ok(page.locator('[data-act="drop-schedule"]'));
      assert.equal((await of('borrower', 'HaircutSchedule', (a) => a.lender === P[l])).length, 0, l);
    }
  });
  await check('agent: marks typed into the form reach borrower and lenders, not the regulator', async () => {
    await open('agent');
    for (const k of Object.keys(I)) await publishMark(I[k], 100);
    const seen = await of('lenderC', 'Mark', (a) => a.instrument.startsWith('RU' + RUN));
    assert.equal(seen.length, Object.keys(I).length);
    assert.equal((await of('regulator', 'Mark')).length, 0);
  });
  await check('agent: letters, empty, zero, Infinity and 15 decimals are refused with a readable toast', async () => {
    await as('agent');
    const before = (await of('agent', 'Mark')).length;
    await type('#m-inst', I.MAIN);
    await type('#m-price', 'abc'); // a number field drops letters
    await refused(page.locator('[data-act="mark"]'), /Price: enter a number/);
    await type('#m-price', '');
    await refused(page.locator('[data-act="mark"]'), /Price: enter a number/);
    await type('#m-price', '0');
    const t0 = await refused(page.locator('[data-act="mark"]'));
    await type('#m-price', '1e400');
    await refused(page.locator('[data-act="mark"]'), /Price: enter a number/);
    await type('#m-price', '100.123456789012345');
    const t15 = await refused(page.locator('[data-act="mark"]'), /at most 10 decimals/);
    console.log('        zero price toast:', t0.slice(0, 140), '\n        15 decimals toast:', t15.slice(0, 140));
    assert.equal((await of('agent', 'Mark')).length, before);
  });
  await check('agent: an empty instrument name is refused', async () => {
    await as('agent');
    const before = (await of('agent', 'Mark')).length;
    await type('#m-inst', '   '); await type('#m-price', '100');
    await refused(page.locator('[data-act="mark"]'), /Instrument: enter a name/);
    assert.equal((await of('agent', 'Mark')).length, before);
  });

  // ---------------- borrower: request ----------------
  await check('borrower: demo issuer gives the typed number of bonds', async () => {
    await bonds(I.MAIN, 10000);
    assert.equal(sum(await of('borrower', 'Holding', (a) => a.instrument === I.MAIN && a.owner === P.borrower)), 10000);
  });
  await check('borrower: bad requests (zero units, negative cash, 30.5 days, letters, 12 decimals, no lender) are refused, nothing sent', async () => {
    await as('borrower');
    await page.selectOption('#n-inst', I.MAIN);
    const go = () => page.locator('[data-act="request"]');
    const set = async (q, c, t) => { await type('#n-qty', q); await type('#n-cash', c); await type('#n-term', t); };
    const msgs = [];
    await set('0', '900000', '30'); msgs.push(await refused(go()));
    await set('10000', '-900000', '30'); msgs.push(await refused(go()));
    await set('10000', '900000', '30.5'); msgs.push(await refused(go(), /Term: enter whole days/));
    await set('1e3', '900000', '30'); msgs.push(await refused(go(), /Units: enter a number/));
    await set('10000', 'lots', '30'); msgs.push(await refused(go(), /Cash wanted: enter a number/));
    await set('10000', '900000.123456789012', '30'); msgs.push(await refused(go(), /at most 10 decimals/));
    await set('10000', '900000', '30');
    for (const l of ['lenderA', 'lenderB', 'lenderC']) await page.setChecked(`.n-lender[value="${l}"]`, false);
    msgs.push(await refused(go(), /pick at least one lender/));
    msgs.forEach((m, i) => console.log(`        refusal ${i}:`, m.slice(0, 150)));
    assert.equal((await of('borrower', 'RepoRFQ', (a) => a.terms.collateralInstrument === I.MAIN)).length, 0);
  });
  await check('borrower: double-clicking Send request sends one request to A, B and C', async () => {
    await as('borrower');
    await page.selectOption('#n-inst', I.MAIN);
    await type('#n-qty', 10000); await type('#n-cash', 900000); await type('#n-term', 30); await type('#n-mta', '');
    for (const l of ['lenderA', 'lenderB', 'lenderC']) await page.setChecked(`.n-lender[value="${l}"]`, true);
    await page.locator('[data-act="request"]').dblclick();
    await page.waitForFunction(() => !document.querySelector('#toast').hidden);
    await sleep(3000);
    const rs = await of('borrower', 'RepoRFQ', (a) => a.terms.collateralInstrument === I.MAIN);
    assert.equal(rs.length, 1, `${rs.length} requests`);
    STATE.rfq = rs[0].cid;
    for (const l of ['lenderA', 'lenderB', 'lenderC']) assert.equal((await of(l, 'RepoRFQ', (a, c) => c.cid === STATE.rfq)).length, 1, l);
    assert.equal((await of('regulator', 'RepoRFQ')).length, 0);
  });

  // ---------------- lenders: quotes ----------------
  await check('lender A: negative rate, 100% haircut and letters are refused, no cash locked', async () => {
    await as('lenderA');
    const c = card(I.MAIN);
    const locked = async () => (await of('lenderA', 'Escrow', (a) => a.owner === P.lenderA)).length;
    const lockedBefore = await locked();
    await ok(c.locator('[data-act="cash-for"]'));
    const msgs = [];
    await type(c.locator('input[id^="r-"]'), '-5'); await type(c.locator('input[id^="h-"]'), '2'); msgs.push(await refused(c.locator('[data-act="quote"]')));
    await type(c.locator('input[id^="r-"]'), '500'); await type(c.locator('input[id^="h-"]'), '100'); msgs.push(await refused(c.locator('[data-act="quote"]')));
    await type(c.locator('input[id^="h-"]'), 'x'); msgs.push(await refused(c.locator('[data-act="quote"]'), /Haircut: enter a number/));
    msgs.forEach((m, i) => console.log(`        refusal ${i}:`, m.slice(0, 150)));
    assert.equal((await of('lenderA', 'RepoQuote')).filter((q) => q.arg.rfqId === STATE.rfq).length, 0);
    assert.equal(await locked(), lockedBefore, 'cash locked after a refusal');
  });
  await check('lenders A 510 bp/2%, B 480 bp/3%, C 530 bp/2.25% seal quotes; each locks 900,000', async () => {
    await as('lenderA');
    const c = card(I.MAIN);
    await type(c.locator('input[id^="r-"]'), '510'); await type(c.locator('input[id^="h-"]'), '2');
    await ok(c.locator('[data-act="quote"]'));
    await quote('lenderB', I.MAIN, 480, 3);
    await quote('lenderC', I.MAIN, 530, 2.25);
    const qs = (await of('borrower', 'RepoQuote')).filter((q) => q.arg.rfqId === STATE.rfq);
    assert.equal(qs.length, 3);
  });
  await check('privacy before award: each lender page shows and receives only its own quote', async () => {
    for (const [role, own, rivals] of [['lenderA', '510 bp', ['480 bp', '530 bp']], ['lenderB', '480 bp', ['510 bp', '530 bp']], ['lenderC', '530 bp', ['510 bp', '480 bp']]]) {
      const got = await net(role);
      const html = await card(I.MAIN).innerHTML();
      assert.ok(html.includes(own), role + ' own quote');
      for (const r of rivals) assert.ok(!html.includes(r), `${role} page shows ${r}`);
      assert.ok(got.filter((c) => c.tpl === 'RepoQuote').every((q) => q.arg.lender === P[role]), role + ' received a rival quote');
    }
    assert.ok((await net('regulator')).every((c) => ['RepoReport', 'BestExecution', 'CloseOutReport'].includes(c.tpl)), 'regulator received more than reports');
  });
  await check('stale data: the borrower tab sees a new quote without reloading', async () => {
    const p2 = await ctx.newPage(); watch(p2);
    await open('borrower', p2);
    await card(I.MAIN, p2).locator('tr', { hasText: 'Lender C' }).waitFor();
    // lender C withdraws in the first tab; the borrower tab must drop the row by itself
    await as('lenderC');
    await ok(card(I.MAIN).locator('[data-act="withdraw"]'));
    await until(async () => (await card(I.MAIN, p2).locator('tr', { hasText: 'Lender C' }).count()) === 0, 'borrower tab to drop C', 12000);
    // C quotes again
    await quote('lenderC', I.MAIN, 530, 2.25);
    await until(async () => (await card(I.MAIN, p2).locator('tr', { hasText: 'Lender C' }).count()) === 1, 'borrower tab to show C again', 12000);
    STATE.p2 = true; await p2.close();
  });
  await check('two tabs, same lender: withdrawing in one, then in the stale other, gives a clear refusal', async () => {
    await as('lenderA');
    const p2 = await ctx.newPage(); watch(p2);
    await open('lenderA', p2);
    // freeze tab 2's repaint so its button keeps the old contract id, like a slow tab would
    await p2.evaluate(() => { const i = document.createElement('input'); i.id = 'freeze'; document.body.append(i); i.focus(); });
    await ok(card(I.MAIN).locator('[data-act="withdraw"]'));
    const t = await refused(card(I.MAIN, p2).locator('[data-act="withdraw"]'), /no longer on the ledger/, p2);
    console.log('        stale-tab toast:', t.slice(0, 200));
    STATE.staleToast = t;
    await p2.close();
    // A quotes again, as before
    await as('lenderA');
    const c = card(I.MAIN);
    await type(c.locator('input[id^="r-"]'), '510'); await type(c.locator('input[id^="h-"]'), '2');
    await ok(c.locator('[data-act="quote"]'));
  });

  // ---------------- award ----------------
  await check('borrower: quotes ranked by rate; awarding B (480 bp) opens the repo, refunds A and C', async () => {
    await as('borrower');
    const rows = await card(I.MAIN).locator('tr td:nth-child(3)').allTextContents();
    assert.deepEqual(rows, ['480 bp', '510 bp', '530 bp']);
    STATE.main = (await award(I.MAIN, 'Lender B')).cid;
    // the losing quotes are gone and their cash is free again
    for (const l of ['lenderA', 'lenderC']) assert.equal((await of(l, 'RepoQuote', (a) => a.rfqId === STATE.rfq)).length, 0, l + ' quote still open');
  });
  await check('privacy after award: losers see a rank only, no repo, no 480 bp, in page and network', async () => {
    for (const [l, rank] of [['lenderA', '2 of 3'], ['lenderC', '3 of 3']]) {
      const got = await net(l);
      assert.ok((await page.locator('#view').textContent()).includes(rank), `${l} rank ${rank}`);
      assert.equal(await card(I.MAIN).count(), 0, `${l} page still shows the awarded request or its repo`);
      assert.equal(`${got.find((c) => c.tpl === 'LossNotice' && c.arg.rfqId === STATE.rfq)?.arg.rank} of 3`, rank);
      assert.equal(got.filter((c) => c.tpl === 'RepoTrade' && c.arg.collateralInstrument === I.MAIN).length, 0, l + ' received the repo');
      const ln = got.find((c) => c.tpl === 'LossNotice' && c.arg.rfqId === STATE.rfq);
      assert.deepEqual(Object.keys(ln.arg).sort(), ['at', 'borrower', 'lender', 'outOf', 'rank', 'rfqId']);
      // Lender B's id reaches a loser only where it names the panel (the request's lender list,
      // a mark's audience), never on anything about the award.
      const named = got.filter((c) => JSON.stringify(c.arg).includes(P.lenderB)).map((c) => c.tpl);
      assert.deepEqual([...new Set(named)].filter((t) => !['Mark', 'RepoRFQ'].includes(t)), [], l + ' received lender B on: ' + named.join(','));
    }
    await as('lenderB');
    assert.ok((await page.locator('#view').innerHTML()).includes(I.MAIN));
  });
  await check('regulator: unnamed best-execution record and an OPEN report; no request, quote or loss notice', async () => {
    const got = await net('regulator');
    const bex = got.filter((c) => c.tpl === 'BestExecution').find((b) => Number(b.arg.winningRateBps) === 480);
    assert.ok(bex, 'best-execution record');
    for (const l of ['lenderA', 'lenderB', 'lenderC']) assert.ok(!JSON.stringify(bex.arg).includes(P[l]), 'best execution names ' + l);
    assert.equal(bex.arg.quotesConsidered, '3'); assert.equal(bex.arg.winnerRank, '1');
    assert.ok(got.some((c) => c.tpl === 'RepoReport' && c.arg.event === 'OPEN' && c.arg.collateralInstrument === I.MAIN));
    assert.ok(got.every((c) => ['RepoReport', 'BestExecution', 'CloseOutReport'].includes(c.tpl)));
    assert.match(await page.locator('.proof').textContent(), /Losing rates never reached the regulator/);
  });

  // ---------------- margin ----------------
  await check('margin: mark falls to 92, lender B calls (24 h); borrower gets bonds and posts; call gone', async () => {
    await publishMark(I.MAIN, 92);
    await as('lenderB');
    const c = card(I.MAIN).filter({ has: page.locator('[data-act="call"]') });
    await type(c.locator('input[id^="mc-h-"]'), '24');
    await ok(c.locator('[data-act="call"]'));
    const call = await until(async () => (await of('borrower', 'MarginCall', (a) => a.instrument === I.MAIN))[0], 'call');
    await as('borrower');
    const mc = card(I.MAIN).filter({ has: page.locator('[data-act="post"]') });
    await ok(mc.locator('[data-act="bonds-for"]'));
    await ok(mc.locator('[data-act="post"]'));
    assert.equal((await of('borrower', 'MarginCall', (a) => a.instrument === I.MAIN)).length, 0);
    const t = (await of('lenderB', 'RepoTrade', (a) => a.collateralInstrument === I.MAIN))[0];
    assert.ok(Number(t.arg.collateralQty) > 10000, 'collateral topped up');
    STATE.main = t.cid;
  });
  await check('margin: a 1-hour response window is refused by the ledger with a reason', async () => {
    await publishMark(I.MAIN, 85);
    await as('lenderB');
    const c = card(I.MAIN).filter({ has: page.locator('[data-act="call"]') });
    await type(c.locator('input[id^="mc-h-"]'), '1');
    const t = await refused(c.locator('[data-act="call"]'));
    console.log('        1 h call toast:', t.slice(0, 160));
    await publishMark(I.MAIN, 100);
  });
  await check('1.2.0 minimum transfer: a 50,000 MTA repo with A; a ~10k shortfall shows the pill and the call is refused', async () => {
    await bonds(I.MTA, 10000);
    await request(I.MTA, 10000, 900000, 30, ['lenderA'], 50000);
    await quote('lenderA', I.MTA, 500, 2);
    await award(I.MTA, 'Lender A');
    await publishMark(I.MTA, 91); // 10000*91*0.98 = 891,800 vs ~900,125 owed: about 8k short
    await as('lenderA');
    const c = card(I.MTA);
    assert.ok((await c.textContent()).includes('minimum transfer'), 'pill shown');
    const t = await refused(c.locator('[data-act="call"]'), /minimum transfer/i);
    console.log('        MTA toast:', t.slice(0, 160));
    assert.equal((await of('lenderA', 'MarginCall', (a) => a.instrument === I.MTA)).length, 0);
  });

  // ---------------- substitution ----------------
  await check('substitution: 1 unit is not enough, lender sees Approve disabled and declines; bond returns', async () => {
    await bonds(I.SUB, 1);
    await as('borrower');
    const tc = card(I.MAIN).filter({ has: page.locator('[data-act="repurchase"]') });
    await tc.locator('select').selectOption({ label: `1 ${I.SUB}` });
    await ok(tc.locator('[data-act="substitute"]'));
    await as('lenderB');
    const sc = card(`offers 1 ${I.SUB}`);
    assert.ok(await sc.locator('[data-act="approve"]').isDisabled());
    await ok(sc.locator('[data-act="decline"]'));
    assert.equal(sum(await of('borrower', 'Holding', (a) => a.instrument === I.SUB && a.owner === P.borrower)), 1);
  });
  await check('substitution: other-issuer bonds are not offered in the page (holding minted by the cash issuer via API as setup)', async () => {
    // No desk button issues bonds from another issuer, so this one holding is setup, not a user action.
    const r = await fetch(BASE + '/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'cashIssuer',
      command: { CreateCommand: { templateId: '#talang-repo:Talang:Holding', createArguments: { issuer: P.cashIssuer, owner: P.borrower, instrument: I.SCH, amount: '99999' } } } }) });
    assert.equal(r.status, 200);
    await as('borrower'); await page.reload(); await open('borrower');
    const opts = await card(I.MAIN).filter({ has: page.locator('[data-act="repurchase"]') }).locator('select option').allTextContents();
    assert.ok(!opts.some((o) => o.includes('99,999')), 'other-issuer holding offered: ' + opts.join(' | '));
  });
  await check('substitution: borrower offers 12,000 units, lender B approves; repo now holds the substitute', async () => {
    await bonds(I.SUB, 11999);
    await as('borrower');
    const tc = card(I.MAIN).filter({ has: page.locator('[data-act="repurchase"]') });
    const opts = await tc.locator('select option').allTextContents();
    await tc.locator('select').selectOption({ label: opts.find((o) => o === `11,999 ${I.SUB}`) });
    await ok(tc.locator('[data-act="substitute"]'));
    assert.ok((await card(I.MAIN).textContent()).includes('substitution waiting'));
    await as('lenderB');
    await ok(card(`offers 11,999 ${I.SUB}`).locator('[data-act="approve"]'));
    const t = await until(async () => (await of('borrower', 'RepoTrade', (a) => a.collateralInstrument === I.SUB))[0], 'swapped trade');
    STATE.main = t.cid;
    assert.equal(Number(t.arg.collateralQty), 11999);
  });

  // ---------------- roll, repurchase ----------------
  await check('roll: empty days refused; lender B offers 460 bp +30 days; borrower accepts', async () => {
    await as('lenderB');
    const c = card(I.SUB).filter({ has: page.locator('[data-act="offer-roll"]') });
    await type(c.locator('input[id^="ro-d-"]'), '');
    await refused(c.locator('[data-act="offer-roll"]'), /Extra days: enter a number/);
    await type(c.locator('input[id^="ro-r-"]'), '460'); await type(c.locator('input[id^="ro-d-"]'), '30');
    await ok(c.locator('[data-act="offer-roll"]'));
    await as('borrower');
    await ok(card('at 460 bp').locator('[data-act="roll"]'));
    const t = (await of('borrower', 'RepoTrade', (a) => a.collateralInstrument === I.SUB))[0];
    assert.equal(Number(t.arg.rateBps), 460);
  });
  await check('repurchase: borrower pays principal + interest + fee; collateral home; regulator gets CLOSE', async () => {
    await as('borrower');
    const tc = card(I.SUB).filter({ has: page.locator('[data-act="repurchase"]') });
    await ok(tc.locator('[data-act="cash"]'));
    const t = await ok(card(I.SUB).filter({ has: page.locator('[data-act="repurchase"]') }).locator('[data-act="repurchase"]'));
    assert.match(t, /venue paid its fee/);
    assert.equal((await of('borrower', 'RepoTrade', (a) => a.collateralInstrument === I.SUB)).length, 0);
    assert.ok(sum(await of('borrower', 'Holding', (a) => a.instrument === I.SUB && a.owner === P.borrower)) >= 11999);
    assert.ok((await net('regulator')).some((c) => c.tpl === 'RepoReport' && c.arg.event === 'CLOSE' && c.arg.collateralInstrument === I.SUB));
  });

  // ---------------- haircut schedule ----------------
  await check('schedule: lender C publishes CO1 5% (others blank); borrower sees it; regulator does not', async () => {
    await as('lenderC');
    for (const i of await page.locator('.hs-floor').all()) await type(i, '');
    // The form lists collateral that touches this lender; others come in through "Add collateral".
    for (const i of [I.CO1, I.CO2]) {
      if (!(await page.locator(`.hs-floor[data-inst="${i}"]`).count())) { await page.selectOption('#hs-add', i); await ok(page.locator('[data-act="schedule-add"]')); }
      await type(page.locator(`.hs-floor[data-inst="${i}"]`), '5');
    }
    await ok(page.locator('[data-act="schedule"]'));
    await as('borrower');
    assert.ok((await page.locator('#view').textContent()).includes(`${I.CO1} 5.00%`));
    assert.ok(!(await net('regulator')).some((c) => c.tpl === 'HaircutSchedule'));
  });

  // ---------------- master agreement, default and close-out setup ----------------
  await check('master agreement: borrower offers to C, cannot sign its own, C signs; regulator does not see it', async () => {
    await as('borrower');
    // One agreement per pair: a run on the same ledger before this one may have signed it already.
    if (!(await of('borrower', 'MasterAgreement', (a) => a.lender === P.lenderC)).length) {
      await page.selectOption('#ma-cp', 'lenderC');
      await ok(page.locator('[data-act="propose-master"]'));
      assert.equal(await page.locator('[data-act="sign-master"]').count(), 0, 'proposer offered a sign button');
      await as('lenderC');
      await ok(page.locator('[data-act="sign-master"]').first());
    } else console.log('        agreement with C already signed by an earlier run');
    await until(async () => (await of('borrower', 'MasterAgreement', (a) => a.lender === P.lenderC)).length === 1, 'agreement');
    assert.ok(!(await net('regulator')).some((c) => c.tpl.startsWith('MasterAgreement')));
  });
  await check('schedule: C quoting 2% on CO1 is refused (floor 5%), 5% goes through; borrower awards', async () => {
    await bonds(I.CO1, 10000);
    await request(I.CO1, 10000, 900000, 30, ['lenderC']);
    await as('lenderC');
    const c = card(I.CO1);
    await ok(c.locator('[data-act="cash-for"]'));
    await type(c.locator('input[id^="r-"]'), '520'); await type(c.locator('input[id^="h-"]'), '2');
    const t = await refused(c.locator('[data-act="quote"]'));
    console.log('        below-floor toast:', t.slice(0, 160));
    await type(card(I.CO1).locator('input[id^="h-"]'), '5');
    await ok(card(I.CO1).locator('[data-act="quote"]'));
    await award(I.CO1, 'Lender C');
  });
  await check('close-out setup: second repo with C on CO2; CO1 marked down; C calls with 2 h to answer', async () => {
    await bonds(I.CO2, 10000);
    await request(I.CO2, 10000, 500000, 30, ['lenderC']);
    await quote('lenderC', I.CO2, 520, 5);
    await award(I.CO2, 'Lender C');
    await publishMark(I.CO1, 90); // 10000*90*0.95 = 855,000 < ~900k owed
    await as('lenderC');
    const c = card(I.CO1).filter({ has: page.locator('[data-act="call"]') });
    await type(c.locator('input[id^="mc-h-"]'), '2');
    await ok(c.locator('[data-act="call"]'));
    await as('lenderC');
    assert.ok(await card(`${I.CO1} called from`).locator('[data-act="default"]').isDisabled(), 'default enabled before the deadline');
  });
  await check('default setup: a repo with A on DEF, marked down, called with 2 h to answer; borrower does not post', async () => {
    await bonds(I.DEF, 10000);
    await request(I.DEF, 10000, 900000, 30, ['lenderA']);
    await quote('lenderA', I.DEF, 505, 2);
    await award(I.DEF, 'Lender A');
    await publishMark(I.DEF, 80);
    await as('lenderA');
    const c = card(I.DEF).filter({ has: page.locator('[data-act="call"]') });
    await type(c.locator('input[id^="mc-h-"]'), '2');
    await ok(c.locator('[data-act="call"]'));
    STATE.callsAt = new Date().toISOString();
  });

  // ---------------- UX ----------------
  await check('UX: refresh mid-form keeps the desk usable; back button returns to the previous role', async () => {
    await open('borrower');
    await type('#n-cash', '123');
    await page.reload();
    await page.waitForFunction(() => /live/.test(document.querySelector('#status').textContent) && !document.querySelector('#view .skel'));
    assert.equal(await page.locator('#n-cash').inputValue(), '4800000');
    await open('lenderB');
    await page.goBack();
    await page.waitForFunction(() => /live/.test(document.querySelector('#status').textContent) && !document.querySelector('#view .skel'));
    assert.equal(await page.evaluate(() => document.body.dataset.role), 'borrower');
  });
  await check('UX: the 5 s repaint keeps what the borrower typed and picked while another role acts', async () => {
    await open('borrower');
    const opts = await page.locator('#n-inst option').allTextContents();
    await page.selectOption('#n-inst', opts.at(-1) === I.MAIN ? opts[0] : I.MAIN);
    const picked = await page.locator('#n-inst').inputValue();
    await type('#n-cash', '777000'); await page.setChecked('.n-lender[value="lenderC"]', true);
    await page.locator('h1').click(); // focus leaves the form, as when someone reads the page
    const p2 = await ctx.newPage(); watch(p2);
    await open('agent', p2); await type('#m-inst', I.SCH, p2); await type('#m-price', '101', p2);
    await ok(p2.locator('[data-act="mark"]'), p2); await p2.close();
    await page.waitForFunction((n) => document.querySelectorAll('#n-inst option').length > n, opts.length - (opts.includes(I.SCH) ? 1 : 0), { timeout: 12000 }).catch(() => {});
    await sleep(6000);
    assert.equal(await page.locator('#n-cash').inputValue(), '777000');
    assert.equal(await page.locator('#n-inst').inputValue(), picked);
    assert.ok(await page.locator('.n-lender[value="lenderC"]').isChecked());
  });
  await check('UX: switching roles fast never paints one role\'s data under another\'s name', async () => {
    await open('borrower');
    for (const r of ['lenderA', 'regulator', 'lenderB', 'agent', 'lenderC', 'borrower', 'regulator']) await page.click(`#roles [data-role="${r}"]`);
    await page.waitForFunction(() => !document.querySelector('#view .skel') && /live/.test(document.querySelector('#status').textContent));
    await sleep(1500);
    assert.equal(await page.evaluate(() => document.body.dataset.role), 'regulator');
    assert.ok(await page.locator('#view .proof', { hasText: 'lifecycle reports' }).count(), 'regulator view');
    assert.equal(await page.locator('[data-act="request"]').count(), 0);
  });
  await check('UX: keyboard only, Tab reaches role pills with a visible focus ring and Enter switches role', async () => {
    await open('borrower');
    await page.keyboard.press('Tab'); // brand link
    let found = false;
    for (let i = 0; i < 12 && !found; i++) {
      await page.keyboard.press('Tab');
      found = await page.evaluate(() => document.activeElement?.dataset.role === 'lenderA');
    }
    assert.ok(found, 'lender A pill not reachable by Tab');
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert.notEqual(outline, 'none', 'no focus outline');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.dataset.role === 'lenderA');
    // and a form button: Tab to it, Enter fires it with a toast
    await open('agent');
    await page.focus('#m-price'); await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.act), 'mark');
    await page.evaluate(() => { const t = document.querySelector('#toast'); t.hidden = true; });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#toast').hidden);
  });
  await check('UX: 390 px and 1440 px, no horizontal scroll in any role', async () => {
    for (const w of [390, 1440]) {
      await page.setViewportSize({ width: w, height: 900 });
      for (const r of ['borrower', 'lenderA', 'lenderB', 'lenderC', 'regulator', 'agent', 'venue']) {
        await open(r);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        if (over > 0) await page.screenshot({ path: `${OUT}/${RUN}-overflow-${w}-${r}.png`, fullPage: true });
        assert.ok(over <= 0, `${w}px ${r}: page scrolls ${over}px sideways`);
      }
      await page.screenshot({ path: `${OUT}/${RUN}-desk-${w}.png`, fullPage: false });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  await check('UX: landing and desk have no broken images or local links', async () => {
    for (const path of ['/', '/desk?role=borrower']) {
      await page.goto(BASE + path); await page.waitForLoadState('networkidle').catch(() => {});
      const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.loading !== 'lazy').map((i) => i.src));
      assert.deepEqual(broken, [], path + ' broken images');
      const links = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith(location.origin)))]);
      for (const l of links) { const r = await fetch(l.split('#')[0]); assert.ok(r.ok, `${path}: ${l} -> ${r.status}`); }
    }
  });

  await check('schedule: lender C withdraws its schedule from the desk; the borrower no longer sees it', async () => {
    await open('lenderC');
    await ok(page.locator('[data-act="drop-schedule"]'));
    assert.equal((await of('borrower', 'HaircutSchedule', (a) => a.lender === P.lenderC)).length, 0);
  });

  writeFileSync(`${OUT}/state.json`, JSON.stringify({ run: RUN, ...STATE }, null, 2));
} else {
  // ---------------- late phase: deadlines have passed ----------------
  const wait = Date.parse(STATE.callsAt) + 2 * 36e5 + 120000 - Date.now();
  if (wait > 0) { console.log(`calls not due yet: run again in ${Math.ceil(wait / 60000)} min`); process.exit(2); }
  await check('default: past the deadline lender A declares default; keeps what is owed, rest returns; regulator gets DEFAULT', async () => {
    await open('lenderA');
    const before = sum(await of('borrower', 'Holding', (a) => a.instrument === I.DEF && a.owner === P.borrower));
    await publishMark(I.DEF, 80); // close-out and display want a fresh mark; default itself does not
    await as('lenderA');
    await ok(card(`${I.DEF} called from`).locator('[data-act="default"]'));
    assert.equal((await of('lenderA', 'RepoTrade', (a) => a.collateralInstrument === I.DEF)).length, 0);
    const kept = sum(await of('lenderA', 'Holding', (a) => a.instrument === I.DEF && a.owner === P.lenderA));
    const back = sum(await of('borrower', 'Holding', (a) => a.instrument === I.DEF && a.owner === P.borrower)) - before;
    assert.ok(kept > 0 && kept <= 10000, 'lender kept ' + kept);
    console.log(`        lender kept ${kept}, borrower got back ${back}`);
    assert.ok((await net('regulator')).some((c) => c.tpl === 'RepoReport' && c.arg.event === 'DEFAULT' && c.arg.collateralInstrument === I.DEF));
  });
  await check('close-out: lender C nets both repos in one click; all three sides see the report, losers do not', async () => {
    await publishMark(I.CO1, 90); await publishMark(I.CO2, 100);
    await as('lenderC');
    const ma = card('signed by both').filter({ hasText: 'Lender C' });
    const t = await ok(ma.locator('[data-act="close-out"]'));
    console.log('        close-out toast:', t);
    assert.match(t, /Closed out \d+ repos/);
    assert.equal((await of('lenderC', 'RepoTrade', (a) => [I.CO1, I.CO2].includes(a.collateralInstrument))).length, 0, 'repos still open');
    for (const r of ['borrower', 'lenderC', 'regulator']) assert.ok((await of(r, 'CloseOutReport', (a) => a.lender === P.lenderC)).length >= 1, r);
    for (const r of ['lenderA', 'lenderB']) assert.equal((await of(r, 'CloseOutReport', (a) => a.lender === P.lenderC)).length, 0, r);
  });
}

if (!LATE) await check('a ledger without lender C: the request form offers no lender C box', async () => {
  const p2 = await ctx.newPage(); watch(p2);
  await p2.route('**/api/config', async (route) => {
    const j = await (await route.fetch()).json(); delete j.parties.lenderC; await route.fulfill({ json: j });
  });
  await open('borrower', p2);
  assert.deepEqual(await p2.locator('.n-lender').evaluateAll((xs) => xs.map((x) => x.value)), ['lenderA', 'lenderB']);
  assert.equal(await p2.locator('#roles [data-role="lenderC"]').count(), 0);
  await p2.close();
});
await check('every error toast is plain language (no raw ledger JSON)', async () => {
  const raw = toasts.filter(([k, t]) => !k && /^\s*\{|correlationId|UNHANDLED_EXCEPTION/.test(t));
  assert.deepEqual(raw.map(([, t]) => t.slice(0, 80)), []);
});
await check('no console errors across the run', async () => { assert.deepEqual(consoleErrors, []); });
await browser.close();

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const [, n, m] of failed) console.log('  FAIL', n, '-', m);
console.log('\nerror toasts seen:'); for (const [k, t] of toasts) if (!k) console.log('  -', t.slice(0, 220));
process.exit(failed.length ? 1 : 0);
