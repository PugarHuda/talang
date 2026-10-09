// Drives BitSafe DecMan's HTTP API (the same calls DecMan's own localnet
// integration test makes) to create Talang's valuation committee:
//   1. POST /onboarding on node 1 inviting nodes 2 and 3, threshold 2; nodes 2
//      and 3 accept. DecMan generates the keys, builds the decentralized
//      namespace + party-to-participant topology and has the owners sign it.
//   2. One member party per participant (allocated on that participant's JSON
//      Ledger API), ledger-api-user granted act/read on its member and on the
//      committee party on every node, party-config PUT on every node.
//   3. POST /contracts: GovernanceRules(committee, members = the 3 member
//      parties, threshold 2, 30 min confirmation timeout), signed by the owners.
// Writes localnet/committee.json. Usage: node localnet/decman-setup.mjs [prefix]
import { writeFileSync } from 'node:fs';
import { hmacJwt } from '../lib/jwt.mjs';

const PREFIX = process.argv[2] ?? 'talang-valuation-committee';
const NODES = [1, 2, 3].map((n) => ({ n, http: `http://localhost:808${n}`, json: `http://localhost:76${n - 1}1` }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = hmacJwt('unsafe', 'ledger-api-user');

async function call(base, path, { method = 'GET', json, auth } = {}) {
  const r = await fetch(base + path, { method, body: json && JSON.stringify(json),
    headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${base}${path} ${r.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const dm = (node, path, opts) => call(node.http, path, opts);
const ledger = (node, path, json) => call(node.json, path, { method: json ? 'POST' : 'GET', json, auth: true });

async function acceptInvitation(node, type) {
  for (let i = 0; i < 60; i++) {
    const inv = (await dm(node, '/invitations')).invitations.find((x) => x.invitation_type === type);
    if (inv) return dm(node, '/invitations/accept', { method: 'POST', json: { id: inv.id } });
    await sleep(1000);
  }
  throw new Error(`no ${type} invitation on node ${node.n}`);
}
async function waitWorkflow(path) {
  for (let i = 0; i < 240; i++) {
    const s = await dm(NODES[0], path);
    if (/completed/i.test(s.status)) return s;
    if (/failed/i.test(s.status)) throw new Error(`${path} failed: ${JSON.stringify(s).slice(0, 600)}`);
    await sleep(2000);
  }
  throw new Error(`${path} timed out`);
}
const idOf = (p) => (typeof p.party_id === 'string' ? p.party_id : `${p.party_id.prefix}::${p.party_id.fingerprint ?? p.party_id.namespace}`);
const parties = async () => (await dm(NODES[0], '/decentralized-parties')).parties;

// 1. The decentralized party.
const pids = await Promise.all(NODES.map(async (n) => (await dm(n, '/node-config')).node.participant_id));
let party = (await parties()).find((p) => idOf(p).startsWith(`${PREFIX}::`));
if (!party) {
  console.log(`onboarding ${PREFIX}: owners on participant1..3, threshold 2`);
  await dm(NODES[0], '/onboarding', { method: 'POST', json: { party_id_prefix: PREFIX, peer_ids: pids.slice(1), threshold: 2 } });
  await Promise.all([acceptInvitation(NODES[1], 'Onboarding'), acceptInvitation(NODES[2], 'Onboarding')]);
  await waitWorkflow('/onboarding/status');
  for (let i = 0; !party && i < 30; i++) { party = (await parties()).find((p) => idOf(p).startsWith(`${PREFIX}::`)); if (!party) await sleep(1000); }
}
const committee = idOf(party);
console.log('committee', committee);

// 2. Member parties, rights, party-config.
const grant = (node, party) => ledger(node, '/v2/users/ledger-api-user/rights', { userId: 'ledger-api-user', identityProviderId: '',
  rights: [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }] });
const members = [];
for (const node of NODES) {
  const hint = `${PREFIX}-member-p${node.n}`;
  const known = (await ledger(node, '/v2/parties')).partyDetails.find((d) => d.party.startsWith(`${hint}::`) && d.isLocal);
  const member = known?.party ?? (await ledger(node, '/v2/parties', { partyIdHint: hint, identityProviderId: '' })).partyDetails.party;
  await grant(node, member);
  await grant(node, committee);
  members.push(member);
}
for (const [i, node] of NODES.entries()) {
  await dm(node, '/party-config', { method: 'PUT', json: { dec_party_id: committee, member_party_id: members[i], user_id: 'ledger-api-user',
    keycloak_url: '', keycloak_realm: '', keycloak_client_id: '',
    packages: { governance_action: '#governance-action-v1', governance_core: '#governance-core-v1' } } });
}
console.log('members', members);

// 3. GovernanceRules, created through DecMan's contracts workflow.
const findRules = async () => (await parties()).find((p) => idOf(p) === committee)?.contracts?.find((c) => c.template_id.includes('GovernanceRules'))?.contract_id;
let rules = await findRules();
if (!rules) {
  const fresh = (await parties()).find((p) => idOf(p) === committee);
  await dm(NODES[0], '/contracts', { method: 'POST', json: {
    decentralized_party_id: committee,
    participant_ids: fresh.participants.map((p) => p.participant_uid),
    participant_parties: members, operator_party: members[0],
    contracts: [{ id: 'talang-governance-rules', name: 'GovernanceRules', package_id: '#governance-core-v1',
      module_name: 'Governance.Rules', entity_name: 'GovernanceRules', fields: [
        { type: 'decentralized_party' }, { type: 'party_set', parties: members }, { type: 'int64', value: 2 },
        { type: 'rel_time', microseconds: 1800000000 }, { type: 'none' }] }] } });
  await Promise.all([acceptInvitation(NODES[1], 'Contracts'), acceptInvitation(NODES[2], 'Contracts')]);
  await waitWorkflow('/contracts/status');
  for (let i = 0; !rules && i < 30; i++) { rules = await findRules(); if (!rules) await sleep(1000); }
}
const state = await dm(NODES[0], `/governance/state?party_id=${encodeURIComponent(committee)}`);
console.log('rules', rules);

const out = { committee, members, rules, participants: pids, governanceState: state.state ?? state,
  decmanParty: (await parties()).find((p) => idOf(p) === committee), at: new Date().toISOString() };
writeFileSync(new URL('./committee.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`\nCOMMITTEE_PARTY=${committee}\nCOMMITTEE_MEMBERS=${members.join(',')}\nCOMMITTEE_RULES=${rules}`);

// 4. The desk's own parties on participant 1, and the env file the scripts read:
//    each member's commands go to the node that hosts it.
const ROLES = ['borrower', 'lenderA', 'lenderB', 'lenderC', 'regulator', 'cashIssuer', 'bondIssuer', 'agent', 'venue'];
const known = (await ledger(NODES[0], '/v2/parties')).partyDetails;
const desk = {};
for (const role of ROLES) {
  desk[role] = known.find((d) => d.party.startsWith(`talang-${role}::`) && d.isLocal)?.party
    ?? (await ledger(NODES[0], '/v2/parties', { partyIdHint: `talang-${role}`, identityProviderId: '' })).partyDetails.party;
  await grant(NODES[0], desk[role]);
}
const root = new URL('../', import.meta.url);
writeFileSync(new URL('parties.localnet.json', root), JSON.stringify(desk, null, 2) + '\n');
writeFileSync(new URL('.env.localnet', root), [
  `DEVNET_LEDGER_URL=${NODES[0].json}`, 'LEDGER_USER_ID=ledger-api-user', 'LEDGER_HMAC_SECRET=unsafe',
  'PARTIES_FILE=parties.localnet.json', 'EVIDENCE_TAG=localnet',
  `PARTY_LEDGERS=${JSON.stringify(Object.fromEntries(members.map((m, i) => [m, NODES[i].json])))}`,
  `COMMITTEE_PARTY=${committee}`, `COMMITTEE_MEMBERS=${members.join(',')}`, `COMMITTEE_RULES=${rules}`].join('\n') + '\n');
console.log('wrote .env.localnet: ENV_FILE=.env.localnet node scripts/governance.mjs');
