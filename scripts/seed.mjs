// Seed the desk on the DevNet node with one of every state a repo can be in:
// an open request with three sealed quotes, a live repo with a substitution
// waiting for the lender, a live repo under an outstanding margin call, a live
// repo with a roll offer, a closed repo that paid the venue its fee, and the
// best-execution record and loss notices every award leaves behind.
//   node scripts/seed.mjs          seed (refuses if repos already exist)
//   node scripts/seed.mjs marks    re-publish fresh marks (they go stale after 24h)
import { PARTIES as p, acs, submit, created, create, exercise, NO_CONTEXTS } from '../lib/ledger.mjs';

const now = () => new Date().toISOString();
const dec = (n) => String(n);
const LENDERS = [p.lenderA, p.lenderB, p.lenderC].filter(Boolean);
// The venue operator collects 10 bp a year; without a venue party the desk runs fee-free.
const VENUE = p.venue ? { operator: p.venue, feeBps: '10.0' } : null;

const PRICES = { UST10Y: 98000, BUND10: 85000, GILT10: 100000, UST2Y: 99500 };

async function publishMarks(prices = PRICES) {
  for (const [instrument, price] of Object.entries(prices)) {
    await submit(p.agent, create('Mark', { agent: p.agent, instrument, price: dec(price), asOf: now(),
      audience: [p.borrower, ...LENDERS] }));
  }
  console.log('marks published:', Object.entries(prices).map(([i, v]) => `${i} ${v}`).join(', '));
}

async function latestMark(instrument) {
  const { contracts } = await acs(p.borrower);
  const marks = contracts.filter((c) => c.tpl === 'Mark' && c.arg.instrument === instrument)
    .sort((a, b) => b.arg.asOf.localeCompare(a.arg.asOf));
  if (!marks.length) throw new Error('no mark for ' + instrument);
  return marks[0].cid;
}

const mint = async (issuer, owner, instrument, amount) =>
  created(await submit(issuer, create('Holding', { issuer, owner, instrument, amount: dec(amount) })), 'Holding');

const terms = (instrument, qty, principal, termDays) => ({
  cashIssuer: p.cashIssuer, cashInstrument: 'USDC', principal: dec(principal),
  collateralIssuer: p.bondIssuer, collateralInstrument: instrument, collateralQty: dec(qty), termDays: String(termDays) });

async function request(instrument, qty, principal, termDays, lenders = [p.lenderA, p.lenderB]) {
  return created(await submit(p.borrower, create('RepoRFQ', { borrower: p.borrower, regulator: p.regulator,
    agent: p.agent, lenders, terms: terms(instrument, qty, principal, termDays), deadline: null, venue: VENUE })), 'RepoRFQ');
}

async function quote(rfq, lender, principal, rateBps, haircut) {
  const cash = await mint(p.cashIssuer, lender, 'USDC', principal);
  return created(await submit(lender, exercise('RepoRFQ', rfq, 'SubmitQuote',
    { lender, rateBps: dec(rateBps), haircut: dec(haircut), cashCid: cash })), 'RepoQuote');
}

// Every lender quotes; the borrower takes `winner` (an index into the quotes).
async function openRepo(instrument, qty, principal, termDays, quotes, winner) {
  const lenders = quotes.map(([l]) => l);
  const rfq = await request(instrument, qty, principal, termDays, lenders);
  const qs = [];
  for (const [lender, rate, haircut] of quotes) qs.push(await quote(rfq, lender, principal, rate, haircut));
  const col = await mint(p.bondIssuer, p.borrower, instrument, qty);
  const tx = await submit(p.borrower, exercise('RepoRFQ', rfq, 'Award', {
    winner: qs[winner], losers: qs.filter((_, i) => i !== winner), collateralCid: col,
    markCid: await latestMark(instrument), contexts: NO_CONTEXTS }));
  return created(tx, 'RepoTrade');
}

async function seed() {
  const { contracts } = await acs(p.borrower);
  if (contracts.some((c) => c.tpl === 'RepoTrade' || c.tpl === 'RepoRFQ'))
    throw new Error('already seeded: repos exist for this borrower');
  await publishMarks();

  // 1. Live repo, then a substitution the lender has not answered yet.
  const t1 = await openRepo('UST10Y', 100, 9500000, 90, [[p.lenderA, 530, 0.02], [p.lenderB, 545, 0.03]], 0);
  const bunds = await mint(p.bondIssuer, p.borrower, 'BUND10', 120);
  await submit(p.borrower, exercise('RepoTrade', t1, 'ProposeSubstitution', { holdingCid: bunds }));
  console.log('· repo 1  UST10Y x100 for 9.5M @ 530bp (lender A), substitution to BUND10 pending');

  // 2. Live repo whose collateral fell: the agent marks Gilts down and lender B calls.
  const t2 = await openRepo('GILT10', 50, 4800000, 30, [[p.lenderA, 560, 0.02], [p.lenderB, 520, 0.02]], 1);
  await publishMarks({ GILT10: 96000 });
  await submit(p.lenderB, exercise('RepoTrade', t2, 'CallMargin',
    { markCid: await latestMark('GILT10'), respondBy: new Date(Date.now() + 2 * 864e5).toISOString() }));
  console.log('· repo 2  GILT10 x50 for 4.8M @ 520bp (lender B), margin call outstanding');

  // 3. Three lenders quote; the cheapest rate's haircut does not cover, so the
  //    borrower takes the second-cheapest. Losers learn their rank, nothing more.
  if (p.lenderC) {
    const t3 = await openRepo('UST10Y', 60, 5700000, 30,
      [[p.lenderA, 540, 0.01], [p.lenderB, 515, 0.04], [p.lenderC, 525, 0.02]], 2);
    await submit(p.lenderC, create('RollOffer', { tradeCid: t3, borrower: p.borrower, lender: p.lenderC,
      newRateBps: '505.0', extraDays: '30', expiresAt: new Date(Date.now() + 3 * 864e5).toISOString() }));
    console.log('· repo 3  UST10Y x60 for 5.7M @ 525bp (lender C, rank 2 of 3), roll offer at 505bp pending');
  }

  // 4. Open request, sealed quotes, not yet awarded.
  const rfq = await request('BUND10', 60, 4900000, 14, LENDERS);
  await quote(rfq, p.lenderA, 4900000, 495, 0.025);
  await quote(rfq, p.lenderB, 4900000, 505, 0.02);
  console.log('· request BUND10 x60 for 4.9M, 2 sealed quotes waiting for the borrower');

  // 5. Closed repo: opened and repurchased (one day of interest, the floor, plus the venue fee).
  const t5 = await openRepo('UST2Y', 30, 2900000, 7, [[p.lenderA, 480, 0.01], [p.lenderB, 470, 0.015]], 1);
  const pay = await mint(p.cashIssuer, p.borrower, 'USDC', 2000);
  const { contracts: mine } = await acs(p.borrower);
  const loan = mine.find((c) => c.tpl === 'Holding' && c.arg.owner === p.borrower && c.arg.instrument === 'USDC'
    && Number(c.arg.amount) === 2900000);
  const pot = loan ? created(await submit(p.borrower, exercise('Holding', loan.cid, 'Merge', { other: pay })), 'Holding') : pay;
  await submit(p.borrower, exercise('RepoTrade', t5, 'Repurchase', { cashCid: pot, contexts: NO_CONTEXTS }));
  console.log(`· repo 5  UST2Y x30 for 2.9M @ 470bp (lender B), repurchased${VENUE ? ', venue fee paid' : ''}`);
}

const cmd = process.argv[2];
(cmd === 'marks' ? publishMarks() : seed()).catch((e) => { console.error('ERR', e.message); process.exit(1); });
