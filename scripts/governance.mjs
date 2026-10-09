// BitSafe Decentralization Manager on a live ledger: a 2-of-3 valuation committee
// publishes the marks a repo runs on, through BitSafe's own GovernanceRules
// (governance-core-v1, uploaded from dars/ unchanged). Every step's update id and
// offset is written to docs/evidence/ so a judge can look each one up.
//
//   ENV_FILE=.env.local node scripts/governance.mjs     local sandbox
//   node scripts/governance.mjs                         the ledger in .env.noders
//
// On one participant the committee and its members share a node, so this proves
// the threshold logic and the authority flow, not the hosting topology; the same
// script against DecMan LocalNet (three participants, the committee hosted on all
// three) proves both. See docs/bitsafe.md.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PARTIES as p, LEDGER, USER, api, submit, create, exercise, created } from '../lib/ledger.mjs';

const GOV = '#governance-core-v1:Governance.Rules:GovernanceRules';
const log = [];
const step = (label, tx, extra = {}) => {
  const e = { step: label, updateId: tx?.transaction?.updateId, offset: tx?.transaction?.offset, ...extra };
  log.push(e); console.log(`✓ ${label}${e.offset != null ? `  (offset ${e.offset})` : ''}`);
};
const refused = (label, err) => {
  const reason = (err.message.match(/AssertionFailed: ([^"\\]+)/) ?? err.message.match(/"cause":"([^"]+)/))?.[1] ?? err.message.slice(0, 160);
  log.push({ step: label, refused: true, reason }); console.log(`✓ ${label}: refused by the ledger (${reason})`);
};

async function allocate(hint) {
  const r = await api('/v2/parties', { method: 'POST', json: { partyIdHint: `${hint}-${Date.now().toString(36)}`, identityProviderId: '' } });
  if (!r.ok) throw new Error(`allocate ${hint}: ${JSON.stringify(r.data).slice(0, 200)}`);
  const party = r.data.partyDetails.party;
  const g = await api(`/v2/users/${USER}/rights`, { method: 'POST', json: { userId: USER, identityProviderId: '',
    rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }] } });
  if (!g.ok) throw new Error(`grant ${hint}: ${JSON.stringify(g.data).slice(0, 200)}`);
  return party;
}

// 1. BitSafe's governance package, as released.
const up = await api('/v2/packages', { method: 'POST', bytes: readFileSync('dars/governance-core-v1-0.1.0.dar') });
// A shared participant may refuse uploads to app users (403) while the package is
// already vetted there; the first command against it is the real check.
if (!up.ok && up.status !== 403) throw new Error('upload governance-core-v1: ' + JSON.stringify(up.data).slice(0, 200));
step(up.ok ? 'uploaded BitSafe governance-core-v1-0.1.0.dar' : 'governance-core-v1-0.1.0 upload refused (403): using the copy vetted on the participant', null);

// 2. The committee and its three pricing members. On DecMan LocalNet or DevNet the
//    committee is the decentralized party DecMan created, with the GovernanceRules
//    DecMan created for it: pass COMMITTEE_PARTY, COMMITTEE_MEMBERS (comma-separated,
//    3 of them) and COMMITTEE_RULES. Without them the script stands up its own.
let committee, pricerA, pricerB, pricerC, rules;
if (process.env.COMMITTEE_PARTY && process.env.COMMITTEE_RULES) {
  committee = process.env.COMMITTEE_PARTY;
  [pricerA, pricerB, pricerC] = process.env.COMMITTEE_MEMBERS.split(',').map((x) => x.trim());
  rules = process.env.COMMITTEE_RULES;
  step('using the DecMan decentralized party and its GovernanceRules', null, { committee, members: [pricerA, pricerB, pricerC], rules });
} else {
  // Parties made beforehand (e.g. in the node operator's console) when the app user
  // may not allocate: COMMITTEE_PARTY and COMMITTEE_MEMBERS without COMMITTEE_RULES.
  if (process.env.COMMITTEE_PARTY) {
    committee = process.env.COMMITTEE_PARTY;
    [pricerA, pricerB, pricerC] = process.env.COMMITTEE_MEMBERS.split(',').map((x) => x.trim());
  } else {
    committee = await allocate('talang-valuation-committee');
    [pricerA, pricerB, pricerC] = [await allocate('talang-pricerA'), await allocate('talang-pricerB'), await allocate('talang-pricerC')];
  }
  const rulesTx = await submit(committee, { CreateCommand: { templateId: GOV, createArguments: {
    governanceParty: committee, members: { map: [[pricerA, {}], [pricerB, {}], [pricerC, {}]] }, threshold: '2',
    actionConfirmationTimeout: { microseconds: String(3600e6) }, additionalProposers: null } } });
  rules = rulesTx.transaction.events.map((e) => e.CreatedEvent).find(Boolean).contractId;
  step('GovernanceRules: committee of 3 pricers, threshold 2', rulesTx, { committee, members: [pricerA, pricerB, pricerC] });
}

const audience = [p.borrower, p.lenderA, p.lenderB, p.lenderC].filter(Boolean);
async function propose(proposer, instrument, price) {
  const tx = await submit(proposer, create('MarkProposal', { committee, proposer, instrument, price: String(price),
    asOf: new Date().toISOString(), audience, source: 'pricing feed' }));
  return created(tx, 'MarkProposal');
}
const confirm = async (member, action) => {
  const tx = await submit(member, { ExerciseCommand: { templateId: GOV, contractId: rules, choice: 'GovernanceRules_ConfirmAction',
    choiceArgument: { confirmer: member, actionProposalCid: action } } }, [committee]);
  return tx.transaction.events.map((e) => e.CreatedEvent).find(Boolean).contractId;
};
const execute = (executor, action, confirmations) => submit(executor, { ExerciseCommand: { templateId: GOV, contractId: rules,
  choice: 'GovernanceRules_ExecuteConfirmedAction', choiceArgument: { executor, actionProposalCid: action, confirmations } } }, [committee]);

// 3. One pricer alone cannot publish.
const lone = await propose(pricerA, 'UST10Y', 98000);
const c1 = await confirm(pricerA, lone);
try { await execute(pricerA, lone, [c1]); throw new Error('a single confirmation executed'); }
catch (e) { if (/single confirmation executed/.test(e.message)) throw e; refused('MarkProposal UST10Y 98,000 with 1 of 3 confirmations', e); }

// 4. Two of three publish, as the committee.
const markProp = await propose(pricerB, 'UST10Y', 98000);
const cs = [await confirm(pricerB, markProp), await confirm(pricerC, markProp)];
const exTx = await execute(pricerB, markProp, cs);
const mark = created(exTx, 'Mark');
step('MarkProposal UST10Y 98,000 executed with 2 of 3: Mark signed by the committee', exTx, { mark });

// 5. A repo opens on the governed mark.
const terms = { cashIssuer: p.cashIssuer, cashInstrument: 'USDC', principal: '9500000', collateralIssuer: p.bondIssuer,
  collateralInstrument: 'UST10Y', collateralQty: '100', termDays: '30' };
const rfq = created(await submit(p.borrower, create('RepoRFQ', { borrower: p.borrower, regulator: p.regulator, agent: committee,
  lenders: [p.lenderA], terms, deadline: null, venue: null })), 'RepoRFQ');
const cash = created(await submit(p.cashIssuer, create('Holding', { issuer: p.cashIssuer, owner: p.lenderA, instrument: 'USDC', amount: '9500000' })), 'Holding');
const q = created(await submit(p.lenderA, exercise('RepoRFQ', rfq, 'SubmitQuote', { lender: p.lenderA, rateBps: '530', haircut: '0.02', cashCid: cash })), 'RepoQuote');
const col = created(await submit(p.bondIssuer, create('Holding', { issuer: p.bondIssuer, owner: p.borrower, instrument: 'UST10Y', amount: '100' })), 'Holding');
const openTx = await submit(p.borrower, exercise('RepoRFQ', rfq, 'Award', { winner: q, losers: [], collateralCid: col, markCid: mark, contexts: [] }));
const trade = created(openTx, 'RepoTrade');
step('repo opened on the committee mark (agent = the decentralized party)', openTx, { trade });

// 6. A single pricer's own mark cannot drive a margin call, however low.
const rogue = created(await submit(pricerA, create('Mark', { agent: pricerA, instrument: 'UST10Y', price: '50000',
  asOf: new Date().toISOString(), audience })), 'Mark');
try {
  await submit(p.lenderA, exercise('RepoTrade', trade, 'CallMargin', { markCid: rogue, respondBy: new Date(Date.now() + 864e5).toISOString() }));
  throw new Error('a rogue mark drove a margin call');
} catch (e) { if (/rogue mark drove/.test(e.message)) throw e; refused('margin call on one pricer\'s own mark at 50,000', e); }

// 7. A governed markdown can.
const downProp = await propose(pricerC, 'UST10Y', 92000);
const downTx = await execute(pricerC, downProp, [await confirm(pricerA, downProp), await confirm(pricerC, downProp)]);
const down = created(downTx, 'Mark');
step('governed markdown UST10Y 92,000 executed with 2 of 3', downTx, { mark: down });
const callTx = await submit(p.lenderA, exercise('RepoTrade', trade, 'CallMargin', { markCid: down, respondBy: new Date(Date.now() + 864e5).toISOString() }));
step('margin call issued on the governed mark', callTx, { marginCall: created(callTx, 'MarginCall') });

mkdirSync('docs/evidence', { recursive: true });
const where = process.env.EVIDENCE_TAG ?? (/localhost|127\.0\.0\.1/.test(LEDGER) ? 'local-sandbox' : 'devnet');
const file = `docs/evidence/bitsafe-governed-marks-${where}.json`;
const ledgers = { devnet: LEDGER, 'local-sandbox': 'local Canton sandbox 3.4.11',
  localnet: 'DecMan LocalNet: 3 Canton 3.5.8 participants, committee hosted on all three (threshold 2)' };
writeFileSync(file, JSON.stringify({ ledger: ledgers[where] ?? LEDGER, ranAt: new Date().toISOString(),
  packages: ['talang-repo-1.0.0', 'governance-core-v1-0.1.0 (BitSafe, unmodified)', 'governance-action-v1-0.1.0 (BitSafe, unmodified)'],
  steps: log }, null, 2) + '\n');
console.log(`\nevidence written to ${file}`);
