// End-to-end: drive the MCP servers as an MCP client would, one per desk, against
// a live ledger (DevNet, or the local sandbox with ENV_FILE=.env.local).
//   node scripts/e2e-mcp.mjs        (after `npm run seed`)
// Works with two lenders; lender C's agent and checks run only if the parties file has lenderC.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PARTIES as p, submit, create } from '../lib/ledger.mjs';

let failed = 0, passed = 0;
const check = (ok, label) => { console.log(`${ok ? '✓' : '✗'} ${label}`); ok ? passed++ : failed++; };
const skip = (label) => console.log(`· skipped: ${label}`);

async function agent(role) {
  const c = new Client({ name: 'e2e', version: '0' });
  await c.connect(new StdioClientTransport({ command: 'node', args: ['mcp/server.mjs'], env: { ...process.env, TALANG_ROLE: role } }));
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { error: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  return { c, call, tools: (await c.listTools()).tools.map((t) => t.name) };
}

const HAS_C = !!p.lenderC;
const A = await agent('lenderA'), B = await agent('lenderB'), C = HAS_C ? await agent('lenderC') : null;
const BOR = await agent('borrower'), REG = await agent('regulator');
const LENDERS = { lenderA: A, lenderB: B, ...(HAS_C ? { lenderC: C } : {}) };
if (!HAS_C) skip('lender C agent and its checks: no lenderC in the parties file');

check(['portfolio', 'open_requests', 'quote', 'call_margin', 'review_substitution', 'offer_roll', 'withdraw_quote', 'withdraw_roll',
  'declare_default', 'claim_collateral', 'loss_history', 'privacy_check'].every((t) => A.tools.includes(t)), `lender agent: ${A.tools.length} tools`);
check(['quotes', 'award', 'book', 'accept_roll', 'request_repo', 'cancel_request', 'post_margin', 'propose_substitution', 'repurchase',
  'privacy_check'].every((t) => BOR.tools.includes(t)), `borrower agent: ${BOR.tools.length} tools`);
check(['lifecycle', 'exposure', 'best_execution', 'privacy_check'].every((t) => REG.tools.includes(t)), `regulator agent: ${REG.tools.length} tools`);
check((await REG.call('award', { request: 'x', quote: 'best' })).error?.includes('not a regulator tool'), 'a regulator agent cannot reach borrower tools');

// ---- privacy, read from every node ----
for (const [role, ag] of Object.entries(LENDERS)) {
  const priv = (await ag.call('privacy_check')).data;
  check(priv.rivalQuotesVisible === 0 && priv.reposNotMine === 0 && priv.lossNoticesNotMine === 0 && priv.bestExecutionVisible === 0,
    `${role}: ${priv.quotesVisible} quotes visible, 0 rival quotes, 0 other repos, 0 other loss notices, 0 best-ex records`);
}
const rp = (await REG.call('privacy_check')).data;
check(rp.requestsVisible === 0 && rp.quotesVisible === 0 && rp.lossNoticesVisible === 0 && rp.positionsVisible === 0 && rp.reports > 0,
  `regulator: ${rp.reports} reports, ${rp.bestExecution} best-ex records, 0 requests, 0 quotes, 0 loss notices, 0 positions`);

// ---- best execution without leakage ----
const be = (await REG.call('best_execution')).data;
check(be.length > 0 && be.every((x) => x.winnerRank >= 1 && x.winnerRank <= x.quotesConsidered && x.spreadToBestBps >= 0 && !('lender' in x)),
  `regulator sees ${be.length} awards, each with a rank and a spread, no lender named`);
const lossA = (await A.call('loss_history')).data, lossB = (await B.call('loss_history')).data;
check(lossA.length + lossB.length > 0 && [...lossA, ...lossB].every((n) => n.rank >= 1 && n.rank <= n.outOf && Object.keys(n).length === 4),
  `losers told only their rank: A ${lossA.map((n) => `${n.rank}/${n.outOf}`).join(', ')}; B ${lossB.map((n) => `${n.rank}/${n.outOf}`).join(', ')}`);
if (HAS_C) {
  const notBest = be.find((x) => x.winnerRank > 1 && x.quotesConsidered === 3);
  check(!!notBest, `three-lender award took rank ${notBest?.winnerRank} of 3, ${notBest?.spreadToBestBps}bp over the best rate`);
} else skip('three-lender best-execution check');

const life = (await REG.call('lifecycle')).data;
const close = life.find((e) => e.event === 'CLOSE');
check(close && close.venueFee > 0, `lifecycle: ${life.length} events, close paid the venue ${close?.venueFee}`);

// ---- regulator exposure, rebuilt from reports only ----
const exp0 = (await REG.call('exposure')).data;
const sumsToOne = (rows) => Math.abs(rows.reduce((s, r) => s + r.share, 0) - 1) < 0.01;
check(exp0.openRepos > 0 && sumsToOne(exp0.byLender) && sumsToOne(exp0.byCollateral),
  `exposure: ${exp0.openRepos} open repos, ${exp0.openPrincipal} principal; largest lender ${exp0.byLender[0]?.name} at ${(exp0.byLender[0]?.share * 100).toFixed(1)}%`);

// ---- borrower agent: rank, award the best covered quote ----
const open = (await BOR.call('quotes')).data.find((r) => r.quotes.length >= 2);
check(open && open.quotes[0].rateBps <= open.quotes[1].rateBps, `borrower sees ${open?.quotes.length} sealed quotes ranked by rate on ${open?.collateral}`);
let awarded = null;
if (open) {
  const bad = await A.call('quote', { request: open.request, rateBps: 'abc', haircutPct: 2 });
  check(/rateBps must be a number/.test(bad.error ?? ''), `a non-numeric rate is refused by the tool: ${bad.error}`);
  const [qty, instrument] = open.collateral.split(' ');
  await submit(p.bondIssuer, create('Holding', { issuer: p.bondIssuer, owner: p.borrower, instrument, amount: qty }));
  const aw = await BOR.call('award', { request: open.request, quote: 'best' });
  check(aw.data?.opened && aw.data.refunded === open.quotes.length - 1,
    `borrower agent awarded the best covered quote (${aw.error ?? `${aw.data.lender} @ ${aw.data.rateBps}bp, ${aw.data.refunded} refunded`})`);
  awarded = aw.data;
}

// ---- substitution offered by the borrower, declined by the lender's agent ----
if (awarded) {
  const L = LENDERS[awarded.lender];
  await submit(p.bondIssuer, create('Holding', { issuer: p.bondIssuer, owner: p.borrower, instrument: 'UST10Y', amount: '80' }));
  const s = await BOR.call('propose_substitution', { repo: awarded.opened, instrument: 'UST10Y', qty: 70 });
  const seen = (await L.call('portfolio')).data.find((t) => t.substitution?.id === s.data?.substitution);
  const d = seen ? await L.call('review_substitution', { substitution: seen.substitution.id, decision: 'decline' }) : null;
  check(s.data && seen && d?.data?.declined,
    `substitution of 70 UST10Y (would cover ${s.data?.wouldCover?.toFixed(2) ?? s.error}) seen and declined by ${awarded.lender}`);
}

// ---- margin call answered by the borrower agent ----
const called = (await BOR.call('book')).data.find((t) => t.marginCall);
if (called) {
  const [, instrument] = called.collateral.split(' ');
  await submit(p.bondIssuer, create('Holding', { issuer: p.bondIssuer, owner: p.borrower, instrument,
    amount: String(Math.ceil(called.marginCall.unitsDue) + 1) }));
  const r = await BOR.call('post_margin', { marginCall: called.marginCall.id });
  check(r.data?.repo, `borrower agent posted margin: ${r.error ?? `${r.data.posted} on ${called.repo}`}`);
} else skip('no margin call open in the book to answer');

// ---- roll: offered by a lender agent if none is pending, accepted by the borrower ----
let book = (await BOR.call('book')).data;
if (!book.some((t) => t.rollOffer)) {
  const t = (await A.call('portfolio')).data.find((x) => x.repo !== awarded?.opened && !x.rollOffer && !x.matured && x.markFresh && x.coverage >= 1);
  if (t) await A.call('offer_roll', { repo: t.repo, newRateBps: 495, extraDays: 14 });
  book = (await BOR.call('book')).data;
}
const withRoll = book.find((t) => t.rollOffer);
check(!!withRoll, `borrower book: ${book.length} repos, roll offer at ${withRoll?.rollOffer?.newRateBps}bp on ${withRoll?.collateral}`);
if (withRoll) {
  const r = await BOR.call('accept_roll', { offer: withRoll.rollOffer.id });
  check(r.data?.rolled, `roll accepted: ${r.error ?? `paid ${r.data.paidNow} now, continues at ${r.data.newRateBps}bp`}`);
}

// ---- a lender offers a roll and withdraws it; the borrower stops seeing it ----
const bookA = (await A.call('portfolio')).data.find((t) => t.repo !== awarded?.opened && !t.rollOffer && !t.matured);
if (bookA) {
  const o = await A.call('offer_roll', { repo: bookA.repo, newRateBps: 490, extraDays: 14 });
  const seen = (await BOR.call('book')).data.some((t) => t.rollOffer?.id === o.data?.offer);
  check(o.data?.offered && seen, `lender A offered a roll at 490bp; the borrower's agent sees it`);
  const w = await A.call('withdraw_roll', { offer: o.data?.offer ?? 'x' });
  const gone = !(await BOR.call('book')).data.some((t) => t.rollOffer?.id === o.data?.offer);
  check(w.data?.withdrawn && gone, 'lender A withdrew the roll; the borrower no longer sees it');
}

// ---- request, quote, cancel, withdraw: no lender's cash is stranded ----
await submit(p.bondIssuer, create('Holding', { issuer: p.bondIssuer, owner: p.borrower, instrument: 'UST2Y', amount: '10' }));
const req = await BOR.call('request_repo', { principal: 500000, collateralInstrument: 'UST2Y', collateralQty: 10, termDays: 7, lenders: ['lenderA', 'lenderB'] });
const seenReq = (await A.call('open_requests')).data.find((r) => r.request === req.data?.request);
check(seenReq && seenReq.principal === 500000, `borrower agent asked for 500,000 against 10 UST2Y; lender A sees it (${req.error ?? req.data.request})`);
if (seenReq) {
  await submit(p.cashIssuer, create('Holding', { issuer: p.cashIssuer, owner: p.lenderA, instrument: 'USDC', amount: '500000' }));
  const q = await A.call('quote', { request: seenReq.request, rateBps: 500, haircutPct: 2 });
  const cancel = await BOR.call('cancel_request', { request: seenReq.request });
  check(q.data?.sealed && cancel.data?.quotesStillLocked.length === 1, `request cancelled, lender A's quote listed as still locked (${q.error ?? cancel.error ?? 'ok'})`);
  const before = (await A.call('privacy_check')).data.quotesVisible;
  const w = await A.call('withdraw_quote', { quote: cancel.data?.quotesStillLocked[0]?.quote ?? 'x' });
  check(w.data?.withdrawn && (await A.call('privacy_check')).data.quotesVisible === before - 1, `lender A withdrew its quote: ${w.error ?? `${w.data.returned} back`}`);
}

// ---- the ledger, not the tool, refuses what is not yet due ----
const portA = (await A.call('portfolio')).data.find((t) => !t.matured);
if (portA) {
  const r = await A.call('claim_collateral', { repo: portA.repo });
  check(r.error && /not matured/.test(r.error), `claim before maturity refused by the ledger (${portA.collateral}, matures ${portA.maturity.slice(0, 10)})`);
}

// The first lender with a covered repo and a fresh mark takes the margin test.
let L = null, covered = null;
for (const ag of [B, A, C].filter(Boolean)) {
  covered = (await ag.call('portfolio')).data.find((t) => t.coverage >= 1 && t.markFresh && !t.marginCall);
  if (covered) { L = ag; break; }
}
if (covered) {
  const r = await L.call('call_margin', { repo: covered.repo });
  check(r.error && /still covers/.test(r.error), `call on a covered repo refused by the ledger (${covered.collateral}, ${(covered.coverage * 100).toFixed(1)}%)`);
  const [, instrument] = covered.collateral.split(' ');
  // A markdown deep enough to leave this repo 3% short, whatever its coverage today.
  const cut = Math.min(0.94, 0.97 / covered.coverage);
  await submit(p.agent, create('Mark', { agent: p.agent, instrument, price: String(Math.round(covered.mark * cut)),
    asOf: new Date().toISOString(), audience: [p.borrower, ...[p.lenderA, p.lenderB, p.lenderC].filter(Boolean)] }));
  const after = (await L.call('portfolio')).data.find((t) => t.repo === covered.repo);
  check(after.coverage < 1, `after a ${((1 - cut) * 100).toFixed(1)}% markdown coverage is ${(after.coverage * 100).toFixed(1)}%, short ${after.unitsShort} ${instrument}`);
  check(/hoursToRespond/.test((await L.call('call_margin', { repo: covered.repo, hoursToRespond: 0.5 })).error ?? ''),
    'a call giving the borrower under 2 hours is refused');
  const ok = await L.call('call_margin', { repo: covered.repo, hoursToRespond: 48 });
  check(ok.data?.called === true, `margin call issued by the agent (${ok.error ?? ok.data.marginCall})`);
  const d = await L.call('declare_default', { marginCall: ok.data?.marginCall ?? 'x' });
  check(d.error && /still has time/.test(d.error), 'default before the call deadline refused by the ledger');
} else {
  console.log('· no covered repo with a fresh mark: run `npm run marks` and retry for the margin checks');
}

// ---- repurchase the repo the borrower agent opened; exposure returns to where it was ----
if (awarded) {
  const t = (await BOR.call('book')).data.find((x) => x.repo === awarded.opened);
  await submit(p.cashIssuer, create('Holding', { issuer: p.cashIssuer, owner: p.borrower, instrument: 'USDC',
    amount: String(Math.ceil(t.repurchaseToday - t.principal) + 1) }));
  const r = await BOR.call('repurchase', { repo: awarded.opened });
  check(r.data?.closed, `borrower agent repurchased: ${r.error ?? `paid ${r.data.paid} incl. venue fee ${r.data.venueFee}, ${r.data.collateralHome} home`}`);
  // Compared on this repo's collateral only: other desks may be trading on the same ledger.
  const exp1 = (await REG.call('exposure')).data, inst = t.collateral.split(' ')[1];
  const on = (e) => e.byCollateral.find((r) => r.name === inst)?.principal ?? 0;
  check(r.data && Math.abs(on(exp1) - on(exp0)) < 0.01 && exp1.events.close > exp0.events.close,
    `regulator exposure on ${inst} back to ${on(exp1)} after one open and one close; ${exp1.openPrincipal} open in all`);
}

for (const ag of [A, B, C, BOR, REG].filter(Boolean)) await ag.c.close();
console.log(failed ? `\n${failed} of ${passed + failed} checks failed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);
