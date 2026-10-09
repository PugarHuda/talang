// A decentralized price oracle for Talang: a BitSafe 2-of-3 valuation committee
// whose members each read a DIFFERENT live source. A member proposes the price from
// its own exchange; another member confirms only if the proposal is within
// tolerance of what its own exchange says. So "2 of 3" means two independent
// sources agree, and one member with a bad (or manipulated) feed cannot publish.
//
//   ENV_FILE=.env.local node scripts/oracle.mjs
//
// Writes docs/evidence/oracle-<where>.json with every quote, vote and update id.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PARTIES as p, LEDGER, USER, api, submit, create, created } from '../lib/ledger.mjs';
import { BTC_SOURCES, livePrices } from '../lib/prices.mjs';

const GOV = '#governance-core-v1:Governance.Rules:GovernanceRules';
const TOLERANCE = 0.01; // a confirming member's source must be within 1% of the proposal
const log = [];
const note = (e) => { log.push(e); console.log(`${e.ok === false ? '✗' : '✓'} ${e.step}`); };

async function allocate(hint) {
  const r = await api('/v2/parties', { method: 'POST', json: { partyIdHint: `${hint}-${Date.now().toString(36)}`, identityProviderId: '' } });
  if (!r.ok) throw new Error(`allocate ${hint}: ${JSON.stringify(r.data).slice(0, 200)}`);
  const party = r.data.partyDetails.party;
  await api(`/v2/users/${USER}/rights`, { method: 'POST', json: { userId: USER, identityProviderId: '',
    rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }] } });
  return party;
}

const up = await api('/v2/packages', { method: 'POST', bytes: readFileSync('dars/governance-core-v1-0.1.0.dar') });
if (!up.ok) throw new Error('upload governance-core-v1: ' + JSON.stringify(up.data).slice(0, 200));

// One member per exchange.
const committee = await allocate('talang-oracle-committee');
const members = [];
for (const source of Object.keys(BTC_SOURCES)) members.push({ source, party: await allocate(`talang-pricer-${source}`) });
const rulesTx = await submit(committee, { CreateCommand: { templateId: GOV, createArguments: {
  governanceParty: committee, members: { map: members.map((m) => [m.party, {}]) }, threshold: '2',
  actionConfirmationTimeout: { microseconds: String(3600e6) }, additionalProposers: null } } });
const rules = rulesTx.transaction.events.map((e) => e.CreatedEvent).find(Boolean).contractId;
note({ step: `committee of ${members.length} pricers, one per exchange (${members.map((m) => m.source).join(', ')}), threshold 2`,
  updateId: rulesTx.transaction.updateId, offset: rulesTx.transaction.offset, committee, members });

const audience = [p.borrower, p.lenderA, p.lenderB, p.lenderC].filter(Boolean);
const confirm = async (member, action) => (await submit(member, { ExerciseCommand: { templateId: GOV, contractId: rules,
  choice: 'GovernanceRules_ConfirmAction', choiceArgument: { confirmer: member, actionProposalCid: action } } }, [committee]))
  .transaction.events.map((e) => e.CreatedEvent).find(Boolean).contractId;
const execute = (executor, action, confirmations) => submit(executor, { ExerciseCommand: { templateId: GOV, contractId: rules,
  choice: 'GovernanceRules_ExecuteConfirmedAction', choiceArgument: { executor, actionProposalCid: action, confirmations } } }, [committee]);

// One round: `proposer` proposes `price`; every member checks it against its own
// live source and confirms only if it is within tolerance; then execute.
async function round(label, proposer, price, source) {
  const prop = created(await submit(proposer.party, create('MarkProposal', { committee, proposer: proposer.party,
    instrument: 'CBTC', price: String(price), asOf: new Date().toISOString(), audience, source })), 'MarkProposal');
  const votes = [], confirmations = [];
  for (const m of members) {
    const own = await BTC_SOURCES[m.source]();
    const gap = Math.abs(price - own) / own;
    const agrees = gap <= TOLERANCE;
    votes.push({ member: m.source, ownPrice: own, gapPct: Math.round(gap * 10000) / 100, confirms: agrees });
    if (agrees) confirmations.push(await confirm(m.party, prop));
  }
  try {
    const tx = await execute(proposer.party, prop, confirmations);
    note({ step: `${label}: CBTC ${price} published by the committee (${confirmations.length} of 3 sources agree)`,
      votes, mark: created(tx, 'Mark'), updateId: tx.transaction.updateId, offset: tx.transaction.offset });
  } catch (e) {
    const reason = (e.message.match(/requirement '([^']+)'/) ?? [])[1] ?? e.message.slice(0, 160);
    note({ step: `${label}: CBTC ${price} refused by GovernanceRules (${confirmations.length} of 3 sources agree: ${reason})`, votes, refused: true });
  }
}

// 1. Honest round: the Coinbase member proposes Coinbase's price.
const [cb, kr, bs] = members;
const live = Math.round((await BTC_SOURCES.coinbase()) * 100) / 100;
await round('honest round', cb, live, 'coinbase BTC-USD spot');

// 2. A member with a bad feed proposes 8% above the market: the other two sources disagree.
await round('manipulated round', kr, Math.round(live * 1.08 * 100) / 100, 'kraken BTC-USD spot (feed off by +8%)');

// 3. Treasury notes priced from the official curve, for the record alongside.
const notes = await livePrices();
note({ step: 'Treasury notes priced from the US Treasury daily par yield curve',
  notes: Object.fromEntries(Object.entries(notes).filter(([k]) => k !== 'CBTC')) });

mkdirSync('docs/evidence', { recursive: true });
const where = /localhost|127\.0\.0\.1/.test(LEDGER) ? 'local-sandbox' : 'devnet';
writeFileSync(`docs/evidence/oracle-${where}.json`, JSON.stringify({ ledger: where === 'devnet' ? 'NODERS HackCanton DevNet participant' : 'local Canton sandbox 3.4.11',
  ranAt: new Date().toISOString(), tolerancePct: TOLERANCE * 100, steps: log }, null, 2) + '\n');
console.log(`\nevidence written to docs/evidence/oracle-${where}.json`);
