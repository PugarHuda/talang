// One repo on a live participant where either leg, or both, is any CIP-0056
// instrument, chosen by env alone. A leg left unset uses the desk's own escrowed
// Holding (USDC cash from cashIssuer, UST collateral from bondIssuer), as today.
//
//   CASH_ADMIN, CASH_ID, CASH_REGISTRY_URL                    cash leg (lender funds the quote with an allocation)
//   COLLATERAL_ADMIN, COLLATERAL_ID, COLLATERAL_REGISTRY_URL  collateral leg (borrower pledges an allocation)
//   *_REGISTRY_URL is the registry's base, the part before /registry/...; it defaults
//   to the DA Utility DevNet registrar of *_ADMIN (lib/registry.mjs utilityBase).
//   PRINCIPAL (50), COLLATERAL_QTY, MARK (agent's price of one collateral unit in cash units)
//   CC_TAP=<amount>  on DevNet, mint Canton Coin to a party that runs short (AmuletRules_DevNet_Tap)
//   PRESET=cc-cash | cc-collateral | cbtc-collateral | usdcx-testnet-cash   (comma-separated; env wins)
//
// Flow: accept pending transfer offers for the configured instruments, lender funds a
// sealed quote (SubmitTokenQuote with an allocation, or SubmitQuote with desk cash),
// borrower pledges (AwardWithTokenCollateral with an allocation, or Award with desk
// collateral), award executes the cash allocation with the registry's execute-transfer
// context, repurchase pays back (token cash: NoticeRepurchase -> borrower allocates
// what is due -> SettleRepurchase with execute-transfer; desk cash: Repurchase) and
// the collateral allocation is cancelled with the registry's cancel context.
//
//   PRESET=cc-cash node scripts/token-repo.mjs           (DevNet credentials, via scripts/devnet-ci.mjs)
//   PRESET=cc-cash DRY_RUN=1 node scripts/token-repo.mjs (no ledger: checks the registries answer)
import { writeFileSync, mkdirSync } from 'node:fs';
import { PARTIES as p, LEDGER, api, submit, create, exercise, created } from '../lib/ledger.mjs';
import { registry, utilityBase, disclosed } from '../lib/registry.mjs';

const DSO_DEVNET = 'DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a';
const SCAN_DEVNET = 'https://scan.sv-1.dev.global.canton.network.sync.global';
const CBTC_DEVNET = 'cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff';
const USDCX_TESTNET = 'decentralized-usdc-interchain-rep::122049e2af8a725bd19759320fc83c638e7718973eac189d8f201309c512d1ffec61';
const PRESETS = {
  'cc-cash': { CASH_ADMIN: DSO_DEVNET, CASH_ID: 'Amulet', CASH_REGISTRY_URL: SCAN_DEVNET, CC_TAP: '200' },
  'cc-collateral': { COLLATERAL_ADMIN: DSO_DEVNET, COLLATERAL_ID: 'Amulet', COLLATERAL_REGISTRY_URL: SCAN_DEVNET,
    COLLATERAL_QTY: '500', MARK: '0.15', CC_TAP: '200' },
  'cbtc-collateral': { COLLATERAL_ADMIN: CBTC_DEVNET, COLLATERAL_ID: 'CBTC', COLLATERAL_QTY: '0.001', MARK: '62000' },
  // Docs-only values: TestNet participant, USDCx from the xReserve Sepolia bridge.
  'usdcx-testnet-cash': { CASH_ADMIN: USDCX_TESTNET, CASH_ID: 'USDCx',
    CASH_REGISTRY_URL: utilityBase(USDCX_TESTNET, 'https://api.utilities.digitalasset-staging.com') },
};
const presetNames = (process.env.PRESET ?? '').split(',').map((s) => s.trim()).filter(Boolean);
for (const n of presetNames) if (!PRESETS[n]) { console.error(`✗ unknown PRESET ${n}; known: ${Object.keys(PRESETS).join(', ')}`); process.exit(2); }
const preset = Object.assign({}, ...presetNames.map((n) => PRESETS[n]));
const cfg = (k, d) => process.env[k] ?? preset[k] ?? d;

const leg = (side) => {
  const admin = cfg(`${side}_ADMIN`), id = cfg(`${side}_ID`);
  if (!admin && !id) return null;
  if (!admin || !id) { console.error(`✗ set both ${side}_ADMIN and ${side}_ID, or neither`); process.exit(2); }
  const url = cfg(`${side}_REGISTRY_URL`, utilityBase(admin));
  return { admin, id, url, reg: registry(url), instrumentId: { admin, id } };
};
const CASH = leg('CASH'), COLL = leg('COLLATERAL');
const PRINCIPAL = cfg('PRINCIPAL', '50');
const QTY = cfg('COLLATERAL_QTY', '1');
const MARK = cfg('MARK', '100');
const TAP = cfg('CC_TAP');
const TERM_DAYS = 1, HAIRCUT = '0.10', RATE = '600';
const cashName = CASH?.id ?? 'USDC', collName = COLL?.id ?? 'UST';

const HOLDING = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding';
const TRANSFER = '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction';
const ALLOCATION = '#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation';
const REQ = '#splice-api-token-allocation-request-v1:Splice.Api.Token.AllocationRequestV1:AllocationRequest';
const FACTORY = '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory';
const meta = { values: {} };
const at = (ms) => new Date(Date.now() + ms).toISOString();
const H = 3600e3, D = 24 * H;
const short = (x) => String(x ?? '').split('::')[0];
const isAmulet = (l) => l && l.id === 'Amulet' && l.admin.startsWith('DSO::');

const log = [];
const step = (label, tx, extra = {}) => {
  const e = { step: label, updateId: tx?.transaction?.updateId, offset: tx?.transaction?.offset, ...extra };
  log.push(e); console.log(`✓ ${label}${e.offset != null ? `  (offset ${e.offset})` : ''}`);
};

// AllocationFactory_Allocate arguments; the borrower always executes (Talang.daml checkAllocation).
const allocArgs = (l, sender, receiver, amount, settleBefore, ref, legId, inputHoldingCids) => {
  const requestedAt = at(-60e3);   // registries refuse a request time in the future
  const allocateBefore = new Date(Math.min(Date.now() + H, Date.parse(settleBefore))).toISOString();
  return { expectedAdmin: l.admin, requestedAt, inputHoldingCids, extraArgs: { context: { values: {} }, meta },
    allocation: { settlement: { executor: p.borrower, settlementRef: { id: ref, cid: null }, requestedAt, allocateBefore, settleBefore, meta },
      transferLegId: legId, transferLeg: { sender, receiver, amount: String(amount), instrumentId: l.instrumentId, meta } } };
};

if (process.env.DRY_RUN) {
  console.log(`cash: ${CASH ? `${CASH.id}@${CASH.admin} via ${CASH.url}` : 'desk USDC (escrowed Holding)'}`);
  console.log(`collateral: ${COLL ? `${COLL.id}@${COLL.admin} via ${COLL.url}` : 'desk UST (escrowed Holding)'}`);
  console.log(`principal ${PRINCIPAL} ${cashName} against ${QTY} ${collName} at mark ${MARK}, haircut ${HAIRCUT}`);
  let bad = 0;
  for (const [side, l] of [['cash', CASH], ['collateral', COLL]].filter(([, l]) => l)) {
    try {
      const info = await l.reg.info();
      if (info.adminId !== l.admin) throw new Error(`registry admin is ${info.adminId}, not ${l.admin}`);
      const ins = await l.reg.instrument(l.id);
      console.log(`✓ ${side}: registry admin matches, instrument ${ins.id} (${ins.symbol}, ${ins.decimals} decimals, paused=${ins.paused})`);
      const fac = await l.reg.allocationFactory(allocArgs(l, p.borrower, p.lenderA, '1', at(2 * H), 'talang-dry', side, []))
        .catch((e) => ({ error: e.message }));
      console.log(fac.factoryId ? `✓ ${side}: allocation factory ${fac.factoryId.slice(0, 16)}…, disclosed ${fac.choiceContext.disclosedContracts.map((d) => d.templateId.split(':').slice(1).join(':')).join(', ')}`
        : `  ${side}: allocation factory answers (no holdings, dummy parties): ${fac.error}`);
    } catch (e) { bad++; console.error(`✗ ${side}: ${e.message}`); }
  }
  process.exit(bad ? 1 : 0);
}

// Interface views of what `party` sees through one Splice interface.
async function views(party, interfaceId) {
  const off = (await api('/v2/state/ledger-end')).data?.offset;
  const r = await api('/v2/state/active-contracts', { method: 'POST', json: {
    eventFormat: { verbose: true, filtersByParty: { [party]: { cumulative: [{ identifierFilter: { InterfaceFilter: { value: {
      interfaceId, includeInterfaceView: true, includeCreatedEventBlob: false } } } }] } } }, activeAtOffset: off } });
  if (!Array.isArray(r.data)) throw new Error(`active-contracts ${interfaceId}: ${JSON.stringify(r.data).slice(0, 1500)}`);
  return r.data.map((x) => x.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean)
    .map((e) => ({ cid: e.contractId, templateId: e.templateId, view: e.interfaceViews?.find((v) => v.viewValue)?.viewValue }));
}
const same = (l, i) => i?.admin === l.admin && i?.id === l.id;
const unlocked = async (l, owner) => (await views(owner, HOLDING))
  .filter((h) => h.view?.owner === owner && same(l, h.view.instrumentId) && h.view.lock == null)
  .sort((a, b) => Number(b.view.amount) - Number(a.view.amount));
const balance = async (l, owner) => (await unlocked(l, owner)).reduce((s, h) => s + Number(h.view.amount), 0);

// Contexts for a Talang choice: [(allocation, extraArgs)] plus every disclosed contract, once.
function contexts(pairs) {
  const seen = new Map();
  for (const [, c] of pairs) for (const d of disclosed(c.disclosedContracts)) seen.set(d.contractId, d);
  return { contexts: pairs.map(([cid, c]) => ({ _1: cid, _2: { context: c.choiceContextData, meta } })), disclosedContracts: [...seen.values()] };
}

// DevNet only: mint Canton Coin. The registry's factory context carries the current
// AmuletRules and OpenMiningRound as disclosed contracts, which is all the tap needs.
// ponytail: borrows the allocation-factory answer for those two contracts, since Scan's
// /api/scan/v0/amulet-rules is IP-allowlisted; switch if a public endpoint appears.
async function tap(l, party, amount) {
  const fac = await l.reg.allocationFactory(allocArgs(l, party, party, '1', at(2 * H), 'talang-tap', 'tap', []));
  const ds = fac.choiceContext.disclosedContracts;
  const rules = ds.find((d) => d.templateId.endsWith(':Splice.AmuletRules:AmuletRules'));
  const round = ds.find((d) => d.templateId.endsWith(':Splice.Round:OpenMiningRound'));
  if (!rules || !round) throw new Error(`no AmuletRules/OpenMiningRound in the registry context: ${ds.map((d) => d.templateId).join(', ')}`);
  const tx = await submit(party, { ExerciseCommand: { templateId: rules.templateId, contractId: rules.contractId, choice: 'AmuletRules_DevNet_Tap',
    choiceArgument: { receiver: party, amount: String(amount), openRound: round.contractId } } }, [], { disclosedContracts: disclosed([rules, round]) });
  step(`DevNet tap: ${amount} CC to ${short(party)}`, tx);
}

// Accept every transfer offer of `l` waiting on `party`, with the registry's accept context.
async function acceptOffers(l, party) {
  for (const t of (await views(party, TRANSFER)).filter((t) => t.view?.transfer?.receiver === party && same(l, t.view.transfer.instrumentId)
    && t.view.status?.tag === 'TransferPendingReceiverAcceptance')) {
    const c = await l.reg.transferInstructionContext(t.cid, 'accept');
    const tx = await submit(party, { ExerciseCommand: { templateId: TRANSFER, contractId: t.cid, choice: 'TransferInstruction_Accept',
      choiceArgument: { extraArgs: { context: c.choiceContextData, meta } } } }, [], { disclosedContracts: disclosed(c.disclosedContracts) });
    step(`${short(party)} accepted ${t.view.transfer.amount} ${l.id} from ${short(t.view.transfer.sender)}`, tx, { instructionCid: t.cid });
  }
}

// Lock `amount` of `l` from sender to receiver through the registry's AllocationFactory.
async function allocate(l, sender, receiver, amount, settleBefore, legId) {
  const hs = await unlocked(l, sender);
  const total = hs.reduce((s, h) => s + Number(h.view.amount), 0);
  if (total < Number(amount)) throw new Error(`${short(sender)} holds ${total} unlocked ${l.id}, needs ${amount}`);
  // Largest first, with 5% headroom for registries that charge fees from the inputs (Amulet).
  const inputs = [];
  for (let s = 0, i = 0; i < hs.length && i < 20 && s < Number(amount) * 1.05; i++) { inputs.push(hs[i].cid); s += Number(hs[i].view.amount); }
  const ref = `talang-${legId}-${Date.now().toString(36)}`;
  const args = allocArgs(l, sender, receiver, amount, settleBefore, ref, legId, inputs);
  const fac = await l.reg.allocationFactory(args);
  const tx = await submit(sender, { ExerciseCommand: { templateId: FACTORY, contractId: fac.factoryId, choice: 'AllocationFactory_Allocate',
    choiceArgument: { ...args, extraArgs: { context: fac.choiceContext.choiceContextData, meta } } } },
  [], { disclosedContracts: disclosed(fac.choiceContext.disclosedContracts) });
  // The factory may complete at once or leave the registrar a step; either way the
  // allocation turns up under its settlement ref.
  for (let i = 0; i < 20; i++) {
    const a = (await views(sender, ALLOCATION)).find((x) => x.view?.allocation?.settlement?.settlementRef?.id === ref);
    if (a) {
      step(`${amount} ${l.id} allocated ${short(sender)} -> ${short(receiver)} (${legId})`, tx,
        { allocationCid: a.cid, allocationTemplate: a.templateId, factoryId: fac.factoryId,
          disclosedContracts: fac.choiceContext.disclosedContracts.map((d) => d.templateId) });
      return a.cid;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`no ${l.id} allocation with ref ${ref} after 60 s (update ${tx?.transaction?.updateId})`);
}

try {
  // 0. Funding: DevNet CC tap if asked, then any pending transfer offers.
  for (const [l, parties] of [[CASH, [p.lenderA, p.borrower]], [COLL, [p.borrower]]]) {
    if (!l) continue;
    for (const party of parties) {
      if (TAP && isAmulet(l) && await balance(l, party) < Number(TAP) / 2) await tap(l, party, TAP);
      await acceptOffers(l, party);
    }
  }
  if (CASH) step(`balances: lender A ${await balance(CASH, p.lenderA)} ${CASH.id}, borrower ${await balance(CASH, p.borrower)} ${CASH.id}`, null);
  if (COLL) step(`balance: borrower ${await balance(COLL, p.borrower)} ${COLL.id}`, null);

  // 1. Request and mark.
  const mark = created(await submit(p.agent, create('Mark', { agent: p.agent, instrument: collName, price: MARK,
    asOf: new Date().toISOString(), audience: [p.borrower, p.lenderA] })), 'Mark');
  const rfqTx = await submit(p.borrower, create('RepoRFQ', { borrower: p.borrower, regulator: p.regulator, agent: p.agent,
    lenders: [p.lenderA], deadline: at(H), venue: null,
    terms: { cashIssuer: CASH?.admin ?? p.cashIssuer, cashInstrument: cashName, principal: PRINCIPAL,
      collateralIssuer: COLL?.admin ?? p.bondIssuer, collateralInstrument: collName, collateralQty: QTY, termDays: String(TERM_DAYS) } }));
  const rfq = created(rfqTx, 'RepoRFQ');
  step(`RepoRFQ: ${PRINCIPAL} ${cashName} against ${QTY} ${collName}, ${TERM_DAYS} day`, rfqTx);

  // 2. Sealed quote: the lender's cash as an allocation to the borrower, live past the RFQ deadline.
  let quoteTx, cashAlloc;
  if (CASH) {
    cashAlloc = await allocate(CASH, p.lenderA, p.borrower, PRINCIPAL, at(2 * H), 'cash');
    quoteTx = await submit(p.lenderA, exercise('RepoRFQ', rfq, 'SubmitTokenQuote', { lender: p.lenderA, rateBps: RATE, haircut: HAIRCUT, allocCid: cashAlloc }));
  } else {
    const cash = created(await submit(p.cashIssuer, create('Holding', { issuer: p.cashIssuer, owner: p.lenderA, instrument: 'USDC', amount: PRINCIPAL })), 'Holding');
    quoteTx = await submit(p.lenderA, exercise('RepoRFQ', rfq, 'SubmitQuote', { lender: p.lenderA, rateBps: RATE, haircut: HAIRCUT, cashCid: cash }));
  }
  step(`sealed quote funded by ${CASH ? `a ${CASH.id} allocation` : 'desk USDC escrow'}`, quoteTx);

  // 3. Award: the cash allocation executes to the borrower (execute-transfer context);
  // the collateral allocation is only checked, so it needs no context yet.
  let collAlloc;
  const awardCtx = contexts(CASH ? [[cashAlloc, await CASH.reg.allocationContext(cashAlloc, 'execute-transfer')]] : []);
  let awardTx;
  if (COLL) {
    collAlloc = await allocate(COLL, p.borrower, p.lenderA, QTY, at((TERM_DAYS + 4) * D), 'collateral');
    awardTx = await submit(p.borrower, exercise('RepoRFQ', rfq, 'AwardWithTokenCollateral',
      { winner: created(quoteTx, 'RepoQuote'), losers: [], collateralAlloc: collAlloc, markCid: mark, contexts: awardCtx.contexts }),
    [], { disclosedContracts: awardCtx.disclosedContracts });
  } else {
    const coll = created(await submit(p.bondIssuer, create('Holding', { issuer: p.bondIssuer, owner: p.borrower, instrument: 'UST', amount: QTY })), 'Holding');
    awardTx = await submit(p.borrower, exercise('RepoRFQ', rfq, 'Award',
      { winner: created(quoteTx, 'RepoQuote'), losers: [], collateralCid: coll, markCid: mark, contexts: awardCtx.contexts }),
    [], { disclosedContracts: awardCtx.disclosedContracts });
  }
  const trade = created(awardTx, 'RepoTrade');
  step(`award: ${cashName} to the borrower, ${collName} held for the lender`, awardTx,
    { trade, ...(CASH ? { borrowerCash: await balance(CASH, p.borrower) } : {}) });

  // 4. Repurchase. The collateral allocation, if any, is cancelled home (cancel context).
  // Fetched just before each submit: Amulet contexts name the current mining round.
  const collCtx = async () => (COLL ? [[collAlloc, await COLL.reg.allocationContext(collAlloc, 'cancel')]] : []);
  let repoTx;
  if (CASH) {
    // Token cash: the notice states what is due today; the borrower allocates exactly that.
    const noticeTx = await submit(p.borrower, exercise('RepoTrade', trade, 'NoticeRepurchase', { settleBefore: at(2 * H) }));
    const notice = created(noticeTx, 'RepurchaseNotice');
    const req = (await views(p.borrower, REQ)).find((x) => x.cid === notice)?.view;
    const due = req?.transferLegs?.repurchase?.amount;
    if (!due) throw new Error(`repurchase notice ${notice} has no repurchase leg in its AllocationRequest view`);
    step(`repurchase notice: ${due} ${cashName} due to lender A`, noticeTx, { due });
    const payAlloc = await allocate(CASH, p.borrower, p.lenderA, due, at(2 * H), 'repurchase');
    const c = contexts([[payAlloc, await CASH.reg.allocationContext(payAlloc, 'execute-transfer')], ...await collCtx()]);
    repoTx = await submit(p.borrower, exercise('RepurchaseNotice', notice, 'SettleRepurchase',
      { lenderAlloc: payAlloc, feeAlloc: null, venueAgreement: null, contexts: c.contexts }), [], { disclosedContracts: c.disclosedContracts });
  } else {
    const pay = created(await submit(p.cashIssuer, create('Holding', { issuer: p.cashIssuer, owner: p.borrower, instrument: 'USDC',
      amount: String(Number(PRINCIPAL) * 1.2) })), 'Holding');
    const c = contexts(await collCtx());
    repoTx = await submit(p.borrower, exercise('RepoTrade', trade, 'Repurchase', { cashCid: pay, contexts: c.contexts }),
      [], { disclosedContracts: c.disclosedContracts });
  }
  if (COLL && (await views(p.borrower, ALLOCATION)).some((a) => a.cid === collAlloc))
    throw new Error('repurchase committed but the collateral allocation is still active');
  step(`repurchase: ${cashName} to the lender, ${collName} home to the borrower`, repoTx, {
    ...(CASH ? { lenderCashAfter: await balance(CASH, p.lenderA) } : {}),
    ...(COLL ? { borrowerCollateralAfter: await balance(COLL, p.borrower) } : {}) });

  const where = /localhost|127\.0\.0\.1/.test(LEDGER) ? 'local-sandbox' : 'devnet';
  const file = `docs/evidence/token-repo-${cashName}-${collName}-${where}.json`.toLowerCase();
  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync(file, JSON.stringify({ ledger: where === 'devnet' ? LEDGER : 'local Canton sandbox', ranAt: new Date().toISOString(),
    preset: presetNames, cash: CASH ? { ...CASH, reg: undefined } : 'desk USDC (Talang Holding/Escrow)',
    collateral: COLL ? { ...COLL, reg: undefined } : 'desk UST (Talang Holding/Escrow)', steps: log }, null, 2) + '\n');
  console.log(`\nevidence written to ${file}`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  console.error('steps done:', JSON.stringify(log));
  process.exit(1);
}
