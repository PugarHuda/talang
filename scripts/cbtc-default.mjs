// A repo on DevNet that ends in default, with real CBTC as collateral: the pledged
// CBTC allocation is executed to the lender through the DA Utility registry's
// execute-transfer context (MarginCall.Default -> waterfall -> Allocation_ExecuteTransfer).
// A margin call must give the borrower at least 2 hours (marginResponseMin), so the
// run is two phases, each its own Vercel build:
//
//   PHASE=open     borrower allocates 0.001 CBTC (registry AllocationFactory), RFQ for
//                  51.25 desk USDC over 2 days, award at mark 62,000; the agent then
//                  publishes a STRESS mark (a scenario, not a market price) of 52,000,
//                  under which the pledge no longer covers, and lender A calls margin
//                  with respondBy = now + 2 h 2 min. Nothing more happens; the borrower
//                  does not answer.
//   PHASE=default  once respondBy has passed: lender A exercises MarginCall Default with
//                  the CBTC allocation's execute-transfer context; checks that lender A
//                  now holds the CBTC (HoldingV1) and the allocation is gone.
//
// Each Vercel build starts from the uploaded files, so PHASE=default works from the
// ledger alone: it finds lender A's open MarginCall on CBTC whose trade carries this
// script's marker terms (principal 51.25, 2 days; no other script uses them). If
// docs/evidence/cbtc-default-devnet.json is present (copied back from the deployed
// /evidence/), the open phase's steps are kept and the default's are appended.
//
//   PHASE=open node scripts/cbtc-default.mjs          (DevNet credentials, via scripts/devnet-ci.mjs)
//   PHASE=default node scripts/cbtc-default.mjs
//   DRY_RUN=1 PHASE=open|default node scripts/cbtc-default.mjs   (sizing check, registry call, no ledger)
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { PARTIES as p, LEDGER, api, submit, create, exercise, created, templateId } from '../lib/ledger.mjs';
import { allocationFactory, allocationContext, disclosed } from '../lib/registry.mjs';

const PHASE = process.env.PHASE;
const ADMIN = process.env.CBTC_ADMIN ?? 'cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff';
const CBTC = { admin: ADMIN, id: 'CBTC' };
const QTY = '0.001';
// Marker terms: how PHASE=default recognises this script's trade on the ledger.
const PRINCIPAL = '51.25', TERM_DAYS = 2, HAIRCUT = '0.10', RATE = '600';
const MARK = process.env.MARK ?? '62000';               // at award: 0.001 x 62,000 x 0.9 = 55.80 >= 51.25
const STRESS_MARK = process.env.STRESS_MARK ?? '52000'; // scenario: 0.001 x 52,000 x 0.9 = 46.80 < 51.25
const FILE = 'docs/evidence/cbtc-default-devnet.json';
const HOLDING = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';
const ALLOCATION = '#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation';
const FACTORY = '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory';
const meta = { values: {} };
const at = (ms) => new Date(Date.now() + ms).toISOString();
const H = 3600e3, D = 24 * H, MIN = 60e3;
const short = (x) => String(x ?? '').split('::')[0];

if (!['open', 'default'].includes(PHASE)) { console.error('✗ set PHASE=open or PHASE=default'); process.exit(2); }

// The contract's coverage test (Talang.daml lendable), for the sizing check only.
const covers = (price) => Number(QTY) * Number(price) * (1 - Number(HAIRCUT)) >= Number(PRINCIPAL);
if (!covers(MARK) || covers(STRESS_MARK)) {
  console.error(`✗ sizing: ${QTY} CBTC must cover ${PRINCIPAL} at mark ${MARK} and fall short at stress mark ${STRESS_MARK}`);
  process.exit(2);
}

// PHASE=open starts a fresh file; PHASE=default appends to the open phase's, if present.
const ev = PHASE === 'default' && existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;
const log = ev?.steps ?? [];
const step = (label, tx, extra = {}) => {
  const e = { phase: PHASE, step: label, updateId: tx?.transaction?.updateId, offset: tx?.transaction?.offset, ...extra };
  log.push(e); console.log(`✓ ${label}${e.offset != null ? `  (offset ${e.offset})` : ''}`);
};
const save = (fields) => {
  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync(FILE, JSON.stringify({ ledger: LEDGER, registry: `DA Utility registry, admin ${ADMIN}, instrument CBTC`,
    cash: 'desk USDC (Talang Holding/Escrow)', marker: { principal: PRINCIPAL, termDays: TERM_DAYS },
    scenario: `stress mark ${STRESS_MARK} USDC per CBTC published by the agent party to trigger the call; a scenario, not a market price`,
    ...ev, ...fields, steps: log }, null, 2) + '\n');
  console.log(`\nevidence written to ${FILE}`);
};

// ponytail: views/active copied from cbtc-rail.mjs and token-repo.mjs (both top-level scripts);
// move them into lib/ if a fourth script needs them.
async function views(party, interfaceId) {
  const off = (await api('/v2/state/ledger-end')).data?.offset;
  const r = await api('/v2/state/active-contracts', { method: 'POST', json: {
    eventFormat: { verbose: true, filtersByParty: { [party]: { cumulative: [{ identifierFilter: { InterfaceFilter: { value: {
      interfaceId, includeInterfaceView: true, includeCreatedEventBlob: false } } } }] } } }, activeAtOffset: off } });
  if (!Array.isArray(r.data)) throw new Error(`active-contracts ${interfaceId}: ${JSON.stringify(r.data).slice(0, 1500)}`);
  return r.data.map((x) => x.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean)
    .map((e) => ({ cid: e.contractId, templateId: e.templateId, view: e.interfaceViews?.find((v) => v.viewValue)?.viewValue }));
}
// Active Talang contracts of one template that `party` sees, with their arguments.
async function active(party, tpl) {
  const off = (await api('/v2/state/ledger-end')).data?.offset;
  const r = await api('/v2/state/active-contracts', { method: 'POST', json: {
    eventFormat: { verbose: true, filtersByParty: { [party]: { cumulative: [{ identifierFilter: { TemplateFilter: { value: {
      templateId: templateId(tpl), includeCreatedEventBlob: false } } } }] } } }, activeAtOffset: off } });
  if (!Array.isArray(r.data)) throw new Error(`active-contracts ${tpl}: ${JSON.stringify(r.data).slice(0, 1500)}`);
  return r.data.map((x) => x.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean)
    .map((e) => ({ cid: e.contractId, arg: e.createArgument }));
}
const sameInstrument = (i) => i?.admin === CBTC.admin && i?.id === CBTC.id;
const cbtcOf = async (owner) => (await views(owner, HOLDING))
  .filter((h) => h.view?.owner === owner && sameInstrument(h.view.instrumentId) && h.view.lock == null);
const sum = (hs) => hs.reduce((s, h) => s + Number(h.view.amount), 0);

// PHASE=default: lender A's MarginCalls on CBTC whose trade has the marker terms,
// each with the trade and its CBTC allocations.
async function findCalls() {
  const trades = new Map((await active(p.lenderA, 'RepoTrade')).map((t) => [t.cid, t.arg]));
  return (await active(p.lenderA, 'MarginCall'))
    .filter((c) => c.arg.lender === p.lenderA && c.arg.borrower === p.borrower && c.arg.instrument === 'CBTC' && c.arg.issuer === ADMIN)
    .map((c) => ({ ...c, trade: trades.get(c.arg.tradeCid) }))
    .filter((c) => c.trade && Number(c.trade.terms.principal) === Number(PRINCIPAL) && Number(c.trade.terms.termDays) === TERM_DAYS)
    .map((c) => ({ ...c, allocs: c.trade.collateral.filter((l) => l.tag === 'Allocated').map((l) => l.value.allocCid) }))
    .filter((c) => c.allocs.length);
}

if (process.env.DRY_RUN) {
  console.log(`✓ sizing: ${QTY} CBTC covers ${PRINCIPAL} USDC at ${MARK}, falls short at stress mark ${STRESS_MARK}`);
  if (PHASE === 'open') {
    const respondBy = at(2 * H + 2 * MIN);
    console.log(`  would call margin with respondBy ${respondBy}; PHASE=default after that`);
    try { await allocationFactory(ADMIN, { expectedAdmin: ADMIN, requestedAt: at(-MIN), inputHoldingCids: [], extraArgs: { context: { values: {} }, meta },
      allocation: { settlement: { executor: p.borrower, settlementRef: { id: 'talang-dry', cid: null }, requestedAt: at(-MIN), allocateBefore: at(H),
        settleBefore: at((TERM_DAYS + 4) * D), meta }, transferLegId: 'collateral', transferLeg: { sender: p.borrower, receiver: p.lenderA, amount: QTY, instrumentId: CBTC, meta } } });
    console.log('✓ registry factory answers'); } catch (e) { console.log('  registry answers (no holdings):', e.message); }
  } else {
    console.log(`  evidence file: ${ev ? `marginCall ${ev.marginCall?.slice(0, 16)}…, respondBy ${ev.respondBy}` : 'absent; the margin call is found on the ledger'}`);
    if (ev?.allocationCid) {
      try { const c = await allocationContext(ADMIN, ev.allocationCid, 'execute-transfer');
        console.log(`✓ execute-transfer context: ${Object.keys(c.choiceContextData?.values ?? {}).join(', ') || 'no values'}; disclosed ${c.disclosedContracts.map((d) => d.templateId.split(':').slice(1).join(':')).join(', ')}`);
      } catch (e) { console.log(`  execute-transfer context: ${e.message}`); }
    }
  }
  process.exit(0);
}

try {
  if (PHASE === 'open') {
    // 1. The borrower's CBTC (HoldingV1), allocated to lender A through the registry's factory.
    const holdings = (await cbtcOf(p.borrower)).sort((a, b) => Number(b.view.amount) - Number(a.view.amount));
    if (sum(holdings) < Number(QTY)) throw new Error(`borrower holds ${sum(holdings)} unlocked CBTC, needs ${QTY}: fund it from the BitSafe faucet`);
    const inputs = [];
    for (let s = 0, i = 0; s < Number(QTY); i++) { inputs.push(holdings[i].cid); s += Number(holdings[i].view.amount); }
    step(`borrower holds ${sum(holdings)} CBTC (HoldingV1)`, null, { borrowerCBTC: sum(holdings) });
    const ref = `talang-cbtc-default-${Date.now().toString(36)}`;
    const requestedAt = at(-MIN);   // registries refuse a request time in the future
    const args = { expectedAdmin: ADMIN, requestedAt, inputHoldingCids: inputs, extraArgs: { context: { values: {} }, meta },
      // settleBefore past maturity + the 3-day claim window (Open checks it).
      allocation: { settlement: { executor: p.borrower, settlementRef: { id: ref, cid: null }, requestedAt, allocateBefore: at(H),
        settleBefore: at((TERM_DAYS + 4) * D), meta },
      transferLegId: 'collateral', transferLeg: { sender: p.borrower, receiver: p.lenderA, amount: QTY, instrumentId: CBTC, meta } } };
    const fac = await allocationFactory(ADMIN, args);
    const allocTx = await submit(p.borrower, { ExerciseCommand: { templateId: FACTORY, contractId: fac.factoryId, choice: 'AllocationFactory_Allocate',
      choiceArgument: { ...args, extraArgs: { context: fac.choiceContext.choiceContextData, meta } } } },
    [], { disclosedContracts: disclosed(fac.choiceContext.disclosedContracts) });
    let alloc;
    for (let i = 0; i < 20 && !alloc; i++) {
      alloc = (await views(p.borrower, ALLOCATION)).find((a) => a.view?.allocation?.settlement?.settlementRef?.id === ref);
      if (!alloc) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!alloc) throw new Error(`no CBTC allocation with ref ${ref} after 60 s (update ${allocTx?.transaction?.updateId})`);
    step(`${QTY} CBTC allocated borrower -> lender A through the registry AllocationFactory`, allocTx,
      { allocationCid: alloc.cid, allocationTemplate: alloc.templateId, factoryId: fac.factoryId });

    // 2. RFQ with the marker terms, desk USDC quote, award at the market-level mark.
    const mark = created(await submit(p.agent, create('Mark', { agent: p.agent, instrument: 'CBTC', price: MARK,
      asOf: new Date().toISOString(), audience: [p.borrower, p.lenderA] })), 'Mark');
    const rfqTx = await submit(p.borrower, create('RepoRFQ', { borrower: p.borrower, regulator: p.regulator, agent: p.agent,
      lenders: [p.lenderA], deadline: at(D), venue: null,
      terms: { cashIssuer: p.cashIssuer, cashInstrument: 'USDC', principal: PRINCIPAL, collateralIssuer: ADMIN,
        collateralInstrument: 'CBTC', collateralQty: QTY, termDays: String(TERM_DAYS) } }));
    const rfq = created(rfqTx, 'RepoRFQ');
    step(`RepoRFQ: ${PRINCIPAL} USDC against ${QTY} CBTC, ${TERM_DAYS} days (marker terms)`, rfqTx);
    const cash = created(await submit(p.cashIssuer, create('Holding', { issuer: p.cashIssuer, owner: p.lenderA, instrument: 'USDC', amount: PRINCIPAL })), 'Holding');
    const quoteTx = await submit(p.lenderA, exercise('RepoRFQ', rfq, 'SubmitQuote', { lender: p.lenderA, rateBps: RATE, haircut: HAIRCUT, cashCid: cash }));
    step('sealed quote, principal escrowed in desk USDC', quoteTx);
    // 1.2.0 refuses the consuming award and adds the sealed one; 1.1.0 (vetted on DevNet) has only the former.
    const awardArgs = { winner: created(quoteTx, 'RepoQuote'), losers: [], collateralAlloc: alloc.cid, markCid: mark, contexts: [] };
    const awardTx = await submit(p.borrower, exercise('RepoRFQ', rfq, 'AwardSealedWithTokenCollateral', awardArgs))
      .catch((sealed) => submit(p.borrower, exercise('RepoRFQ', rfq, 'AwardWithTokenCollateral', awardArgs))
        .catch((e) => { throw new Error(`award refused. sealed: ${sealed.message.slice(0, 600)} | consuming: ${e.message.slice(0, 600)}`); }));
    const trade = created(awardTx, 'RepoTrade');
    step(`award at mark ${MARK}: USDC to the borrower, CBTC allocation held as collateral`, awardTx, { trade });

    // 3. Stress scenario: the agent marks CBTC down; the pledge no longer covers; lender A calls.
    const stressTx = await submit(p.agent, create('Mark', { agent: p.agent, instrument: 'CBTC', price: STRESS_MARK,
      asOf: new Date().toISOString(), audience: [p.borrower, p.lenderA] }));
    step(`STRESS SCENARIO mark: ${STRESS_MARK} USDC per CBTC (not a market price), published by the agent`, stressTx);
    const respondBy = at(2 * H + 2 * MIN);
    const callTx = await submit(p.lenderA, exercise('RepoTrade', trade, 'CallMargin', { markCid: created(stressTx, 'Mark'), respondBy }));
    const marginCall = created(callTx, 'MarginCall');
    step(`margin call by lender A, borrower to respond by ${respondBy}; run PHASE=default after that`, callTx, { marginCall, respondBy });
    save({ ranAt: new Date().toISOString(), trade, marginCall, allocationCid: alloc.cid, respondBy });
  } else {
    // 1. The open call: the evidence file's if still active, else the newest due one on the ledger.
    const calls = await findCalls();
    if (!calls.length) throw new Error(`no open MarginCall by lender A on CBTC with marker terms (${PRINCIPAL} USDC, ${TERM_DAYS} days): run PHASE=open first`);
    const due = calls.filter((c) => Date.parse(c.arg.respondBy) + 5e3 < Date.now())
      .sort((a, b) => Date.parse(b.arg.respondBy) - Date.parse(a.arg.respondBy));
    if (!due.length) {
      const next = calls.map((c) => c.arg.respondBy).sort()[0];
      console.error(`✗ refused: the borrower still has time to respond. respondBy ${next}, ${Math.ceil((Date.parse(next) - Date.now()) / MIN)} min from now; run PHASE=default after that.`);
      process.exit(3);
    }
    const call = due.find((c) => c.cid === ev?.marginCall) ?? due[0], alloc = call.allocs[0];
    if (Date.now() - Date.parse(call.arg.respondBy) > D)
      console.log(`  note: more than a day past respondBy; talang-repo 1.2.0 refuses that (defaultWindow), 1.1.0 does not`);
    step(`open margin call found on the ledger: respondBy ${call.arg.respondBy} has passed`, null,
      { marginCall: call.cid, trade: call.arg.tradeCid, allocationCid: alloc, unitsDue: call.arg.unitsDue, price: call.arg.price });

    // 2. Default with the registry's execute-transfer context for every CBTC allocation pledged.
    const lenderBefore = sum(await cbtcOf(p.lenderA));
    const ctx = await Promise.all(call.allocs.map(async (a) => [a, await allocationContext(ADMIN, a, 'execute-transfer')]));
    const seen = new Map();
    for (const [, c] of ctx) for (const d of disclosed(c.disclosedContracts)) seen.set(d.contractId, d);
    const defTx = await submit(p.lenderA, exercise('MarginCall', call.cid, 'Default',
      { contexts: ctx.map(([a, c]) => ({ _1: a, _2: { context: c.choiceContextData, meta } })) }),
    [], { disclosedContracts: [...seen.values()] });

    // 3. Lender A holds the CBTC; the allocation is gone.
    const lenderAfter = sum(await cbtcOf(p.lenderA));
    const left = (await views(p.borrower, ALLOCATION)).filter((a) => call.allocs.includes(a.cid));
    if (left.length) throw new Error(`default committed but ${left.length} CBTC allocation(s) still active`);
    if (lenderAfter - lenderBefore < Number(QTY) - 1e-9) throw new Error(`default committed but lender A's CBTC went ${lenderBefore} -> ${lenderAfter}`);
    step(`default: ${QTY} CBTC executed to lender A through the registry (execute-transfer), allocation gone`, defTx,
      { lenderCBTCBefore: lenderBefore, lenderCBTCAfter: lenderAfter, disclosedContracts: [...seen.values()].map((d) => d.templateId) });
    save({ defaultedAt: new Date().toISOString(), marginCall: call.cid, trade: call.arg.tradeCid, allocationCid: alloc, respondBy: call.arg.respondBy });
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  console.error('steps done:', JSON.stringify(log.filter((s) => s.phase === PHASE)));
  process.exit(1);
}
