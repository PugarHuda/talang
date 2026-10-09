// One repo on DevNet with real CBTC as collateral, no mocks. The borrower's CBTC
// (from the BitSafe faucet) is locked through the CBTC registry's own
// AllocationFactory as an allocation to the lender, executed by the borrower;
// the cash leg is the desk's escrowed USDC (USDCx is not on DevNet). Repurchase
// cancels the allocation with the registry's cancel context, so the CBTC goes home.
//
//   node scripts/cbtc-rail.mjs            (DevNet credentials, run from scripts/devnet-ci.mjs)
//   DRY_RUN=1 node scripts/cbtc-rail.mjs  (no ledger: prints the factory request, calls the registry)
import { writeFileSync, mkdirSync } from 'node:fs';
import { PARTIES as p, LEDGER, api, submit, create, exercise, created } from '../lib/ledger.mjs';
import { allocationFactory, allocationContext, transferInstructionContext, disclosed } from '../lib/registry.mjs';

const ADMIN = process.env.CBTC_ADMIN ?? 'cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff';
const CBTC = { admin: ADMIN, id: 'CBTC' };
const QTY = process.env.CBTC_QTY ?? '0.001';     // units pledged; mark 62,000 -> 62 USDC of value
const PRINCIPAL = '50', TERM_DAYS = 1, HAIRCUT = '0.10', RATE = '600';
const HOLDING = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';
const TRANSFER = '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction';
const ALLOCATION = '#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation';
const FACTORY = '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory';
const DRY = !!process.env.DRY_RUN;
const meta = { values: {} };
const at = (ms) => new Date(Date.now() + ms).toISOString();
const H = 3600e3, D = 24 * H;

const log = [];
const step = (label, tx, extra = {}) => {
  const e = { step: label, updateId: tx?.transaction?.updateId, offset: tx?.transaction?.offset, ...extra };
  log.push(e); console.log(`✓ ${label}${e.offset != null ? `  (offset ${e.offset})` : ''}`);
};

// Interface views of what `party` sees through one Splice interface.
async function views(party, interfaceId) {
  const off = (await api('/v2/state/ledger-end')).data?.offset;
  const r = await api('/v2/state/active-contracts', { method: 'POST', json: {
    eventFormat: { verbose: true, filtersByParty: { [party]: { cumulative: [{ identifierFilter: { InterfaceFilter: { value: {
      interfaceId, includeInterfaceView: true, includeCreatedEventBlob: false } } } }] } } }, activeAtOffset: off } });
  if (!Array.isArray(r.data)) throw new Error(`active-contracts ${interfaceId}: ${JSON.stringify(r.data).slice(0, 1500)}`);
  return r.data.map((x) => x.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean)
    .map((e) => ({ cid: e.contractId, templateId: e.templateId, view: e.interfaceViews?.find((v) => v.viewValue)?.viewValue,
      viewStatus: e.interfaceViews?.[0]?.viewStatus }));
}
const sameInstrument = (i) => i?.admin === CBTC.admin && i?.id === CBTC.id;
const unlockedCbtc = async (owner) => (await views(owner, HOLDING))
  .filter((h) => h.view?.owner === owner && sameInstrument(h.view.instrumentId) && h.view.lock == null);

// Allocation spec Open checks: sender borrower, receiver lender, executor borrower,
// CBTC, settleBefore past maturity + the 3-day claim window (Talang.daml claimWindow).
const ref = `talang-cbtc-${Date.now().toString(36)}`;
const requestedAt = at(-60e3);   // registries refuse a request time in the future
const spec = {
  settlement: { executor: p.borrower, settlementRef: { id: ref, cid: null }, requestedAt,
    allocateBefore: at(H), settleBefore: at((TERM_DAYS + 4) * D), meta },
  transferLegId: 'collateral',
  transferLeg: { sender: p.borrower, receiver: p.lenderA, amount: QTY, instrumentId: CBTC, meta },
};
const factoryArgs = (inputHoldingCids) => ({ expectedAdmin: ADMIN, allocation: spec, requestedAt, inputHoldingCids,
  extraArgs: { context: { values: {} }, meta } });

if (DRY) {
  console.log('factory request:', JSON.stringify(factoryArgs(['<holding cid>']), null, 1));
  try { await allocationFactory(ADMIN, factoryArgs([])); } catch (e) { console.log('registry answers (no holdings):', e.message); }
  process.exit(0);
}

try {
  // 0. What the borrower sees: every HoldingV1 (any instrument) and every pending
  // TransferInstructionV1. A faucet without a transfer preapproval leaves an offer,
  // not a holding; the borrower accepts it with the registry's accept context.
  const short = (x) => String(x ?? '').split('::')[0];
  const seenH = await views(p.borrower, HOLDING);
  console.log(`HoldingV1 visible to borrower: ${seenH.length}`);
  for (const h of seenH) console.log(`  ${h.cid.slice(0, 16)} owner=${short(h.view?.owner)} ${h.view?.instrumentId?.id}@${short(h.view?.instrumentId?.admin)} amount=${h.view?.amount} locked=${h.view?.lock != null} tpl=${h.templateId}${h.view ? '' : ` viewStatus=${JSON.stringify(h.viewStatus)}`}`);
  const seenT = await views(p.borrower, TRANSFER);
  console.log(`TransferInstructionV1 visible to borrower: ${seenT.length}`);
  for (const t of seenT) { const x = t.view?.transfer;
    console.log(`  ${t.cid.slice(0, 16)} ${short(x?.sender)} -> ${short(x?.receiver)} ${x?.amount} ${x?.instrumentId?.id}@${short(x?.instrumentId?.admin)} status=${t.view?.status?.tag ?? JSON.stringify(t.view?.status)} tpl=${t.templateId}${t.view ? '' : ` viewStatus=${JSON.stringify(t.viewStatus)}`}`); }
  for (const t of seenT.filter((t) => t.view?.transfer?.receiver === p.borrower && sameInstrument(t.view.transfer.instrumentId)
    && t.view.status?.tag === 'TransferPendingReceiverAcceptance')) {
    const c = await transferInstructionContext(ADMIN, t.cid, 'accept');
    const tx = await submit(p.borrower, { ExerciseCommand: { templateId: TRANSFER, contractId: t.cid, choice: 'TransferInstruction_Accept',
      choiceArgument: { extraArgs: { context: c.choiceContextData, meta } } } }, [], { disclosedContracts: disclosed(c.disclosedContracts) });
    step(`accepted CBTC transfer offer of ${t.view.transfer.amount} from ${short(t.view.transfer.sender)}`, tx,
      { instructionCid: t.cid, amount: t.view.transfer.amount, sender: t.view.transfer.sender, disclosedContracts: c.disclosedContracts.map((d) => d.templateId) });
  }

  // 1. The borrower's CBTC, read through the standard HoldingV1 interface.
  const holdings = await unlockedCbtc(p.borrower);
  const total = holdings.reduce((s, h) => s + Number(h.view.amount), 0);
  if (total < Number(QTY)) throw new Error(`borrower holds ${total} unlocked CBTC, needs ${QTY}: fund it from the BitSafe faucet`);
  const inputs = [];
  for (let s = 0, i = 0; s < Number(QTY); i++) { inputs.push(holdings[i].cid); s += Number(holdings[i].view.amount); }
  step(`borrower holds ${total} CBTC in ${holdings.length} holdings (HoldingV1)`, null, { borrowerCBTC: total, inputs, holdingTemplate: holdings[0].templateId });

  // 2. Allocate through the registry's factory with its context and disclosed contracts.
  const fac = await allocationFactory(ADMIN, factoryArgs(inputs));
  const allocTx = await submit(p.borrower, { ExerciseCommand: { templateId: FACTORY, contractId: fac.factoryId,
    choice: 'AllocationFactory_Allocate',
    choiceArgument: { ...factoryArgs(inputs), extraArgs: { context: fac.choiceContext.choiceContextData, meta } } } },
  [], { disclosedContracts: disclosed(fac.choiceContext.disclosedContracts),
    transactionFormat: { transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS', eventFormat: { verbose: true,
      filtersByParty: { [p.borrower]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } } } } });
  const result = (allocTx?.transaction?.events ?? []).map((e) => e.ExercisedEvent).find((e) => e?.choice === 'AllocationFactory_Allocate')?.exerciseResult;
  // The factory may answer Completed (allocation made) or Pending (registrar must
  // still act); in both cases the allocation is found by its settlement ref.
  let alloc;
  for (let i = 0; i < 20 && !alloc; i++) {
    alloc = (await views(p.borrower, ALLOCATION)).find((a) => a.view?.allocation?.settlement?.settlementRef?.id === ref);
    if (!alloc) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!alloc) throw new Error(`no CBTC allocation with ref ${ref} after 60 s; factory result: ${JSON.stringify(result)}`);
  step('CBTC allocated to lender A through the registry AllocationFactory', allocTx,
    { factoryId: fac.factoryId, allocationCid: alloc.cid, allocationTemplate: alloc.templateId, factoryOutput: result?.output?.tag,
      disclosedContracts: fac.choiceContext.disclosedContracts.map((d) => d.templateId) });

  // 3. RFQ, one sealed quote in desk USDC, award with the CBTC allocation as collateral.
  const mark = created(await submit(p.agent, create('Mark', { agent: p.agent, instrument: 'CBTC', price: '62000',
    asOf: new Date().toISOString(), audience: [p.borrower, p.lenderA] })), 'Mark');
  const rfqTx = await submit(p.borrower, create('RepoRFQ', { borrower: p.borrower, regulator: p.regulator, agent: p.agent,
    lenders: [p.lenderA], deadline: at(D), venue: null,
    terms: { cashIssuer: p.cashIssuer, cashInstrument: 'USDC', principal: PRINCIPAL, collateralIssuer: ADMIN,
      collateralInstrument: 'CBTC', collateralQty: QTY, termDays: String(TERM_DAYS) } }));
  const rfq = created(rfqTx, 'RepoRFQ');
  step(`RepoRFQ: ${PRINCIPAL} USDC against ${QTY} CBTC, ${TERM_DAYS} day`, rfqTx);
  const cash = created(await submit(p.cashIssuer, create('Holding', { issuer: p.cashIssuer, owner: p.lenderA, instrument: 'USDC', amount: PRINCIPAL })), 'Holding');
  const quoteTx = await submit(p.lenderA, exercise('RepoRFQ', rfq, 'SubmitQuote', { lender: p.lenderA, rateBps: RATE, haircut: HAIRCUT, cashCid: cash }));
  step('sealed quote, principal escrowed in desk USDC', quoteTx);
  const awardTx = await submit(p.borrower, exercise('RepoRFQ', rfq, 'AwardWithTokenCollateral',
    { winner: created(quoteTx, 'RepoQuote'), losers: [], collateralAlloc: alloc.cid, markCid: mark, contexts: [] }));
  const trade = created(awardTx, 'RepoTrade');
  step('award: USDC released to the borrower, CBTC allocation held as collateral', awardTx, { trade });

  // 4. Repurchase in desk USDC; the CBTC allocation is cancelled with the registry's context.
  const pay = created(await submit(p.cashIssuer, create('Holding', { issuer: p.cashIssuer, owner: p.borrower, instrument: 'USDC', amount: '60' })), 'Holding');
  const ctx = await allocationContext(ADMIN, alloc.cid, 'cancel');
  const repoTx = await submit(p.borrower, exercise('RepoTrade', trade, 'Repurchase', { cashCid: pay,
    contexts: [{ _1: alloc.cid, _2: { context: ctx.choiceContextData, meta } }] }), [],
  { disclosedContracts: disclosed(ctx.disclosedContracts) });
  const back = (await unlockedCbtc(p.borrower)).reduce((s, h) => s + Number(h.view.amount), 0);
  const stillAllocated = (await views(p.borrower, ALLOCATION)).some((a) => a.cid === alloc.cid);
  if (stillAllocated) throw new Error('repurchase committed but the CBTC allocation is still active');
  step('repurchase: USDC to the lender, CBTC allocation cancelled through the registry', repoTx,
    { borrowerCBTCAfter: back, disclosedContracts: ctx.disclosedContracts.map((d) => d.templateId) });

  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync('docs/evidence/cbtc-rail-devnet.json', JSON.stringify({ ledger: LEDGER, ranAt: new Date().toISOString(),
    registry: `DA Utility registry, admin ${ADMIN}, instrument CBTC`, cash: 'desk USDC (Talang Holding/Escrow)', steps: log }, null, 2) + '\n');
  console.log('\nevidence written to docs/evidence/cbtc-rail-devnet.json');
} catch (e) {
  console.error(`✗ ${e.message}`);
  console.error('steps done:', JSON.stringify(log));
  process.exit(1);
}
