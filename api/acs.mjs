// Hosted, read-only: a visitor picks a ROLE and reads that party's own view.
// There is no submit endpoint here, so a public URL can never drive the ledger.
import { PARTIES, deskAcs } from '../lib/ledger.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const role = req.body?.role;
  if (!Object.hasOwn(PARTIES, role)) return res.status(400).json({ error: 'unknown role' });
  // `since`: the offset of this page's last read, so an unchanged view is not re-sent every poll.
  try { return res.status(200).json(await deskAcs(PARTIES[role], req.body?.since)); }
  // The detail (node URLs, ledger error text) stays in the server log, not the public reply.
  catch (e) { console.error('acs', role, e.message); return res.status(502).json({ error: 'ledger unreachable' }); }
}
