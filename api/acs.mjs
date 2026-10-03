// Hosted, read-only: a visitor picks a ROLE and reads that party's own view.
// There is no submit endpoint here, so a public URL can never drive the ledger.
import { PARTIES, acs } from '../lib/ledger.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const role = req.body?.role;
  if (!Object.hasOwn(PARTIES, role)) return res.status(400).json({ error: 'unknown role' });
  try { return res.status(200).json(await acs(PARTIES[role])); }
  catch (e) { return res.status(502).json({ error: 'ledger unreachable: ' + e.message }); }
}
