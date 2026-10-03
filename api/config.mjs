import { PARTIES } from '../lib/ledger.mjs';

export default function handler(req, res) {
  res.status(200).json({ parties: PARTIES, readOnly: true });
}
