// Leave one open request on the desk. Seed runs that were cut short (a timeout, a
// missing permission) each left an open request with sealed quotes whose cash stays
// locked; the borrower rejects those quotes, which refunds each lender, and cancels
// the request. Repos, margin calls and reports are real history and stay.
//   node scripts/devnet-tidy.mjs        (DevNet; ENV_FILE=.env.local for the sandbox)
import { PARTIES as p, acs, submit, exercise, NO_CONTEXTS } from '../lib/ledger.mjs';

const { contracts } = await acs(p.borrower);
const rfqs = contracts.filter((c) => c.tpl === 'RepoRFQ');
const quotes = contracts.filter((c) => c.tpl === 'RepoQuote');
const quotesOf = (r) => quotes.filter((q) => q.arg.rfqId === r.cid);
// Keep the request with the most quotes; the rest go.
const keep = rfqs.slice().sort((a, b) => quotesOf(b).length - quotesOf(a).length)[0];
console.log(`${rfqs.length} open requests; keeping one with ${keep ? quotesOf(keep).length : 0} quotes`);
for (const r of rfqs.filter((x) => x !== keep)) {
  for (const q of quotesOf(r)) await submit(p.borrower, exercise('RepoQuote', q.cid, 'RejectQuote', { contexts: NO_CONTEXTS }));
  await submit(p.borrower, exercise('RepoRFQ', r.cid, 'CancelRFQ'));
  console.log(`✓ cancelled ${r.arg.terms.collateralQty} ${r.arg.terms.collateralInstrument} for ${r.arg.terms.principal}, ${quotesOf(r).length} quotes refunded`);
}
