// Regression for server.mjs: cross-site requests, DNS rebinding, body size, traversal.
// Starts its own desk on port 8097 against the local sandbox.
//   ENV_FILE=.env.local node scripts/sec-server.mjs [path/to/server.mjs]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { PARTIES as P, create } from '../lib/ledger.mjs';

const PORT = 8097, SERVER = process.argv[2] ?? 'server.mjs';
const srv = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
await new Promise((ok) => srv.stdout.once('data', ok));
const call = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((res) => {
  const q = request({ host: '127.0.0.1', port: PORT, path, method, headers: { host: `localhost:${PORT}`, ...headers } },
    (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => res([r.statusCode, s])); });
  q.on('error', (e) => res([0, e.code])); q.end(body);
});
// What an attacker's page can send without a preflight: text/plain, its own Origin.
const faucet = JSON.stringify({ role: 'cashIssuer', command: create('Holding', { issuer: P.cashIssuer, owner: P.lenderA, instrument: 'USDC', amount: '1000000' }) });
const results = [];
const check = async (name, f) => { try { await f(); results.push(['ok  ', name]); } catch (e) { results.push(['FAIL', `${name}: ${e.message.split('\n')[0]}`]); } };
try {
  await check('cross-site text/plain POST mints nothing', async () =>
    assert.equal((await call('/api/submit', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' }, body: faucet }))[0], 403));
  await check('another localhost port cannot drive it', async () =>
    assert.equal((await call('/api/acs', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: '{"role":"lenderA"}' }))[0], 403));
  await check('DNS-rebound Host is refused', async () =>
    assert.equal((await call('/api/config', { headers: { host: `evil.example:${PORT}` } }))[0], 403));
  await check('same-origin read works', async () =>
    assert.equal((await call('/api/acs', { method: 'POST', headers: { origin: `http://localhost:${PORT}`, 'content-type': 'application/json' }, body: '{"role":"lenderA"}' }))[0], 200));
  await check('2 MB body is cut off', async () =>
    assert.ok([413, 0].includes((await call('/api/acs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(2 << 20) }))[0])));
  await check('prototype keys are not roles', async () =>
    assert.equal((await call('/api/submit', { method: 'POST', body: '{"role":"__proto__"}' }))[0], 400));
  for (const p of ['/../server.mjs', '/..%2fserver.mjs', '/..%5c.env.local', '/%2e%2e/.env.local', '/....//server.mjs'])
    await check(`traversal ${p}`, async () => { const [c, b] = await call(p); assert.ok(c === 404 && !/PARTIES|DEVNET|import/.test(b), String(c)); });
} finally { srv.kill(); }
for (const r of results) console.log(...r);
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
