// Wallet signatures the desk can check without trusting the wallet or the browser.
//
// A CIP-0103 wallet's signMessage signs a string's UTF-8 bytes with the primary account's key
// (Ed25519 or ECDSA P-256, Base64 or hex; the spec leaves the encoding open). Two checks:
// 1. the signature verifies under the public key the wallet reported;
// 2. that key's Canton fingerprint (SHA-256 over hash purpose 12 + key bytes, multihash 1220...)
//    equals the party's namespace, the part of the party id after "::". Without 2, any key
//    could claim any party.
// Both recipes follow canton-network/wallet: tools/conformance-dapp/src/validation.ts and
// core/types/src/crypto.ts.
//
// Used two ways: a role the operator binds to a wallet (TALANG_WALLET_ROLES) only moves on
// commands that wallet signed, one by one; and every signed command leaves a receipt anyone can
// re-verify here, e.g. a lender's sealed quote, signed by a key the desk never holds.
import { PARTIES } from '../lib/ledger.mjs';
import { randomUUID } from 'node:crypto';

const env = (k) => process.env[k]?.trim();
const json = (k) => { try { return JSON.parse(env(k)); } catch { return null; } };
// {"lenderB": "<wallet party id>"}: these desk roles are driven by that wallet's signature.
export const WALLET_ROLES = json('TALANG_WALLET_ROLES') ?? {};
// The venue's party per network for wallet fee payments; a network left unset has no pay target.
const RECIPIENTS = Object.fromEntries([['testnet', env('TALANG_TESTNET_VENUE')], ['mainnet', env('TALANG_MAINNET_VENUE')]].filter(([, v]) => v));
export const walletConfig = () => ({
  ...(Object.keys(RECIPIENTS).length ? { walletRecipients: RECIPIENTS } : {}),
  ...(Object.keys(WALLET_ROLES).length ? { walletRoles: WALLET_ROLES } : {}),
});

const b64 = (s) => {
  const t = String(s).trim();
  if (!t || !/^[A-Za-z0-9+/]*={0,2}$/.test(t)) throw new Error('not Base64');
  return new Uint8Array(Buffer.from(t, 'base64'));
};
const hex = (s) => {
  const t = String(s).trim();
  if (t.length % 2 || !/^[0-9a-f]*$/i.test(t)) throw new Error('not hex');
  return new Uint8Array(Buffer.from(t, 'hex'));
};
const keyBytes = (k) => {
  const t = String(k).trim();
  if (t.startsWith('-----BEGIN PUBLIC KEY-----')) return b64(t.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''));
  return t.length === 64 && /^[0-9a-f]+$/i.test(t) ? hex(t) : b64(t);
};

// An Ed25519 key travels raw (32 bytes) or DER SPKI-wrapped (44 bytes); Canton may have
// fingerprinted either encoding, so the namespace check accepts both of the same key.
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const encodings = (key) => key.length === 32 ? [key, Buffer.concat([SPKI_ED25519, key])]
  : key.length === 44 && SPKI_ED25519.equals(Buffer.from(key.subarray(0, 12))) ? [key, key.subarray(12)] : [key];

export async function fingerprint(publicKey) { return fingerprintBytes(keyBytes(publicKey)); }
async function fingerprintBytes(key) {
  const input = new Uint8Array(4 + key.length);
  new DataView(input.buffer).setUint32(0, 12);
  input.set(key, 4);
  return '1220' + Buffer.from(await crypto.subtle.digest('SHA-256', input)).toString('hex');
}

async function importKey(publicKey) {
  const bytes = keyBytes(publicKey);
  for (const alg of ['Ed25519', { name: 'ECDSA', namedCurve: 'P-256' }]) {
    try { return await crypto.subtle.importKey(bytes.length === 32 ? 'raw' : 'spki', bytes, alg, false, ['verify']); } catch {}
  }
  throw new Error('public key is neither Ed25519 nor P-256');
}

// DER ECDSA signature -> raw r||s, which WebCrypto expects.
function derToRaw(der) {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const raw = new Uint8Array(64);
  let at = 2;
  for (const end of [32, 64]) {
    const len = der[at + 1];
    if (der[at] !== 0x02 || at + 2 + len > der.length) return null;
    let v = der.subarray(at + 2, at + 2 + len);
    if (v[0] === 0) v = v.subarray(1);
    if (v.length > 32) return null;
    raw.set(v, end - v.length);
    at += 2 + len;
  }
  return at === der.length ? raw : null;
}

export async function verifySignature(message, signature, publicKey) {
  const key = await importKey(publicKey);
  const ecdsa = key.algorithm.name === 'ECDSA';
  for (const decode of [b64, hex]) {
    let sig;
    try { sig = decode(signature); } catch { continue; }
    if (ecdsa && sig.length !== 64) sig = derToRaw(sig);
    if (sig?.length === 64 && await crypto.subtle.verify(ecdsa ? { name: 'ECDSA', hash: 'SHA-256' } : 'Ed25519',
      key, sig, new TextEncoder().encode(message))) return true;
  }
  return false;
}

// { signatureValid, keyOwnsParty, ok, reason }. Never throws on bad input.
export async function checkWalletSignature({ message, signature, publicKey, partyId } = {}) {
  if (![message, signature, publicKey, partyId].every((x) => typeof x === 'string' && x))
    return { ok: false, reason: 'message, signature, publicKey and partyId are all required' };
  try {
    const signatureValid = await verifySignature(message, signature, publicKey);
    const fps = await Promise.all(encodings(keyBytes(publicKey)).map(fingerprintBytes));
    const keyOwnsParty = fps.includes(partyId.split('::')[1]);
    const fp = fps[0];
    const reason = !signatureValid ? 'the signature does not verify under this public key'
      : !keyOwnsParty ? `the key's fingerprint ${fp} is not this party's namespace` : undefined;
    return { ok: signatureValid && keyOwnsParty, signatureValid, keyOwnsParty, fingerprint: fp, ...(reason ? { reason } : {}) };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ---- wallet-driven roles: one fresh signature per command ----
// ponytail: challenges and receipts live in this process's memory; a restart drops them (the
// ledger keeps the transactions). Persist them, or put the signature in a Daml field, when the
// package is next upgraded.
const CHALLENGES = new Map();
export const RECEIPTS = [];
const TTL = 5 * 60e3;
const choiceOf = (c) => c.ExerciseCommand ? `${c.ExerciseCommand.choice} on ${c.ExerciseCommand.templateId.split(':').pop()} ${c.ExerciseCommand.contractId}`
  : c.CreateCommand ? `create ${c.CreateCommand.templateId.split(':').pop()}` : Object.keys(c)[0];

// What the wallet shows its user and signs: the role, the exact command, a single-use nonce.
function challenge(role, command) {
  const nonce = randomUUID();
  const message = ['Talang desk command, signed by the wallet that drives this role',
    `role: ${role} (${PARTIES[role]})`, `signer: ${WALLET_ROLES[role]}`, `action: ${choiceOf(command)}`,
    `command: ${JSON.stringify(command)}`, `nonce: ${nonce}`, `issued: ${new Date().toISOString()}`].join('\n');
  CHALLENGES.set(nonce, { message, role, command: JSON.stringify(command), expires: Date.now() + TTL });
  return message;
}

// The desk's /api/submit for a role. A role bound to a wallet needs that wallet's signature over
// the exact command; anything else goes straight through. Returns [httpStatus, body].
export async function walletSubmit(role, command, auth, submit) {
  const signer = WALLET_ROLES[role];
  if (!signer) return [200, await submit(PARTIES[role], command)];
  if (!auth) return [401, { error: `${role} is driven by wallet ${signer}: sign this command with it`, walletChallenge: challenge(role, command) }];
  const nonce = /\nnonce: (.+)\n/.exec(auth.message ?? '')?.[1];
  const c = nonce && CHALLENGES.get(nonce);
  CHALLENGES.delete(nonce);
  if (!c || c.expires < Date.now()) return [401, { error: 'the signed challenge is unknown, used or expired; try again' }];
  if (c.message !== auth.message || c.role !== role || c.command !== JSON.stringify(command))
    return [401, { error: 'the signed message is not the challenge issued for this command' }];
  if (auth.partyId !== signer) return [403, { error: `signed by ${auth.partyId}, but ${role} is driven by ${signer}` }];
  const check = await checkWalletSignature(auth);
  if (!check.ok) return [403, { error: 'wallet signature rejected: ' + check.reason }];
  const tx = await submit(PARTIES[role], command);
  const created = (tx?.transaction?.events ?? []).map((e) => e.CreatedEvent).filter(Boolean)
    .map((e) => ({ templateId: e.templateId, contractId: e.contractId }));
  RECEIPTS.push({ role, signer, message: auth.message, signature: auth.signature, publicKey: auth.publicKey,
    updateId: tx?.transaction?.updateId, created, at: new Date().toISOString() });
  return [200, tx];
}

// A receipt carries the full command (a sealed quote's rate), so a role sees it only if it signed
// it or still sees a contract it created: the ledger's privacy, not a second rule.
export function receiptsFor(role, contracts) {
  const seen = new Set(contracts.map((c) => c.cid));
  return RECEIPTS.filter((r) => r.role === role || r.created.some((c) => seen.has(c.contractId)));
}

// Stateless check anyone can run, hosted copy included: POST { message, signature, publicKey, partyId }.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  return res.status(200).json(await checkWalletSignature(req.body ?? {}));
}
