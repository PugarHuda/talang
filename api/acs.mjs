// Hosted, read-only: a visitor picks a ROLE and reads that party's own view.
// There is no submit endpoint here, so a public URL can never drive the ledger.
import { PARTIES, deskAcs } from '../lib/ledger.mjs';
import { bandBestExecution } from '../lib/repo.mjs';

// One read costs the node ~18 requests (ledger end + one per template), so this function guards it.
// ponytail: both maps live in one warm instance only; Vercel runs several, so the real ceiling is
// BURST x instances per IP, and a cold start forgets both. Upgrade path: a Vercel Firewall
// rate_limit rule on /api/acs (counted at the edge, per region) or a shared store.
const BURST = 40, PER_SEC = 2; // a desk tab polls once per 5 s per role; side by side reads up to 7 roles
const buckets = new Map();
function allow(ip, now = Date.now()) {
  if (buckets.size > 10000) buckets.clear(); // bounded memory; a clear only hands out fresh buckets
  const b = buckets.get(ip) ?? { tokens: BURST, at: now };
  b.tokens = Math.min(BURST, b.tokens + (now - b.at) / 1000 * PER_SEC); b.at = now;
  buckets.set(ip, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
// Identical reads (same role, same `since`) within 2 s share one ledger read, in-flight ones too.
const TTL = 2000, cache = new Map();
function cachedRead(role, since) {
  const key = `${role}|${Number.isSafeInteger(since) ? since : ''}`, hit = cache.get(key), now = Date.now();
  if (hit && now - hit.at < TTL) return hit.p;
  if (cache.size > 1000) cache.clear();
  // The regulator gets pre-1.2.0 best-execution gaps as a band, as the contract writes them since 1.2.0.
  const p = deskAcs(PARTIES[role], since)
    .then((r) => (role === 'regulator' && r.contracts ? { ...r, contracts: bandBestExecution(r.contracts) } : r));
  cache.set(key, { at: now, p });
  p.catch(() => cache.get(key)?.p === p && cache.delete(key)); // a failed read is not served again
  return p;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const role = req.body?.role;
  // A string only: an array would coerce to a role name, an object with a bad toString would throw.
  if (typeof role !== 'string' || !Object.hasOwn(PARTIES, role)) return res.status(400).json({ error: 'unknown role' });
  // Vercel sets x-real-ip to the client address; x-forwarded-for's first hop is the fallback.
  const ip = req.headers?.['x-real-ip'] ?? String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
  if (!allow(ip || 'unknown')) { res.setHeader('Retry-After', '1'); return res.status(429).json({ error: 'too many reads, slow down' }); }
  // `since`: the offset of this page's last read, so an unchanged view is not re-sent every poll.
  try { return res.status(200).json(await cachedRead(role, req.body?.since)); }
  // The detail (node URLs, ledger error text) stays in the server log, not the public reply.
  catch (e) { console.error('acs', role, e.message); return res.status(502).json({ error: 'ledger unreachable' }); }
}
