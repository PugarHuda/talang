// The committee survives a node going down, and only that: on the DecMan LocalNet
// (localnet/decman-setup.mjs), stop participant 3 and publish a mark with the two
// members still up; then stop participant 2 as well and the same publish fails,
// because the committee is hosted with threshold 2 and one node cannot confirm
// for it. Both nodes are started again at the end.
//   ENV_FILE=.env.localnet node scripts/localnet-offline.mjs
import { writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { PARTIES as p, submit, create, created } from '../lib/ledger.mjs';

const GOV = '#governance-core-v1:Governance.Rules:GovernanceRules';
const committee = process.env.COMMITTEE_PARTY;
const [m1, m2] = process.env.COMMITTEE_MEMBERS.split(',');
const rules = process.env.COMMITTEE_RULES;
const audience = [p.borrower, p.lenderA, p.lenderB, p.lenderC].filter(Boolean);
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// bootstrap.canton polls localnet/ctl and writes <node>.status when done.
async function node(cmd, name) {
  const status = new URL(`../localnet/ctl/${name}.status`, import.meta.url);
  rmSync(status, { force: true });
  writeFileSync(new URL(`../localnet/ctl/${cmd}-${name}`, import.meta.url), '');
  for (let i = 0; i < 120 && !existsSync(status); i++) await sleep(1000);
  const s = existsSync(status) ? readFileSync(status, 'utf8').trim() : `${cmd} ${name}: no answer`;
  console.log('·', s); log.push({ step: s });
  if (!/ ok /.test(s)) throw new Error(s);
  await sleep(5000);
}

let stage = '';
async function publish(price) {
  stage = 'propose on node 1';
  const prop = created(await submit(m1, create('MarkProposal', { committee, proposer: m1, instrument: 'UST10Y',
    price: String(price), asOf: new Date().toISOString(), audience, source: 'pricing feed' })), 'MarkProposal');
  const confirm = async (member) => (await submit(member, { ExerciseCommand: { templateId: GOV, contractId: rules,
    choice: 'GovernanceRules_ConfirmAction', choiceArgument: { confirmer: member, actionProposalCid: prop } } }, [committee]))
    .transaction.events.map((e) => e.CreatedEvent).find(Boolean).contractId;
  stage = 'confirm by member on node 1 (GovernanceRules is signed by the committee, so its hosting nodes must confirm)';
  const c1 = await confirm(m1);
  stage = 'confirm by member on node 2';
  const cs = [c1, await confirm(m2)];
  stage = 'execute';
  return submit(m1, { ExerciseCommand: { templateId: GOV, contractId: rules, choice: 'GovernanceRules_ExecuteConfirmedAction',
    choiceArgument: { executor: m1, actionProposalCid: prop, confirmations: cs } } }, [committee]);
}

try {
  await node('stop', 'participant3');
  const tx = await publish(97500);
  const e = { step: 'participant 3 down: mark UST10Y 97,500 published by members on nodes 1 and 2', updateId: tx.transaction.updateId,
    mark: created(tx, 'Mark') };
  console.log('✓', e.step); log.push(e);

  await node('stop', 'participant2');
  try {
    await publish(97000);
    throw new Error('published with one node up: the hosting threshold did not hold');
  } catch (err) {
    if (/hosting threshold did not hold/.test(err.message)) throw err;
    const reason = `stopped at: ${stage}: ${err.message.slice(0, 300)}`;
    console.log('✓ participants 2 and 3 down: publish failed:', reason); log.push({ step: 'participants 2 and 3 down: publish failed', refused: true, reason });
  }
} finally {
  for (const n of ['participant2', 'participant3']) await node('start', n).catch((e) => console.log('!', e.message));
}
writeFileSync('docs/evidence/bitsafe-node-offline-localnet.json', JSON.stringify({ ledger: 'DecMan LocalNet: 3 Canton 3.5.8 participants',
  committee, ranAt: new Date().toISOString(), steps: log }, null, 2) + '\n');
console.log('evidence written to docs/evidence/bitsafe-node-offline-localnet.json');
