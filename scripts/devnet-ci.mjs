// Run the DevNet evidence pass where the DevNet credentials live: inside a Vercel
// build of the `talang` project, whose M2M settings are Sensitive env vars that
// cannot be read out. The output (party ids, update ids, offsets, refusals; never
// a credential) is published as static files under /evidence/.
//   vercel deploy --prod --build-env TALANG_DEVNET_CI=1   with buildCommand "node scripts/devnet-ci.mjs"
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';

// The built DARs travel in devnet/ (the .daml/ build directories are not uploaded).
mkdirSync('.daml/dist', { recursive: true });
mkdirSync('test/.daml/dist', { recursive: true });
copyFileSync('devnet/talang-repo-1.2.0.dar', '.daml/dist/talang-repo-1.2.0.dar');
copyFileSync('devnet/talang-test-0.1.0.dar', 'test/.daml/dist/talang-test-0.1.0.dar');

const STEPS = [
  ['rights', 'scripts/devnet-rights.mjs'],
  ['upload', 'scripts/upload.mjs'],
  ['seed', 'scripts/seed.mjs'],
  ['e2e-mcp', 'scripts/e2e-mcp.mjs'],
  ['governance', 'scripts/governance.mjs'],
  ['token-rail', 'scripts/token-rail.mjs'],
  ['cbtc-rail', 'scripts/cbtc-rail.mjs'],
  // Any CIP-0056 legs by env, e.g. --build-env PRESET=cc-cash (scripts/token-repo.mjs, docs/token-legs.md).
  ['token-repo', 'scripts/token-repo.mjs'],
  // Two builds, 2 h apart: --build-env PHASE=open, then PHASE=default (scripts/cbtc-default.mjs).
  ['cbtc-default', 'scripts/cbtc-default.mjs'],
  ['tidy', 'scripts/devnet-tidy.mjs'],
];
// DEVNET_STEPS=rights,cbtc-rail runs only those steps (the rest already ran on this node).
const only = process.env.DEVNET_STEPS?.split(',').map((x) => x.trim());
mkdirSync('web/evidence', { recursive: true });
// Never publish anything that looks like a credential, a bearer token or the tenant's endpoints,
// and redact BEFORE printing too: the Vercel build log is a publication of its own.
const secrets = ['DEVNET_CLIENT_SECRET', 'DEVNET_CLIENT_ID', 'DEVNET_TOKEN_URL', 'DEVNET_AUDIENCE', 'LEDGER_HMAC_SECRET']
  .map((k) => process.env[k]?.trim()).filter((v) => v && v.length > 6);
const ledgers = [process.env.DEVNET_LEDGER_URL, ...(() => { try { return Object.values(JSON.parse(process.env.PARTY_LEDGERS)); } catch { return []; } })()]
  .filter(Boolean).map((u) => u.trim().replace(/\/$/, ''));
const redact = (t) => {
  for (const s of secrets) t = t.split(s).join('[redacted]');
  // The participant's URL is the tenant's endpoint, not something to publish.
  for (const u of ledgers) t = t.split(u).join('NODERS HackCanton DevNet participant');
  return t.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted-jwt]')
    .replace(/(bearer\s+|"access_token"\s*:\s*")[^\s"]+/gi, '$1[redacted]')
    .replace(/(client_secret=)[^&\s]+/gi, '$1[redacted]');
};
let log = `Talang DevNet evidence run, ${new Date().toISOString()}\n`;
for (const [name, file] of STEPS.filter(([n]) => !only || only.includes(n))) {
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', env: process.env, timeout: 10 * 60e3 });
  const out = redact(`\n=== ${name} (exit ${r.status}) ===\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  log += out; console.log(out);
}
writeFileSync('web/evidence/devnet-run.log', log);
for (const f of existsSync('docs/evidence') ? readdirSync('docs/evidence') : []) {
  if (f.includes('devnet')) writeFileSync(`web/evidence/${f}`, redact(readFileSync(`docs/evidence/${f}`, 'utf8')));
}
console.log('evidence published under web/evidence/');
