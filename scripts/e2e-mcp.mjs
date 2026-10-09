// End-to-end: drive the MCP servers as an MCP client would, one per desk, against
// a live ledger (DevNet, or the local sandbox with ENV_FILE=.env.local).
//   node scripts/e2e-mcp.mjs        (after `npm run seed`)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PARTIES as p, submit, create } from '../lib/ledger.mjs';

let failed = 0, passed = 0;
const check = (ok, label) => { console.log(`${ok ? '✓' : '✗'} ${label}`); ok ? passed++ : failed++; };

async function agent(role) {
  const c = new Client({ name: 'e2e', version: '0' });
  await c.connect(new StdioClientTransport({ command: 'node', args: ['mcp/server.mjs'], env: { ...process.env, TALANG_ROLE: role } }));
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { error: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  return { c, call, tools: (await c.listTools()).tools.map((t) => t.name) };
}

const A = await agent('lenderA'), B = await agent('lenderB'), C = await agent('lenderC');
const BOR = await agent('borrower'), REG = await agent('regulator');

check(['portfolio', 'open_requests', 'quote', 'call_margin', 'review_substitution', 'offer_roll', 'loss_history', 'privacy_check']
  .every((t) => A.tools.includes(t)), `lender agent: ${A.tools.length} tools`);
check(['quotes', 'award', 'book', 'accept_roll', 'privacy_check'].every((t) => BOR.tools.includes(t)), `borrower agent: ${BOR.tools.length} tools`);
check(['lifecycle', 'best_execution', 'privacy_check'].every((t) => REG.tools.includes(t)), `regulator agent: ${REG.tools.length} tools`);
check((await REG.call('award', { request: 'x', quote: 'best' })).error?.includes('not a regulator tool'), 'a regulator agent cannot reach borrower tools');

// ---- privacy, read from every node ----
for (const [label, ag] of [['A', A], ['B', B], ['C', C]]) {
  const priv = (await ag.call('privacy_check')).data;
  check(priv.rivalQuotesVisible === 0 && priv.reposNotMine === 0 && priv.lossNoticesNotMine === 0 && priv.bestExecutionVisible === 0,
    `lender ${label}: ${priv.quotesVisible} quotes visible, 0 rival quotes, 0 other repos, 0 other loss notices, 0 best-ex records`);
}
const rp = (await REG.call('privacy_check')).data;
check(rp.requestsVisible === 0 && rp.quotesVisible === 0 && rp.lossNoticesVisible === 0 && rp.positionsVisible === 0 && rp.reports > 0,
  `regulator: ${rp.reports} reports, ${rp.bestExecution} best-ex records, 0 requests, 0 quotes, 0 loss notices, 0 positions`);

// ---- best execution without leakage ----
const be = (await REG.call('best_execution')).data;
const notBest = be.find((x) => x.winnerRank > 1 && x.quotesConsidered === 3);
check(!!notBest, `regulator sees ${be.length} awards; one took rank ${notBest?.winnerRank} of ${notBest?.quotesConsidered}, ${notBest?.spreadToBestBps}bp over the best rate, no lender named`);
const lossA = (await A.call('loss_history')).data, lossB = (await B.call('loss_history')).data;
check(lossA.some((n) => n.outOf === 3 && n.rank === 3) && lossB.some((n) => n.outOf === 3 && n.rank === 1),
  `losers told only their rank: A ${lossA.map((n) => `${n.rank}/${n.outOf}`).join(', ')}; B ${lossB.map((n) => `${n.rank}/${n.outOf}`).join(', ')}`);

const life = (await REG.call('lifecycle')).data;
const close = life.find((e) => e.event === 'CLOSE');
check(close && close.venueFee > 0, `lifecycle: ${life.length} events, close paid the venue ${close?.venueFee}`);

// ---- borrower agent: rank, award the best covered quote ----
const open = (await BOR.call('quotes')).data.find((r) => r.quotes.length >= 2);
check(open && open.quotes[0].rateBps <= open.quotes[1].rateBps, `borrower sees ${open?.quotes.length} sealed quotes ranked by rate on ${open?.collateral}`);
if (open) {
  // The borrower needs the collateral to pledge.
  const [qty, instrument] = open.collateral.split(' ');
  await submit(p.bondIssuer, create('Holding', { issuer: p.bondIssuer, owner: p.borrower, instrument, amount: qty }));
  const aw = await BOR.call('award', { request: open.request, quote: 'best' });
  check(aw.data?.opened && aw.data.refunded === open.quotes.length - 1,
    `borrower agent awarded the best covered quote (${aw.error ?? `${aw.data.lender} @ ${aw.data.rateBps}bp, ${aw.data.refunded} refunded`})`);
}

// ---- roll ----
const book = (await BOR.call('book')).data;
const withRoll = book.find((t) => t.rollOffer);
check(!!withRoll, `borrower book: ${book.length} repos, roll offer at ${withRoll?.rollOffer?.newRateBps}bp on ${withRoll?.collateral}`);
if (withRoll) {
  const r = await BOR.call('accept_roll', { offer: withRoll.rollOffer.id });
  check(r.data?.rolled, `roll accepted: ${r.error ?? `paid ${r.data.paidNow} now, continues at ${r.data.newRateBps}bp`}`);
}

// ---- lender agent: the ledger, not the tool, refuses a call the mark does not justify ----
// The first lender with a covered repo and a fresh mark takes the test.
let L = null, covered = null;
for (const ag of [B, A, C]) {
  covered = (await ag.call('portfolio')).data.find((t) => t.coverage >= 1 && t.markFresh && !t.marginCall);
  if (covered) { L = ag; break; }
}
if (covered) {
  const B = L;
  const r = await B.call('call_margin', { repo: covered.repo });
  check(r.error && /still covers/.test(r.error), `call on a covered repo refused by the ledger (${covered.collateral}, ${(covered.coverage * 100).toFixed(1)}%)`);
  const [, instrument] = covered.collateral.split(' ');
  await submit(p.agent, create('Mark', { agent: p.agent, instrument, price: String(Math.round(covered.mark * 0.94)),
    asOf: new Date().toISOString(), audience: [p.borrower, p.lenderA, p.lenderB, p.lenderC] }));
  const after = (await B.call('portfolio')).data.find((t) => t.repo === covered.repo);
  check(after.coverage < 1, `after a 6% markdown coverage is ${(after.coverage * 100).toFixed(1)}%, short ${after.unitsShort} ${instrument}`);
  const ok = await B.call('call_margin', { repo: covered.repo, hoursToRespond: 48 });
  check(ok.data?.called === true, `margin call issued by the agent (${ok.error ?? ok.data.marginCall})`);
} else {
  console.log('· no covered repo with a fresh mark for B: run `npm run marks` and retry for the write checks');
}

// ---- lender agent offers a roll the borrower agent then sees ----
const bookA = (await A.call('portfolio')).data.find((t) => !t.rollOffer && !t.matured);
if (bookA) {
  const o = await A.call('offer_roll', { repo: bookA.repo, newRateBps: 490, extraDays: 14 });
  const seen = (await BOR.call('book')).data.some((t) => t.rollOffer?.newRateBps === 490);
  check(o.data?.offered && seen, `lender A offered a roll at 490bp; the borrower's agent sees it`);
}

for (const ag of [A, B, C, BOR, REG]) await ag.c.close();
console.log(failed ? `\n${failed} of ${passed + failed} checks failed` : `\nall ${passed} checks passed`);
process.exit(failed ? 1 : 0);
