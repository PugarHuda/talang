// Point the desk at a local Canton sandbox, so the whole stack (seed, desk, MCP
// agents) runs without DevNet credentials:
//   daml sandbox --json-api-port 7575 --dar .daml/dist/talang-repo-1.1.0.dar --wall-clock-time
//   node scripts/local.mjs          allocates the desk's parties, writes .env.local + parties.local.json
//   ENV_FILE=.env.local npm run seed / desk / e2e:mcp
import { writeFileSync } from 'node:fs';

const LEDGER = process.env.LOCAL_LEDGER_URL ?? 'http://localhost:7575';
const ROLES = ['borrower', 'lenderA', 'lenderB', 'lenderC', 'regulator', 'cashIssuer', 'bondIssuer', 'agent', 'venue'];

async function call(path, json) {
  const r = await fetch(LEDGER + path, { method: json ? 'POST' : 'GET',
    headers: json ? { 'content-type': 'application/json' } : {}, body: json ? JSON.stringify(json) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// The JSON API answers before the sandbox has joined its synchronizer; until it has,
// party allocation is refused, so wait for it.
async function allocate(hint) {
  for (let i = 0; ; i++) {
    try { return (await call('/v2/parties', { partyIdHint: hint, identityProviderId: '' })).partyDetails.party; }
    catch (e) {
      if (!/WITHOUT_CONNECTED_SYNCHRONIZER/.test(e.message) || i >= 60) throw e;
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}
const parties = {};
for (const role of ROLES) parties[role] = await allocate(`talang-${role}`);
// A local user that may act and read as every desk party (the sandbox has no auth).
const user = 'talang-local';
await call('/v2/users', { user: { id: user, primaryParty: parties.borrower, isDeactivated: false, identityProviderId: '' },
  rights: Object.values(parties).flatMap((party) => [{ kind: { CanActAs: { value: { party } } } }, { kind: { CanReadAs: { value: { party } } } }]) })
  .catch((e) => { if (!/ALREADY_EXISTS|already exists/i.test(e.message)) throw e; });

writeFileSync('parties.local.json', JSON.stringify(parties, null, 2) + '\n');
writeFileSync('.env.local', `DEVNET_LEDGER_URL=${LEDGER}\nLEDGER_USER_ID=${user}\nPARTIES_FILE=parties.local.json\n`);
console.log(`local sandbox ready: ${ROLES.length} parties, user ${user}`);
console.log('next: ENV_FILE=.env.local npm run seed && ENV_FILE=.env.local npm run desk');
