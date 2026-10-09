// Which ledger user the DevNet scripts run as, and the parties it may act or read
// as: the first thing to check when a submit comes back 403. Party ids only.
import { api, USER, PARTIES } from '../lib/ledger.mjs';

const r = await api(`/v2/users/${encodeURIComponent(USER)}/rights`);
const rights = (r.data?.rights ?? []).map((x) => Object.entries(x.kind)[0]).map(([k, v]) => `${k} ${v?.value?.party ?? ''}`.trim());
console.log(`user ${USER}: ${r.ok ? `${rights.length} rights` : `rights not readable (${r.status})`}`);
for (const line of rights) console.log('  ' + line);
const acts = new Set(rights.filter((l) => l.startsWith('CanActAs')).map((l) => l.split(' ')[1]));
for (const [role, party] of Object.entries(PARTIES)) console.log(`${acts.has(party) ? '✓' : '✗'} act as ${role}`);
for (const party of [process.env.COMMITTEE_PARTY, ...(process.env.COMMITTEE_MEMBERS ?? '').split(',')].filter(Boolean))
  console.log(`${acts.has(party) ? '✓' : '✗'} act as ${party.split('::')[0]}`);
