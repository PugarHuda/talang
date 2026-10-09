// Upload the desk's packages to the ledger in the env file (DevNet by default):
// talang-repo and BitSafe's two governance packages, as released. Re-uploading a
// package the participant already has is a no-op.
//   npm run upload            then: npm run seed && npm run e2e:mcp && npm run governance
import { readFileSync } from 'node:fs';
import { api, LEDGER } from '../lib/ledger.mjs';

const DARS = ['.daml/dist/talang-repo-1.0.0.dar', 'dars/governance-action-v1-0.1.0.dar', 'dars/governance-core-v1-0.1.0.dar'];
for (const dar of DARS) {
  const r = await api('/v2/packages', { method: 'POST', bytes: readFileSync(dar) });
  if (!r.ok) { console.error(`✗ ${dar}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); process.exit(1); }
  console.log(`✓ ${dar}`);
}
console.log(`uploaded to ${LEDGER}`);
