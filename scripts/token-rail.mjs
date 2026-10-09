// One repo with both legs in Canton Token Standard assets, on a live participant:
// USDCx quotes and CBTC collateral as standard Allocations, the repurchase read as
// a standard AllocationRequest, settled with the venue's fee leg. The registries
// here are test/daml/MockRegistry.daml, which implements the real Splice
// HoldingV1 / AllocationV1 interfaces; a live registry (USDCx, CBTC) is driven
// through the same interface choices plus its off-ledger choice context.
//
//   ENV_FILE=.env.local node scripts/token-rail.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PARTIES as p, LEDGER, USER, api, acs, submit, create, exercise, created } from '../lib/ledger.mjs';

const REG = (t) => `#talang-test:MockRegistry:${t}`;
const REQ = '#splice-api-token-allocation-request-v1:Splice.Api.Token.AllocationRequestV1:AllocationRequest';
const meta = { values: {} };
const log = [];
const step = (label, tx, extra = {}) => {
  const e = { step: label, updateId: tx?.transaction?.updateId, offset: tx?.transaction?.offset, ...extra };
  log.push(e); console.log(`✓ ${label}${e.offset != null ? `  (offset ${e.offset})` : ''}`);
};
const createdOf = (tx, suffix) => (tx?.transaction?.events ?? []).map((e) => e.CreatedEvent).filter(Boolean)
  .filter((c) => c.templateId?.endsWith(suffix)).map((c) => c.contractId);

async function allocate(hint) {
  const r = await api('/v2/parties', { method: 'POST', json: { partyIdHint: `${hint}-${Date.now().toString(36)}`, identityProviderId: '' } });
  if (!r.ok) throw new Error(`allocate ${hint}: ${JSON.stringify(r.data).slice(0, 200)}`);
  const party = r.data.partyDetails.party;
  await api(`/v2/users/${USER}/rights`, { method: 'POST', json: { userId: USER, identityProviderId: '',
    rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }] } });
  return party;
}

const up = await api('/v2/packages', { method: 'POST', bytes: readFileSync('test/.daml/dist/talang-test-0.1.0.dar') });
if (!up.ok) throw new Error('upload test DAR: ' + JSON.stringify(up.data).slice(0, 200));
const usdcx = await allocate('talang-usdcx-registry'), cbtc = await allocate('talang-cbtc-registry');
step('two registries implementing Splice HoldingV1 / AllocationV1: USDCx and CBTC', null, { usdcx, cbtc });

const mint = async (registry, tag, owner, amount) =>
  createdOf(await submit(registry, { CreateCommand: { templateId: REG('MockHolding'),
    createArguments: { registry, owner, instrumentTag: tag, amount: String(amount) } } }), ':MockHolding')[0];
// What a wallet does when asked to fund a leg.
async function allocateLeg(registry, tag, holding, sender, receiver, amount, settleBefore) {
  const now = new Date().toISOString();
  const tx = await submit(sender, { ExerciseCommand: { templateId: REG('MockHolding'), contractId: holding, choice: 'MockAllocate',
    choiceArgument: { spec: {
      settlement: { executor: p.borrower, settlementRef: { id: 'talang', cid: null }, requestedAt: now,
        allocateBefore: settleBefore, settleBefore, meta },
      transferLegId: 'leg',
      transferLeg: { sender, receiver, amount: String(amount), instrumentId: { admin: registry, id: tag }, meta } } } } });
  return createdOf(tx, ':MockAllocation')[0];
}
const owns = async (party, registry, tag) => {
  const r = await api('/v2/state/active-contracts', { method: 'POST', json: {
    filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: { templateId: REG('MockHolding'), includeCreatedEventBlob: false } } } }] } } },
    verbose: true, activeAtOffset: (await api('/v2/state/ledger-end')).data.offset } });
  return r.data.map((x) => x.contractEntry?.JsActiveContract?.createdEvent?.createArgument).filter(Boolean)
    .filter((h) => h.owner === party && h.registry === registry && h.instrumentTag === tag).reduce((s, h) => s + Number(h.amount), 0);
};
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();

// Request: 50,000 USDCx against 1 CBTC for 30 days, venue at 10 bp.
const markTx = await submit(p.agent, create('Mark', { agent: p.agent, instrument: 'CBTC', price: '62000', asOf: new Date().toISOString(),
  audience: [p.borrower, p.lenderA, p.lenderB] }));
const mark = created(markTx, 'Mark');
const rfqTx = await submit(p.borrower, create('RepoRFQ', { borrower: p.borrower, regulator: p.regulator, agent: p.agent,
  lenders: [p.lenderA, p.lenderB], deadline: inDays(1), venue: { operator: p.venue, feeBps: '10.0' },
  terms: { cashIssuer: usdcx, cashInstrument: 'USDCx', principal: '50000', collateralIssuer: cbtc, collateralInstrument: 'CBTC', collateralQty: '1', termDays: '30' } }));
const rfq = created(rfqTx, 'RepoRFQ');
step('RepoRFQ: 50,000 USDCx against 1 CBTC, 30 days, venue 10 bp', rfqTx);

const quotes = [];
for (const [lender, rate, haircut] of [[p.lenderA, '600', '0.10'], [p.lenderB, '620', '0.08']]) {
  const alloc = await allocateLeg(usdcx, 'USDCx', await mint(usdcx, 'USDCx', lender, 50000), lender, p.borrower, 50000, inDays(1));
  const tx = await submit(lender, exercise('RepoRFQ', rfq, 'SubmitTokenQuote', { lender, rateBps: rate, haircut, allocCid: alloc }));
  quotes.push(created(tx, 'RepoQuote'));
  step(`sealed quote funded by a USDCx allocation (${rate} bp)`, tx);
}
const rivalSees = (await acs(p.lenderB)).contracts.filter((c) => c.tpl === 'RepoQuote' && c.arg.lender !== p.lenderB).length;
step(`lender B's node holds ${rivalSees} rival quotes`, null, { rivalQuotesOnLenderB: rivalSees });

const pledge = await allocateLeg(cbtc, 'CBTC', await mint(cbtc, 'CBTC', p.borrower, 1), p.borrower, p.lenderA, 1, inDays(40));
const awardTx = await submit(p.borrower, exercise('RepoRFQ', rfq, 'AwardWithTokenCollateral',
  { winner: quotes[0], losers: [quotes[1]], collateralAlloc: pledge, markCid: mark, contexts: [] }));
const trade = created(awardTx, 'RepoTrade');
step('award: USDCx allocation executed to the borrower, B\'s cancelled back to B, CBTC held for A', awardTx, {
  borrowerUSDCx: await owns(p.borrower, usdcx, 'USDCx'), lenderBUSDCx: await owns(p.lenderB, usdcx, 'USDCx'), borrowerCBTC: await owns(p.borrower, cbtc, 'CBTC') });

const noticeTx = await submit(p.borrower, exercise('RepoTrade', trade, 'NoticeRepurchase', { settleBefore: inDays(1) }));
const notice = created(noticeTx, 'RepurchaseNotice');
const view = await api('/v2/state/active-contracts', { method: 'POST', json: {
  filter: { filtersByParty: { [p.borrower]: { cumulative: [{ identifierFilter: { InterfaceFilter: { value: { interfaceId: REQ, includeInterfaceView: true, includeCreatedEventBlob: false } } } }] } } },
  verbose: true, activeAtOffset: (await api('/v2/state/ledger-end')).data.offset } });
const req = view.data.map((x) => x.contractEntry?.JsActiveContract?.createdEvent).find((e) => e?.contractId === notice)?.interfaceViews?.[0]?.viewValue;
const legs = Object.entries(req?.transferLegs ?? {}).map(([k, l]) => ({ leg: k, to: l.receiver === p.lenderA ? 'lenderA' : 'venue', amount: Number(l.amount) }));
step('repurchase notice read through the standard AllocationRequest interface', noticeTx, { legs });

const due = legs.find((l) => l.leg === 'repurchase').amount, fee = legs.find((l) => l.leg === 'venue-fee')?.amount ?? 0;
const allocPI = await allocateLeg(usdcx, 'USDCx', await mint(usdcx, 'USDCx', p.borrower, due), p.borrower, p.lenderA, due, inDays(1));
const allocFee = await allocateLeg(usdcx, 'USDCx', await mint(usdcx, 'USDCx', p.borrower, fee), p.borrower, p.venue, fee, inDays(1));
const va = created(await submit(p.venue, create('VenueAgreement', { operator: p.venue, borrower: p.borrower, feeBps: '10.0' })), 'VenueAgreement');
const settleTx = await submit(p.borrower, exercise('RepurchaseNotice', notice, 'SettleRepurchase',
  { lenderAlloc: allocPI, feeAlloc: allocFee, venueAgreement: va, contexts: [] }));
step('settled: USDCx to the lender and the venue, CBTC allocation cancelled back to the borrower', settleTx, {
  lenderAUSDCx: await owns(p.lenderA, usdcx, 'USDCx'), venueUSDCx: await owns(p.venue, usdcx, 'USDCx'), borrowerCBTC: await owns(p.borrower, cbtc, 'CBTC') });

mkdirSync('docs/evidence', { recursive: true });
const where = /localhost|127\.0\.0\.1/.test(LEDGER) ? 'local-sandbox' : 'devnet';
writeFileSync(`docs/evidence/cip56-token-repo-${where}.json`, JSON.stringify({ ledger: where === 'devnet' ? LEDGER : 'local Canton sandbox 3.4.11',
  ranAt: new Date().toISOString(), registries: 'test/daml/MockRegistry.daml (implements Splice HoldingV1 / AllocationV1)', steps: log }, null, 2) + '\n');
console.log(`\nevidence written to docs/evidence/cip56-token-repo-${where}.json`);
