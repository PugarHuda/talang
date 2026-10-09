// End-to-end QA of the desk: every role, every action button, read back from each
// party's own /api/acs (not from toasts), plus refusals, privacy, a11y basics and a
// 390 px layout. Runs against a local sandbox with its own fresh instruments, so it
// does not disturb seeded scenarios.
//   PORT=8092 ENV_FILE=.env.local node server.mjs
//   READ_ONLY=1 PORT=8093 ENV_FILE=.env.local node server.mjs     (read-only checks)
//   node scripts/qa-desk.mjs        (QA_URL, QA_RO_URL to point elsewhere)
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

const BASE = process.env.QA_URL ?? 'http://localhost:8092';
const RO = process.env.QA_RO_URL ?? 'http://localhost:8093';
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const IA = `QA${RUN}A`, IB = `QA${RUN}B`, IC = `QA${RUN}C`, IS = `QA${RUN}S`;
const ROLES = ['borrower', 'lenderA', 'lenderB', 'lenderC', 'regulator', 'agent', 'venue'];
const PKG = '#talang-repo:Talang:';
const DAY = 864e5;

// ---- tiny harness ----
const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log('  ok  ', name); }
  catch (e) { results.push([false, name, e.message]); console.log('  FAIL', name, '\n       ', e.message.split('\n')[0]); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(300);
  }
}

// ---- ledger through the desk API ----
const postJ = async (base, path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const CFG = await (await fetch(BASE + '/api/config')).json();
const P = CFG.parties;
const acs = async (role) => (await postJ(BASE, '/api/acs', { role })).json.contracts;
const of = async (role, tpl, pred = () => true) => (await acs(role)).filter((c) => c.tpl === tpl && pred(c.arg, c));
async function submit(role, command) {
  const r = await postJ(BASE, '/api/submit', { role, command });
  if (r.status !== 200) throw new Error(`${role}: ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json;
}
const create = (tpl, args) => ({ CreateCommand: { templateId: PKG + tpl, createArguments: args } });
const exercise = (tpl, cid, choice, arg = {}) => ({ ExerciseCommand: { templateId: PKG + tpl, contractId: cid, choice, choiceArgument: arg } });
const createdCid = (tx, tpl) => (tx?.transaction?.events ?? []).map((e) => e.CreatedEvent).filter(Boolean)
  .find((c) => c.templateId?.endsWith(':Talang:' + tpl))?.contractId;
const mint = async (issuerRole, owner, instrument, amount) =>
  createdCid(await submit(issuerRole, create('Holding', { issuer: P[issuerRole], owner: P[owner], instrument, amount: String(amount) })), 'Holding');
const markApi = (instrument, price, asOf = new Date().toISOString()) => submit('agent', create('Mark', { agent: P.agent, instrument,
  price: String(price), asOf, audience: [P.borrower, P.lenderA, P.lenderB, P.lenderC] }));
const sum = (cs) => cs.reduce((s, c) => s + Number(c.arg.amount), 0);

// ---- browser ----
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) consoleErrors.push(m.text()); });

async function open(role, extra = '', base = BASE, pg = page) {
  await pg.goto(`${base}/desk?role=${role}${extra}`);
  await pg.waitForFunction(() => /live/.test(document.querySelector('#status')?.textContent) && !document.querySelector('#view .skel'));
}
const card = (text) => page.locator('#view .card', { hasText: text });
// Click an action and wait for its toast; returns [ok, text].
async function act(locator) {
  await page.evaluate(() => { const t = document.querySelector('#toast'); t.hidden = true; t.textContent = ''; });
  await locator.click();
  await page.waitForFunction(() => !document.querySelector('#toast').hidden, null, { timeout: 30000 });
  const err = await page.locator('#toast.err').count();
  const text = await page.locator('#toast').textContent();
  // the success path repaints after the toast; wait for the busy flag to clear
  await sleep(400);
  return [!err, text];
}
async function actOk(locator) { const [ok, t] = await act(locator); assert.ok(ok, 'expected success, got: ' + t); return t; }
async function actErr(locator, re) { const [ok, t] = await act(locator); assert.ok(!ok, 'expected a refusal, got: ' + t); if (re) assert.match(t, re); return t; }

console.log(`QA run ${RUN} against ${BASE}`);
let trade, rfqA;

// ---------- agent: marks ----------
await check('agent publishes marks via the form; borrower and lenders see them', async () => {
  await open('agent');
  for (const [i, p] of [[IA, 100], [IB, 100], [IC, 100]]) {
    await page.fill('#m-inst', i); await page.fill('#m-price', String(p));
    await actOk(page.locator('[data-act="mark"]'));
  }
  for (const r of ['borrower', 'lenderA', 'lenderC']) assert.equal((await of(r, 'Mark', (a) => [IA, IB, IC].includes(a.instrument))).length, 3, r);
  assert.equal((await of('regulator', 'Mark')).length, 0, 'regulator sees no marks');
});
await check('mark: empty and NaN price refused in the page, negative refused by the ledger, nothing created', async () => {
  const before = (await of('agent', 'Mark', (a) => a.instrument === IS)).length;
  await page.fill('#m-inst', IS);
  await page.fill('#m-price', '');
  await actErr(page.locator('[data-act="mark"]'), /Price: enter a number/);
  await page.evaluate(() => { const e = document.querySelector('#m-price'); e.type = 'text'; e.value = 'abc'; });
  await actErr(page.locator('[data-act="mark"]'), /Price: enter a number/);
  await page.evaluate(() => { document.querySelector('#m-price').type = 'number'; });
  await page.fill('#m-price', '-1');
  await actErr(page.locator('[data-act="mark"]'));
  assert.equal((await of('agent', 'Mark', (a) => a.instrument === IS)).length, before);
});
await check('stale mark is labelled stale in the agent view', async () => {
  await markApi(IS, 100, new Date(Date.now() - 2 * DAY).toISOString());
  await open('agent');
  await assert.doesNotReject(page.locator('#view tr', { hasText: IS }).locator('.pill', { hasText: 'stale' }).waitFor({ timeout: 5000 }));
});

// ---------- borrower: request ----------
await check('borrower: bond faucet issues the units typed', async () => {
  await open('borrower');
  await page.selectOption('#n-inst', IA); await page.fill('#n-qty', '10000');
  await actOk(page.locator('[data-act="bonds"]'));
  assert.equal(sum(await of('borrower', 'Holding', (a) => a.instrument === IA && a.owner === P.borrower)), 10000);
});
await check('borrower: request with empty / negative cash is refused, no RFQ', async () => {
  await page.fill('#n-cash', ''); await actErr(page.locator('[data-act="request"]'), /Cash wanted: enter a number/);
  await page.fill('#n-cash', '-5'); await actErr(page.locator('[data-act="request"]'));
  assert.equal((await of('borrower', 'RepoRFQ', (a) => a.terms.collateralInstrument === IA)).length, 0);
});
await check('borrower: request reaches the three invited lenders and not the regulator', async () => {
  await page.selectOption('#n-inst', IA); await page.fill('#n-qty', '10000'); await page.fill('#n-cash', '900000'); await page.fill('#n-term', '30');
  await page.check('.n-lender[value="lenderC"]');
  await actOk(page.locator('[data-act="request"]'));
  const [r] = await of('borrower', 'RepoRFQ', (a) => a.terms.collateralInstrument === IA);
  assert.ok(r, 'rfq created'); rfqA = r.cid;
  assert.equal(r.arg.lenders.length, 3);
  for (const l of ['lenderA', 'lenderB', 'lenderC']) assert.equal((await of(l, 'RepoRFQ', (a, c) => c.cid === rfqA)).length, 1, l);
  assert.equal((await of('regulator', 'RepoRFQ')).length, 0);
});

// ---------- lenders: quotes ----------
async function quoteAs(role, rate, haircutPct) {
  await open(role);
  const c = card(IA);
  await actOk(c.locator('[data-act="cash-for"]'));
  await c.locator('input[id^="r-"]').fill(String(rate)); await c.locator('input[id^="h-"]').fill(String(haircutPct));
  await actOk(c.locator('[data-act="quote"]'));
}
await check('lender: empty haircut is refused, not quoted at 0%', async () => {
  await open('lenderA');
  const c = card(IA);
  await c.locator('input[id^="h-"]').fill('');
  await actErr(c.locator('[data-act="quote"]'), /Haircut: enter a number/);
  assert.equal((await of('lenderA', 'RepoQuote', (a) => a.rfqId === rfqA)).length, 0);
});
await check('lender: haircut 60% refused by the ledger, cash not locked', async () => {
  const c = card(IA);
  await actOk(c.locator('[data-act="cash-for"]'));
  await c.locator('input[id^="h-"]').fill('60');
  await actErr(c.locator('[data-act="quote"]'), /haircut/i);
  assert.equal((await of('lenderA', 'RepoQuote', (a) => a.rfqId === rfqA)).length, 0);
});
await check('lenders A (507 bp, 1.1%), B (451 bp, 20%), C (613 bp, 2%) seal quotes', async () => {
  // A already holds the cash from the previous check.
  await open('lenderA');
  const c = card(IA);
  await c.locator('input[id^="r-"]').fill('507'); await c.locator('input[id^="h-"]').fill('1.1');
  await actOk(c.locator('[data-act="quote"]'));
  await quoteAs('lenderB', 451, 20);
  await quoteAs('lenderC', 613, 2);
  const qs = await of('borrower', 'RepoQuote', (a) => a.rfqId === rfqA);
  assert.equal(qs.length, 3);
  assert.equal(Number(qs.find((q) => q.arg.lender === P.lenderA).arg.haircut), 0.011, '1.1% stored exactly');
  assert.equal((await of('lenderA', 'Escrow', (a) => a.owner === P.lenderA && Number(a.amount) === 900000)).length >= 1, true, 'cash locked');
});
await check('privacy: each lender sees only its own quote, in /api/acs and in the DOM', async () => {
  for (const [role, own, rivals] of [['lenderA', 507, [451, 613]], ['lenderB', 451, [507, 613]], ['lenderC', 613, [507, 451]]]) {
    const qs = await of(role, 'RepoQuote');
    assert.ok(qs.every((q) => q.arg.lender === P[role]), role + ' got a rival quote from /api/acs');
    await open(role);
    const html = await page.locator('#view').innerHTML();
    for (const r of rivals) assert.ok(!html.includes(`${r} bp`), `${role} DOM shows ${r} bp`);
    assert.ok(html.includes(`${own} bp`), `${role} sees its own quote`);
    assert.match(await page.locator('.proof').textContent(), /Rival quotes never reached you/);
  }
  const reg = await acs('regulator');
  assert.ok(reg.every((c) => c.tpl === 'RepoReport' || c.tpl === 'BestExecution'), 'regulator sees only reports');
});
await check('lender C withdraws; its cash comes back', async () => {
  await open('lenderC');
  await actOk(card(IA).locator('[data-act="withdraw"]'));
  assert.equal((await of('lenderC', 'RepoQuote', (a) => a.rfqId === rfqA)).length, 0);
  assert.ok((await of('lenderC', 'Holding', (a) => a.owner === P.lenderC && a.instrument === 'USDC' && Number(a.amount) === 900000)).length >= 1);
});

// ---------- borrower: award ----------
await check('award disabled for the quote short after haircut (B, 20%)', async () => {
  await open('borrower');
  const row = card(IA).locator('tr', { hasText: '451 bp' });
  assert.ok(await row.locator('[data-act="award"]').isDisabled());
  assert.equal(await row.locator('.pill.bad', { hasText: 'short' }).count(), 1);
});
await check('award A: repo opens, B gets only a rank, regulator gets an unnamed best-execution record', async () => {
  const lossB = (await of('lenderB', 'LossNotice')).length, bex = (await of('regulator', 'BestExecution')).length;
  await open('borrower');
  const btn = card(IA).locator('tr', { hasText: '507 bp' }).locator('[data-act="award"]');
  await btn.dblclick();
  await until(async () => (await of('borrower', 'RepoTrade', (a) => a.collateralInstrument === IA)).length, 'trade');
  await sleep(1500);
  const ts = await of('borrower', 'RepoTrade', (a) => a.collateralInstrument === IA);
  assert.equal(ts.length, 1, 'exactly one trade after a double click'); trade = ts[0];
  assert.equal(trade.arg.lender, P.lenderA);
  assert.equal((await of('borrower', 'RepoRFQ', (a, c) => c.cid === rfqA)).length, 0);
  assert.equal((await of('lenderB', 'LossNotice')).length, lossB + 1);
  const b = await of('regulator', 'BestExecution');
  assert.equal(b.length, bex + 1);
  assert.ok(!JSON.stringify(b).includes(P.lenderB), 'loser named to regulator');
  assert.ok((await of('lenderB', 'Holding', (a) => a.instrument === 'USDC' && Number(a.amount) === 900000)).length >= 1, 'B refunded');
});

// ---------- roll ----------
await check('lender offers a roll; empty days refused; borrower accepts at the new rate', async () => {
  await open('lenderA');
  let c = card(`${IA}`).filter({ hasText: 'Funded by' });
  await c.locator('input[id^="ro-d-"]').fill('');
  await actErr(c.locator('[data-act="offer-roll"]'), /Extra days: enter a number/);
  await c.locator('input[id^="ro-r-"]').fill('495'); await c.locator('input[id^="ro-d-"]').fill('7');
  await actOk(c.locator('[data-act="offer-roll"]'));
  assert.equal((await of('borrower', 'RollOffer', (a) => a.tradeCid === trade.cid)).length, 1);
  await open('borrower');
  await actOk(card('offers to extend').filter({ hasText: '495 bp' }).locator('[data-act="roll"]'));
  [trade] = await of('borrower', 'RepoTrade', (a) => a.collateralInstrument === IA);
  assert.equal(Number(trade.arg.rateBps), 495);
});

// ---------- substitution ----------
async function offerSub(units) {
  await open('borrower');
  const c = card(IA).filter({ hasText: 'Funded by' });
  const opt = await c.locator('select[id^="sub-"] option', { hasText: `${units} ${IB}` }).first().getAttribute('value');
  await c.locator('select[id^="sub-"]').selectOption(opt);
  await actOk(c.locator('[data-act="substitute"]'));
}
await check('substitute 1 unit: lender sees approve disabled (does not cover), declines, bond returns', async () => {
  await open('borrower');
  await page.selectOption('#n-inst', IB); await page.fill('#n-qty', '1');
  await actOk(page.locator('[data-act="bonds"]'));
  await offerSub('1');
  assert.equal((await of('lenderA', 'Substitution', (a) => a.newInstrument === IB)).length, 1);
  await open('lenderA');
  const c = card(`offers 1 ${IB}`);
  assert.ok(await c.locator('[data-act="approve"]').isDisabled());
  await actOk(c.locator('[data-act="decline"]'));
  assert.equal((await of('borrower', 'Substitution')).filter((s) => s.arg.newInstrument === IB).length, 0);
  assert.equal(sum(await of('borrower', 'Holding', (a) => a.instrument === IB && a.owner === P.borrower)), 1);
});
await check('substitute 10,000 units: lender approves, repo now holds the new bond', async () => {
  await open('borrower');
  await page.selectOption('#n-inst', IB); await page.fill('#n-qty', '10000');
  await actOk(page.locator('[data-act="bonds"]'));
  await offerSub('10,000');
  await open('lenderA');
  await actOk(card(`offers 10,000 ${IB}`).locator('[data-act="approve"]'));
  [trade] = await of('borrower', 'RepoTrade', (a) => a.tradeId === undefined && a.borrower === P.borrower && a.collateralInstrument === IB);
  assert.ok(trade, 'trade on new collateral');
  assert.equal(sum(await of('borrower', 'Holding', (a) => a.instrument === IA && a.owner === P.borrower)), 10000, 'old bond back');
});

// ---------- margin call ----------
await check('mark drops: lender calls margin, borrower uses faucet and posts, repo topped up', async () => {
  await markApi(IB, 90);
  await open('lenderA');
  await actOk(card(IB).filter({ hasText: 'Funded by' }).locator('[data-act="call"]'));
  const [mc] = await of('borrower', 'MarginCall', (a) => a.instrument === IB);
  assert.ok(mc, 'margin call on ledger');
  await open('lenderA');
  assert.ok(await card(`called from`).filter({ hasText: IB }).locator('[data-act="default"]').isDisabled(), 'default disabled before deadline');
  await open('borrower');
  const c = card(`calls`).filter({ hasText: IB });
  await actOk(c.locator('[data-act="bonds-for"]'));
  await actOk(card(`calls`).filter({ hasText: IB }).locator('[data-act="post"]'));
  assert.equal((await of('borrower', 'MarginCall', (a) => a.instrument === IB)).length, 0);
  [trade] = await of('borrower', 'RepoTrade', (a) => a.collateralInstrument === IB);
  assert.ok(Number(trade.arg.collateralQty) > 10000, 'collateral topped up');
});

// ---------- repurchase ----------
await check('repurchase: cash faucet, repo closes, venue paid, regulator gets CLOSE', async () => {
  await markApi(IB, 100);
  const venueBefore = sum(await of('venue', 'Holding', (a) => a.instrument === 'USDC'));
  const closes = (await of('regulator', 'RepoReport', (a) => a.event === 'CLOSE')).length;
  await open('borrower');
  const c = card(IB).filter({ hasText: 'Funded by' });
  await actOk(c.locator('[data-act="cash"]'));
  await actOk(card(IB).filter({ hasText: 'Funded by' }).locator('[data-act="repurchase"]'));
  assert.equal((await of('borrower', 'RepoTrade', (a) => a.collateralInstrument === IB)).length, 0);
  assert.equal((await of('regulator', 'RepoReport', (a) => a.event === 'CLOSE')).length, closes + 1);
  assert.ok(sum(await of('venue', 'Holding', (a) => a.instrument === 'USDC')) > venueBefore, 'venue fee received');
  await open('venue');
  assert.match(await page.locator('#view').textContent(), /No venue screen yet/);
});

// ---------- default (call with a short window, made through the API) ----------
await check('default: after the response window the lender declares default and keeps the collateral', async () => {
  const rfq = createdCid(await submit('borrower', create('RepoRFQ', { borrower: P.borrower, regulator: P.regulator, agent: P.agent,
    venue: null, lenders: [P.lenderA], deadline: null, terms: { cashIssuer: P.cashIssuer, cashInstrument: 'USDC', principal: '900000',
      collateralIssuer: P.bondIssuer, collateralInstrument: IC, collateralQty: '10000', termDays: '30' } })), 'RepoRFQ');
  const cash = await mint('cashIssuer', 'lenderA', 'USDC', 900000);
  const q = createdCid(await submit('lenderA', exercise('RepoRFQ', rfq, 'SubmitQuote', { lender: P.lenderA, rateBps: '500', haircut: '0.02', cashCid: cash })), 'RepoQuote');
  const col = await mint('bondIssuer', 'borrower', IC, 10000);
  const m1 = createdCid(await markApi(IC, 100), 'Mark');
  const t = createdCid(await submit('borrower', exercise('RepoRFQ', rfq, 'AwardSealed', { winner: q, losers: [], collateralCid: col, markCid: m1, contexts: [] })), 'RepoTrade');
  const m2 = createdCid(await markApi(IC, 80), 'Mark');
  await submit('lenderA', exercise('RepoTrade', t, 'CallMargin', { markCid: m2, respondBy: new Date(Date.now() + 4000).toISOString() }));
  await sleep(5000);
  await open('lenderA');
  const c = card('called from').filter({ hasText: IC });
  assert.ok(await c.locator('[data-act="default"]').isEnabled());
  await actOk(c.locator('[data-act="default"]'));
  assert.equal((await of('lenderA', 'RepoTrade', (a) => a.collateralInstrument === IC)).length, 0);
  assert.equal((await of('regulator', 'RepoReport', (a) => a.event === 'DEFAULT' && a.collateralInstrument === IC)).length, 1);
  assert.equal(sum(await of('lenderA', 'Holding', (a) => a.instrument === IC && a.owner === P.lenderA)), 10000);
});

// ---------- claim: needs a matured repo, which a wall-clock ledger cannot produce in a test ----------
await check('claim: not offered before maturity, and the ledger refuses it', async () => {
  await open('lenderA');
  const anyTrade = (await of('lenderA', 'RepoTrade', (a) => Date.parse(a.maturity) > Date.now()))[0];
  assert.ok(anyTrade, 'a live repo to check');
  assert.equal(await page.locator(`[data-act="claim"][data-cid="${anyTrade.cid}"]`).count(), 0);
  const r = await postJ(BASE, '/api/submit', { role: 'lenderA', command: exercise('RepoTrade', anyTrade.cid, 'ClaimAfterMaturity', { contexts: [] }) });
  assert.notEqual(r.status, 200); assert.match(JSON.stringify(r.json), /not matured/);
});

// ---------- stale mark blocks award ----------
await check('award with only a stale mark is refused, nothing opens', async () => {
  const rfq = createdCid(await submit('borrower', create('RepoRFQ', { borrower: P.borrower, regulator: P.regulator, agent: P.agent,
    venue: null, lenders: [P.lenderA], deadline: null, terms: { cashIssuer: P.cashIssuer, cashInstrument: 'USDC', principal: '50',
      collateralIssuer: P.bondIssuer, collateralInstrument: IS, collateralQty: '1', termDays: '1' } })), 'RepoRFQ');
  const cash = await mint('cashIssuer', 'lenderA', 'USDC', 50);
  await submit('lenderA', exercise('RepoRFQ', rfq, 'SubmitQuote', { lender: P.lenderA, rateBps: '500', haircut: '0.02', cashCid: cash }));
  await open('borrower');
  await actErr(card(IS).locator('[data-act="award"]'), /no fresh mark/);
  assert.equal((await of('borrower', 'RepoTrade', (a) => a.collateralInstrument === IS)).length, 0);
  // cancel through the UI: RFQ gone
  await actOk(card(IS).locator('[data-act="cancel"]'));
  assert.equal((await of('borrower', 'RepoRFQ', (a, c) => c.cid === rfq)).length, 0);
});

// ---------- race: the 5 s repaint during a slow submit ----------
await check('race: a slow request cannot be sent twice (click + repaint)', async () => {
  await open('borrower');
  await page.route('**/api/submit', async (route) => { await sleep(7000); await route.continue().catch(() => {}); });
  await page.selectOption('#n-inst', IC); await page.fill('#n-qty', '3'); await page.fill('#n-cash', '200'); await page.fill('#n-term', '1');
  await page.locator('[data-act="request"]').click();
  await sleep(5800); // the 5 s timer has fired
  await page.locator('[data-act="request"]').click({ force: true, timeout: 2000 }).catch(() => {});
  await until(async () => (await of('borrower', 'RepoRFQ', (a) => a.terms.collateralInstrument === IC && a.terms.principal.startsWith('200'))).length, 'rfq', 20000);
  await sleep(9000);
  const rs = await of('borrower', 'RepoRFQ', (a) => a.terms.collateralInstrument === IC && a.terms.principal.startsWith('200'));
  await page.unroute('**/api/submit');
  for (const r of rs) await submit('borrower', exercise('RepoRFQ', r.cid, 'CancelRFQ'));
  assert.equal(rs.length, 1, `${rs.length} requests created`);
});

// ---------- deep links, side by side ----------
await check('?role=lenderB opens as Lender B; ?role=bogus falls back to borrower', async () => {
  await open('lenderB');
  assert.match(await page.locator('#role-name').textContent(), /Lender B/);
  await open('bogus');
  assert.match(await page.locator('#role-name').textContent(), /Borrower/);
  assert.equal(await page.locator('#party').textContent(), P.borrower);
  await open('cashIssuer');
  assert.match(await page.locator('#role-name').textContent(), /Borrower/);
});
await check('side by side: one column per role, counts equal each role\'s own read', async () => {
  await open('borrower');
  await page.click('#side-by-side');
  await page.waitForSelector('#sbs .card[data-role="venue"]');
  assert.match(page.url(), /view=side-by-side/);
  assert.equal(await page.locator('#sbs .card').count(), ROLES.length);
  for (const r of ROLES) {
    const shown = Number(await page.locator(`#sbs .card[data-role="${r}"] dd[data-k="All contracts"]`).textContent());
    assert.ok(Math.abs(shown - (await acs(r)).length) <= 2, `${r}: ${shown}`); // other writers may race by a contract or two
  }
  for (const l of ['lenderA', 'lenderB', 'lenderC']) assert.equal(await page.locator(`#sbs .card[data-role="${l}"] dd[data-k="from rivals"]`).textContent(), '0');
  await page.goto(`${BASE}/desk?view=side-by-side`);
  await page.waitForSelector('#sbs .card');
  await page.click('#side-by-side');
  await page.waitForSelector('#who:not([hidden])');
  assert.doesNotMatch(page.url(), /view=/);
});

// ---------- accessibility ----------
await check('a11y: every control in every role view has a name; role pills work by keyboard', async () => {
  for (const r of ROLES) {
    await open(r);
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('input, select, button')].filter((e) => {
      if (e.offsetParent === null) return false;
      const name = e.getAttribute('aria-label') || (e.labels && [...e.labels].map((l) => l.textContent).join('').trim())
        || (e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby'))?.textContent) || e.textContent.trim();
      return !name;
    }).map((e) => e.outerHTML.slice(0, 80)));
    assert.deepEqual(unnamed, [], r);
    assert.equal(await page.evaluate(() => document.querySelectorAll('label label').length), 0, r + ': nested labels');
  }
  await open('borrower');
  await page.focus('#roles [data-role="lenderA"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Lender A/.test(document.querySelector('#role-name').textContent));
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.role ?? null) !== undefined, true);
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY', 'focus kept after role switch');
});

// ---------- read-only desk ----------
await check('read-only desk: banner, no action controls, submit refused', async () => {
  const pg = await ctx.newPage();
  for (const r of ['borrower', 'lenderA', 'agent']) {
    await open(r, '', RO, pg);
    assert.ok(await pg.locator('#readonly').isVisible());
    const visible = await pg.locator('#view [data-act]:visible, #view input:visible, #view select:visible').count();
    assert.equal(visible, 0, r);
  }
  const s = await postJ(RO, '/api/submit', { role: 'borrower', command: create('Holding', {}) });
  assert.equal(s.status, 403);
  await pg.close();
});

// ---------- server hardening ----------
await check('server: bad JSON, prototype keys and traversal are refused', async () => {
  const raw = (path, body = '') => new Promise((res) => { const q = httpRequest(BASE + path, { method: body ? 'POST' : 'GET' },
    (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => res([r.statusCode, s])); }); q.end(body); });
  assert.equal((await raw('/api/acs', '{nope'))[0], 400);
  assert.equal((await raw('/api/acs', '{"role":"constructor"}'))[0], 400);
  assert.equal((await raw('/api/submit', '{"role":"__proto__"}'))[0], 400);
  for (const p of ['/../server.mjs', '/..%2fserver.mjs', '/....//server.mjs', '/%2e%2e/.env.local']) {
    const [code, body] = await raw(p);
    assert.ok(code === 404 && !/PARTIES|DEVNET/.test(body), p + ' -> ' + code);
  }
});

// ---------- mobile ----------
await check('390 px: no element wider than the viewport, in every role and side by side', async () => {
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pg = await mob.newPage();
  for (const q of [...ROLES.map((r) => `?role=${r}`), '?view=side-by-side']) {
    await pg.goto(`${BASE}/desk${q}`);
    await pg.waitForFunction(() => /live/.test(document.querySelector('#status')?.textContent) && !document.querySelector('#view .skel'));
    const wide = await pg.evaluate(() => {
      const W = document.documentElement.clientWidth;
      const scrolls = (e) => { for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return p !== document.body; } return false; };
      return [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 1 && !scrolls(e); })
        .slice(0, 3).map((e) => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().right)}`);
    });
    assert.deepEqual(wide, [], q);
    assert.ok(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), q + ' scrolls sideways');
  }
  await mob.close();
});

await check('no console errors across the run', async () => { assert.deepEqual(consoleErrors.filter((e) => !/status of 4\d\d/.test(e)), []); });

await browser.close();
const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log('FAIL', f[1], '\n   ', f[2]);
process.exit(failed.length ? 1 : 0);
