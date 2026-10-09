// Self-check for the hosted read-only API (api/acs.mjs, api/config.mjs). The handlers
// are imported directly with fetch stubbed, so it needs no network and no credentials.
// The security properties: nothing but GET config and POST acs is served, a read is
// scoped to exactly one desk party, the ledger is only ever asked to read, and no
// client secret or bearer token comes back in a response.
//   node scripts/test-readonly-proxy.mjs
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'client-secret-must-not-leak', CLIENT = 'client-id-must-not-leak', TOKEN = 'bearer-token-must-not-leak';
const LEDGER = 'https://ledger.test', TOKEN_URL = 'https://auth.test/token';
const PARTIES = { borrower: 'b::1220aa', lenderA: 'la::1220aa', lenderB: 'lb::1220aa', regulator: 'r::1220aa' };

// Fake settings must win over .env.noders, which lib/ledger.mjs would otherwise load.
Object.assign(process.env, { ENV_FILE: '.env.does-not-exist', TALANG_PARTIES: JSON.stringify(PARTIES),
  DEVNET_LEDGER_URL: LEDGER, DEVNET_TOKEN_URL: TOKEN_URL, DEVNET_CLIENT_ID: CLIENT, DEVNET_CLIENT_SECRET: SECRET,
  DEVNET_AUDIENCE: 'aud', DEVNET_SCOPE: 'scope', LEDGER_USER_ID: 'desk' });
delete process.env.LEDGER_HMAC_SECRET;

// Stubbed network: a token server and a ledger that answers reads. `mode` breaks one side.
let calls = [], mode = 'ok';
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method ?? 'GET', body = typeof opts.body === 'string' ? opts.body : String(opts.body ?? '');
  calls.push({ url: String(url), method, body, auth: opts.headers?.authorization });
  const reply = (status, data) => new Response(JSON.stringify(data), { status });
  if (url === TOKEN_URL) return mode === 'token-down' ? reply(401, { error: 'invalid_client' }) : reply(200, { access_token: TOKEN, expires_in: 300 });
  if (mode === 'ledger-down') return reply(503, { code: 'UNAVAILABLE', cause: 'node is restarting' });
  if (url === LEDGER + '/v2/state/ledger-end' && method === 'GET') return reply(200, { offset: 42 });
  if (url === LEDGER + '/v2/state/active-contracts' && method === 'POST') {
    const party = Object.keys(JSON.parse(body).eventFormat.filtersByParty)[0];
    return reply(200, [{ contractEntry: { JsActiveContract: { createdEvent: { contractId: 'c1', createArgument: { owner: party } } } } }]);
  }
  return reply(404, { code: 'NOT_FOUND' });
};

const load = async (f) => (await import(pathToFileURL(join(ROOT, 'api', f)).href)).default;
const acs = await load('acs.mjs'), config = await load('config.mjs');

const res = () => ({ _s: 0, _j: null, status(c) { this._s = c; return this; }, json(o) { this._j = o; return this; },
  send() { return this; }, end() { return this; }, setHeader() {} });
const call = async (h, method, body) => { calls = []; const r = res(); await h({ method, body, headers: {} }, r); return r; };
const clean = (r) => !JSON.stringify(r._j ?? '').match(new RegExp([SECRET, CLIENT, TOKEN].join('|')));

let fail = 0;
const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fail++; };

// A new file in api/ is a new public endpoint; this suite has to be extended for it first.
ok('api/ holds only acs.mjs and config.mjs', readdirSync(join(ROOT, 'api')).sort().join() === 'acs.mjs,config.mjs');

// Failures first, before a token is cached: the 502 names no credential.
mode = 'token-down';
let r = await call(acs, 'POST', { role: 'borrower' });
ok('token server down: 502, no secret in body', r._s === 502 && clean(r));
mode = 'ledger-down';
r = await call(acs, 'POST', { role: 'borrower' });
ok('ledger down: 502, no secret or token in body', r._s === 502 && clean(r));
ok('ledger down: token sent only to the ledger, never in a URL', calls.every((c) => !c.url.includes(TOKEN) && !c.url.includes(SECRET)));
mode = 'ok';

// Methods other than POST on acs: refused before the ledger is reached.
for (const m of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
  ok(`acs ${m}: 405, no ledger call`, (r = await call(acs, m, { role: 'borrower' }))._s === 405 && calls.length === 0);

// Bad input: anything that is not one of this desk's roles.
for (const [name, body] of [['no body', undefined], ['empty body', {}], ['unknown role', { role: 'intruder' }],
  ['party id instead of role', { role: PARTIES.borrower }], ['__proto__', { role: '__proto__' }],
  ['constructor', { role: 'constructor' }], ['hasOwnProperty', { role: 'hasOwnProperty' }],
  ['null role', { role: null }], ['object role', { role: { toString: () => 'x' } }], ['raw string body', '{"role":"borrower"}']])
  ok(`acs bad input (${name}): 400, no ledger call`, (r = await call(acs, 'POST', body))._s === 400 && calls.length === 0);

// A good read, per role: only ledger-end and active-contracts, scoped to that role's party alone.
for (const [role, party] of Object.entries(PARTIES)) {
  r = await call(acs, 'POST', { role });
  const reads = calls.filter((c) => c.url.startsWith(LEDGER));
  const scoped = reads.filter((c) => c.method === 'POST').every((c) => {
    const ef = JSON.parse(c.body).eventFormat ?? {};
    return Object.keys(ef.filtersByParty ?? {}).join() === party && !('filtersForAnyParty' in ef);
  });
  ok(`acs ${role}: 200 with that party's contracts`, r._s === 200 && r._j.contracts.length > 0 && r._j.contracts.every((c) => c.arg.owner === party));
  ok(`acs ${role}: ledger asked only to read`, reads.length > 0 && reads.every((c) =>
    (c.method === 'GET' && c.url === LEDGER + '/v2/state/ledger-end') || (c.method === 'POST' && c.url === LEDGER + '/v2/state/active-contracts')));
  ok(`acs ${role}: filter names ${role}'s party and no other`, scoped);
  ok(`acs ${role}: no secret or token in body`, clean(r));
}

// Config: the role -> party map and readOnly, nothing else.
r = await call(config, 'GET');
ok('config GET: 200, readOnly true, the desk parties', r._s === 200 && r._j.readOnly === true && JSON.stringify(r._j.parties) === JSON.stringify(PARTIES));
ok('config GET: only parties and readOnly', Object.keys(r._j).sort().join() === 'parties,readOnly');
ok('config GET: no secret or token, no ledger call', clean(r) && calls.length === 0);
for (const m of ['POST', 'PUT', 'DELETE'])
  ok(`config ${m}: 405`, (await call(config, m))._s === 405);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
