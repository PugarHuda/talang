// Seed the desk with one of every state a repo can be in, at today's real prices:
// an open request with sealed quotes, a live repo with a substitution waiting for
// the lender, a live repo under a margin call, a live repo with a roll offer, a
// closed repo that paid the venue its fee, and the best-execution record and loss
// notices every award leaves behind.
//
// Marks are live (lib/prices.mjs: US Treasury par yields for the notes), and every
// principal is sized from them. The one number that is not today's market is the
// margin-call scenario's stress mark, labelled as such: a call needs the price to fall.
//   node scripts/seed.mjs          seed (refuses if repos already exist)
//   node scripts/seed.mjs marks    re-publish fresh live marks (they go stale after 24h)
import { PARTIES as p, acs, submit, created, create, exercise, NO_CONTEXTS } from '../lib/ledger.mjs';
import { livePrices } from '../lib/prices.mjs';

const now = () => new Date().toISOString();
const dec = (n) => String(n);
const down = (x, step) => Math.floor(x / step) * step;
const LENDERS = [p.lenderA, p.lenderB, p.lenderC].filter(Boolean);
// The venue operator collects 10 bp a year; without a venue party the desk runs fee-free.
const VENUE = p.venue ? { operator: p.venue, feeBps: '10.0' } : null;
const BONDS = ['UST2Y', 'UST5Y', 'UST10Y'];

async function publishMarks(prices) {
  for (const [instrument, price] of Object.entries(prices)) {
    await submit(p.agent, create('Mark', { agent: p.agent, instrument, price: dec(price), asOf: now(),
      audience: [p.borrower, ...LENDERS] }));
  }
  console.log('marks published:', Object.entries(prices).map(([i, v]) => `${i} ${v}`).join(', '));
}

async function liveMarks() {
  const live = await livePrices();
  for (const i of BONDS) console.log(`  ${i} ${live[i].price}  (${live[i].source})`);
  const prices = Object.fromEntries(BONDS.map((i) => [i, live[i].price]));
  await publishMarks(prices);
  return prices;
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
  const rfq = await request(instrument, qty, principal, termDays, quotes.map(([l]) => l));
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
  // The open request is the last thing a complete seed leaves; without it a run was
  // cut short, and seeding again only adds repos.
  if (contracts.some((c) => c.tpl === 'RepoRFQ' && c.arg.lenders.length > 1 && c.arg.terms.termDays === '14'))
    throw new Error('already seeded: the open request exists for this borrower');
  const px = await liveMarks();
  const fmt = (n) => (n / 1e6).toFixed(2) + 'M';

  // 1. Live repo, then a substitution into 5-year notes the lender has not answered yet.
  const p1 = down(100 * px.UST10Y * 0.98 * 0.99, 100000);
  const t1 = await openRepo('UST10Y', 100, p1, 90, [[p.lenderA, 530, 0.02], [p.lenderB, 545, 0.03]], 0);
  const subQty = Math.ceil(p1 * 1.03 / (0.98 * px.UST5Y));
  const sub = await mint(p.bondIssuer, p.borrower, 'UST5Y', subQty);
  await submit(p.borrower, exercise('RepoTrade', t1, 'ProposeSubstitution', { holdingCid: sub }));
  console.log(`· repo 1  UST10Y x100 for ${fmt(p1)} @ 530bp (lender A), substitution to UST5Y x${subQty} pending`);

  // 2. Live repo sized tight to its 2% haircut; then a stress mark 4% below today's
  //    price (a scenario, not today's market) and lender B calls.
  const p2 = down(50 * px.UST2Y * 0.98 * 0.995, 10000);
  const t2 = await openRepo('UST2Y', 50, p2, 30, [[p.lenderA, 560, 0.02], [p.lenderB, 520, 0.02]], 1);
  await publishMarks({ UST2Y: Math.round(px.UST2Y * 0.96 * 100) / 100 });
  await submit(p.lenderB, exercise('RepoTrade', t2, 'CallMargin',
    { markCid: await latestMark('UST2Y'), respondBy: new Date(Date.now() + 2 * 864e5).toISOString() }));
  await publishMarks({ UST2Y: px.UST2Y });
  console.log(`· repo 2  UST2Y x50 for ${fmt(p2)} @ 520bp (lender B), margin call after a -4% stress mark`);

  // 3. Three lenders quote; the cheapest rate's 4% haircut does not cover, so the
  //    borrower takes the second-cheapest. Losers learn their rank, nothing more.
  if (p.lenderC) {
    const p3 = down(60 * px.UST10Y * 0.97, 1000);
    const t3 = await openRepo('UST10Y', 60, p3, 30,
      [[p.lenderA, 540, 0.01], [p.lenderB, 515, 0.04], [p.lenderC, 525, 0.02]], 2);
    await submit(p.lenderC, create('RollOffer', { tradeCid: t3, borrower: p.borrower, lender: p.lenderC,
      newRateBps: '505.0', extraDays: '30', expiresAt: new Date(Date.now() + 3 * 864e5).toISOString() }));
    console.log(`· repo 3  UST10Y x60 for ${fmt(p3)} @ 525bp (lender C, rank 2 of 3), roll offer at 505bp pending`);
  }

  // 4. Open request, sealed quotes, not yet awarded. The borrower holds the notes it
  //    offers, so it can take a quote straight from the desk.
  const p4 = down(60 * px.UST5Y * 0.95, 100000);
  await mint(p.bondIssuer, p.borrower, 'UST5Y', 60);
  const rfq = await request('UST5Y', 60, p4, 14, LENDERS);
  await quote(rfq, p.lenderA, p4, 495, 0.025);
  await quote(rfq, p.lenderB, p4, 505, 0.02);
  console.log(`· request UST5Y x60 for ${fmt(p4)}, 2 sealed quotes waiting for the borrower`);

  // 5. Closed repo: opened and repurchased (one day of interest, the floor, plus the venue fee).
  const p5 = down(30 * px.UST2Y * 0.98 * 0.98, 100000);
  const t5 = await openRepo('UST2Y', 30, p5, 7, [[p.lenderA, 480, 0.01], [p.lenderB, 470, 0.015]], 1);
  const pay = await mint(p.cashIssuer, p.borrower, 'USDC', 2000);
  const { contracts: mine } = await acs(p.borrower);
  const loan = mine.find((c) => c.tpl === 'Holding' && c.arg.owner === p.borrower && c.arg.instrument === 'USDC'
    && Number(c.arg.amount) === p5);
  const pot = loan ? created(await submit(p.borrower, exercise('Holding', loan.cid, 'Merge', { other: pay })), 'Holding') : pay;
  await submit(p.borrower, exercise('RepoTrade', t5, 'Repurchase', { cashCid: pot, contexts: NO_CONTEXTS }));
  console.log(`· repo 5  UST2Y x30 for ${fmt(p5)} @ 470bp (lender B), repurchased${VENUE ? ', venue fee paid' : ''}`);
}

const cmd = process.argv[2];
(cmd === 'marks' ? liveMarks() : seed()).catch((e) => { console.error('ERR', e.message); process.exit(1); });
