import { PARTIES } from '../lib/ledger.mjs';

export default function handler(req, res) {
  // Static and read-only, but only GET is served, like every other path here.
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).json({ error: 'GET only' });
  res.status(200).json({ parties: PARTIES, readOnly: true });
}
