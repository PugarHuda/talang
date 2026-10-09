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
copyFileSync('devnet/talang-repo-1.0.0.dar', '.daml/dist/talang-repo-1.0.0.dar');
copyFileSync('devnet/talang-test-0.1.0.dar', 'test/.daml/dist/talang-test-0.1.0.dar');

const STEPS = [
  ['upload', 'scripts/upload.mjs'],
  ['seed', 'scripts/seed.mjs'],
  ['e2e-mcp', 'scripts/e2e-mcp.mjs'],
  ['governance', 'scripts/governance.mjs'],
  ['token-rail', 'scripts/token-rail.mjs'],
];
mkdirSync('web/evidence', { recursive: true });
let log = `Talang DevNet evidence run, ${new Date().toISOString()}\n`;
for (const [name, file] of STEPS) {
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', env: process.env, timeout: 10 * 60e3 });
  const out = `\n=== ${name} (exit ${r.status}) ===\n${r.stdout ?? ''}${r.stderr ?? ''}`;
  log += out; console.log(out);
}
// Belt and braces: never publish anything that looks like a secret or a bearer token.
const secrets = ['DEVNET_CLIENT_SECRET', 'DEVNET_CLIENT_ID'].map((k) => process.env[k]).filter((v) => v && v.length > 6);
for (const s of secrets) log = log.split(s).join('[redacted]');
log = log.replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]');
// The participant's URL is the tenant's endpoint, not something to publish.
const scrub = (t) => (process.env.DEVNET_LEDGER_URL ? t.split(process.env.DEVNET_LEDGER_URL.replace(/\/$/, '')).join('NODERS HackCanton DevNet participant') : t);
writeFileSync('web/evidence/devnet-run.log', scrub(log));
for (const f of existsSync('docs/evidence') ? readdirSync('docs/evidence') : []) {
  if (f.includes('devnet')) writeFileSync(`web/evidence/${f}`, scrub(readFileSync(`docs/evidence/${f}`, 'utf8')));
}
console.log('evidence published under web/evidence/');
