// Security regression for daml/Talang.daml (1.1.0), against a local sandbox:
//   ENV_FILE=.env.local PARTIES_FILE=parties.local.json node scripts/sec-daml.mjs
// Each check prints VULNERABLE when the exploit goes through, SAFE when the ledger refuses.
// It uses its own instrument (SECBOND) so the seeded desk's marks are untouched.
import { PARTIES as p, api, submit, created, create, exercise, NO_CONTEXTS } from '../lib/ledger.mjs';

const I = 'SECBOND', now = () => new Date().toISOString();
const mint = async (issuer, owner, instrument, amount) =>
  created(await submit(issuer, create('Holding', { issuer, owner, instrument, amount: String(amount) })), 'Holding');
const mark = async (price, asOf = now()) => created(await submit(p.agent, create('Mark',
  { agent: p.agent, instrument: I, price: String(price), asOf, audience: [p.borrower, p.lenderA, p.lenderB] })), 'Mark');
const tryIt = async (f) => { try { return { ok: true, v: await f() }; } catch (e) { return { ok: false, e: e.message.slice(0, 160) }; } };
const verdict = (name, vulnerable, detail) => console.log(`${vulnerable ? 'VULNERABLE' : 'SAFE      '}  ${name}${detail ? '  -- ' + detail : ''}`);
const offset = async () => (await api('/v2/state/ledger-end')).data.offset;

// Everything `party`'s node was told in (from, to]: the transaction trees, not the ACS.
async function seen(party, from, to) {
  const r = await api('/v2/updates', { method: 'POST', json: { beginExclusive: from, endInclusive: to, updateFormat: {
    includeTransactions: { transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
      eventFormat: { verbose: true, filtersByParty: { [party]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } } } } } });
  if (!Array.isArray(r.data)) throw new Error('updates: ' + JSON.stringify(r.data).slice(0, 300));
  return r.data.flatMap((u) => u.update?.Transaction?.value?.events ?? []);
}

async function rfq(venue = null, lenders = [p.lenderA, p.lenderB]) {
  return created(await submit(p.borrower, create('RepoRFQ', { borrower: p.borrower, regulator: p.regulator, agent: p.agent, lenders,
    terms: { cashIssuer: p.cashIssuer, cashInstrument: 'USDC', principal: '1000.0', collateralIssuer: p.bondIssuer,
      collateralInstrument: I, collateralQty: '20.0', termDays: '30' }, deadline: null, venue })), 'RepoRFQ');
}
async function quote(r, lender, rateBps) {
  const cashCid = await mint(p.cashIssuer, lender, 'USDC', 1000);
  return created(await submit(lender, exercise('RepoRFQ', r, 'SubmitQuote', { lender, rateBps: String(rateBps), haircut: '0.02', cashCid })), 'RepoQuote');
}

const m1 = await mark(100);

// 1. Award is a consuming choice on RepoRFQ, whose observers are every invited lender, so each
//    lender is an informee of the whole Award tree: the winner's RepoTrade, rivals' LossNotices.
const before = await offset();
const r1 = await rfq();
const qa = await quote(r1, p.lenderA, 400), qb = await quote(r1, p.lenderB, 450);
const col1 = await mint(p.bondIssuer, p.borrower, I, 20);
const tx = await submit(p.borrower, exercise('RepoRFQ', r1, 'AwardSealed', { winner: qa, losers: [qb], collateralCid: col1, markCid: m1, contexts: NO_CONTEXTS }));
const trade = created(tx, 'RepoTrade');
const evB = await seen(p.lenderB, before, await offset());
const leakTrade = evB.map((e) => e.CreatedEvent).find((c) => c?.templateId?.endsWith(':RepoTrade'));
verdict('losing lender sees winner + winning rate via Award divulgence', !!leakTrade,
  leakTrade && `lenderB saw RepoTrade lender=${leakTrade.createArgument.lender.split('::')[0]} rateBps=${leakTrade.createArgument.rateBps}`);

// 2. venue is chosen by the borrower when it creates the RFQ: null means no fee, ever.
const t1 = tx.transaction.events.map((e) => e.CreatedEvent).find((c) => c?.contractId === trade).createArgument;
verdict('borrower skips the venue fee by creating the RFQ with venue = null', t1.venue === null, `trade.venue=${JSON.stringify(t1.venue)}`);

// 3. Best execution: the borrower names only the losers it wants ranked; a cheaper quote left out
//    makes the award look rank 1 of 1 to the regulator.
const r2 = await rfq();
const cheap = await quote(r2, p.lenderA, 300), dear = await quote(r2, p.lenderB, 500);
const col2 = await mint(p.bondIssuer, p.borrower, I, 20);
const tx2 = await submit(p.borrower, exercise('RepoRFQ', r2, 'AwardSealed', { winner: dear, losers: [], collateralCid: col2, markCid: m1, contexts: NO_CONTEXTS }));
const be = tx2.transaction.events.map((e) => e.CreatedEvent).find((c) => c?.templateId?.endsWith(':BestExecution'))?.createArgument;
verdict('borrower hides a cheaper quote from best-execution', be?.winnerRank === '1' || be?.winnerRank === 1, `BestExecution rank ${be?.winnerRank}/${be?.quotesConsidered}, real rank 2/2`);
await submit(p.lenderA, exercise('RepoQuote', cheap, 'WithdrawQuote', { contexts: NO_CONTEXTS }));

// 4. Substitution with self-issued collateral: Approve checks the mark by instrument NAME only.
const junk = await mint(p.borrower, p.borrower, I, 20); // issuer = borrower
const sub = created(await submit(p.borrower, exercise('RepoTrade', trade, 'ProposeSubstitution', { holdingCid: junk })), 'Substitution');
const ap = await tryIt(() => submit(p.lenderA, exercise('Substitution', sub, 'Approve', { markCid: m1, contexts: NO_CONTEXTS })));
const trade2 = ap.ok ? created(ap.v, 'RepoTrade') : trade;
verdict('lender approves borrower-issued collateral as the real bond', ap.ok, ap.ok ? 'real SECBOND released to borrower, lender holds borrower IOU' : ap.e);

// 5. Margin with a cherry-picked mark: any mark from the agent younger than 24h is accepted, not the latest.
const old = await mark(40, new Date(Date.now() - 3600e3).toISOString());
const m2 = await mark(100);
const mc = await tryIt(() => submit(p.lenderA, exercise('RepoTrade', trade2, 'CallMargin',
  { markCid: old, respondBy: new Date(Date.now() + 3 * 3600e3).toISOString() })));
verdict('lender calls margin on an older, lower mark though the latest covers', mc.ok, mc.ok ? 'called at 40 while latest is 100' : mc.e);

// 6. Negative / zero / huge inputs the ensure clauses should refuse.
for (const [name, f] of [
  ['negative split', () => submit(p.cashIssuer, exercise('Holding', 'x', 'Split', { splitAmount: '-1' }))],
  ['zero mark', () => submit(p.agent, create('Mark', { agent: p.agent, instrument: I, price: '0', asOf: now(), audience: [] }))],
  ['haircut 0.5', async () => { const r = await rfq(); const c = await mint(p.cashIssuer, p.lenderA, 'USDC', 1000);
    return submit(p.lenderA, exercise('RepoRFQ', r, 'SubmitQuote', { lender: p.lenderA, rateBps: '1', haircut: '0.5', cashCid: c })); }],
  ['RFQ principal 1e28 (Decimal overflow)', () => rfq().then(() => submit(p.borrower, create('RepoRFQ', { borrower: p.borrower, regulator: p.regulator, agent: p.agent, lenders: [p.lenderA],
    terms: { cashIssuer: p.cashIssuer, cashInstrument: 'USDC', principal: '1' + '0'.repeat(28), collateralIssuer: p.bondIssuer, collateralInstrument: I, collateralQty: '1', termDays: '1' }, deadline: null, venue: null })))],
]) { const r = await tryIt(f); verdict(`ensure refuses ${name}`, r.ok, r.ok ? 'accepted' : r.e.slice(0, 80)); }

// Leave the agent's mark list as it was: a busy party's ACS read has a 200-element cap.
for (const m of [m1, old, m2]) await tryIt(() => submit(p.agent, exercise('Mark', m, 'Archive')));
