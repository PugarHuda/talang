// JSON Ledger API client shared by the seed script, the local desk server and the
// hosted read-only proxy. The bearer token is fetched and held server-side only.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hmacJwt } from './jwt.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Locally the settings come from .env.noders (gitignored); on Vercel from env vars.
const envFile = join(ROOT, process.env.ENV_FILE ?? '.env.noders');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
const env = (k) => process.env[k]?.trim();

export const LEDGER = (env('DEVNET_LEDGER_URL') ?? '').replace(/\/$/, '');
export const USER = env('LEDGER_USER_ID');
// On a multi-participant network a party is hosted on one node: its commands go
// to that node's JSON API (PARTY_LEDGERS = {"party": "url"}), the rest to LEDGER.
const PARTY_LEDGERS = (() => { try { return JSON.parse(env('PARTY_LEDGERS')); } catch { return {}; } })();
export const PKG = '#talang-repo';
export const PARTIES = (() => {
  try { return JSON.parse(env('TALANG_PARTIES')); } catch {}
  return JSON.parse(readFileSync(join(ROOT, env('PARTIES_FILE') ?? 'parties.json'), 'utf8'));
})();

// Template name -> Daml module. Names are unique across the package, so the rest
// of the code refers to a template by its bare name.
export const MODULE = Object.fromEntries([
  ...['Holding', 'Escrow', 'Mark', 'RepoRFQ', 'RepoQuote', 'RepoTrade', 'MarginCall', 'Substitution',
    'RepoReport', 'LossNotice', 'BestExecution', 'RollOffer', 'RepurchaseNotice', 'VenueAgreement'].map((t) => [t, 'Talang']),
  ...['MarkProposal', 'SyndicateProposal'].map((t) => [t, 'TalangGovernance']),
]);
export const TEMPLATES = Object.keys(MODULE);
export const templateId = (tpl) => `${PKG}:${MODULE[tpl]}:${tpl}`;

async function fetchT(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(timer); }
}

let tok = null, tokExp = 0;
async function token() {
  // A local sandbox runs without auth (`npm run local`); the DecMan LocalNet uses
  // Canton's unsafe shared secret; DevNet always has a token URL.
  if (env('LEDGER_HMAC_SECRET')) return hmacJwt(env('LEDGER_HMAC_SECRET'), USER);
  if (!env('DEVNET_TOKEN_URL')) return null;
  if (tok && Date.now() < tokExp) return tok;
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: env('DEVNET_CLIENT_ID'),
    client_secret: env('DEVNET_CLIENT_SECRET'), audience: env('DEVNET_AUDIENCE'), scope: env('DEVNET_SCOPE'),
  });
  const r = await fetchT(env('DEVNET_TOKEN_URL'), { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (!j.access_token) throw new Error('token fetch failed');
  tok = j.access_token;
  tokExp = Date.now() + ((Number(j.expires_in) || 300) - 30) * 1000;
  return tok;
}

export async function api(path, { method = 'GET', json, bytes, base = LEDGER } = {}) {
  const t = await token();
  const r = await fetchT(base + path, { method,
    headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}),
      ...(bytes ? { 'content-type': 'application/octet-stream' } : {}) },
    body: json ? JSON.stringify(json) : bytes }, method === 'GET' ? 15000 : 60000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, ok: r.ok, data };
}

// Every Talang contract `party` can see, one request per template: a wildcard read
// for a busy party hits the node's hard 200-element cap.
export async function acs(party) {
  const off = (await api('/v2/state/ledger-end')).data?.offset;
  if (typeof off !== 'number') throw new Error('ledger unreachable');
  const parts = await Promise.all(TEMPLATES.map(async (tpl) => {
    const r = await api('/v2/state/active-contracts', { method: 'POST', json: {
      // `eventFormat`, not the `filter`/`verbose` pair Canton 3.4 nodes reject by default.
      eventFormat: { verbose: true, filtersByParty: { [party]: { cumulative: [{ identifierFilter: {
        TemplateFilter: { value: { templateId: templateId(tpl), includeCreatedEventBlob: false } } } }] } } },
      activeAtOffset: off } });
    if (!Array.isArray(r.data)) throw new Error(`active-contracts ${tpl}: ${JSON.stringify(r.data).slice(0, 160)}`);
    return r.data.map((x) => x.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean)
      .map((e) => ({ cid: e.contractId, tpl, arg: e.createArgument }));
  }));
  return { offset: off, contracts: parts.flat() };
}

let seq = 0;
// `readAs` lets a member of a decentralized party read what that party sees, the
// way a node hosting it does (BitSafe governance flows need it).
export async function submit(actAs, command, readAs = []) {
  const commandId = `talang-${Date.now()}-${seq++}`;
  for (let i = 0; i < 4; i++) {
    const r = await api('/v2/commands/submit-and-wait-for-transaction', { method: 'POST', base: PARTY_LEDGERS[actAs] ?? LEDGER, json: {
      commands: { userId: USER, commandId, actAs: [actAs], readAs, commands: [command] } } });
    if (r.ok) return r.data;
    const msg = `submit ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`;
    if (![409, 429, 500, 502, 503, 504].includes(r.status) || /DUPLICATE_COMMAND/.test(msg)) throw new Error(msg);
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw new Error('submit gave up after retries');
}

// Contract id of the first created event whose template ends with `tpl`.
export const created = (tx, tpl) => (tx?.transaction?.events ?? []).map((e) => e.CreatedEvent).filter(Boolean)
  .find((c) => c.templateId?.endsWith(`:${MODULE[tpl]}:${tpl}`))?.contractId;

export const create = (tpl, args) => ({ CreateCommand: { templateId: templateId(tpl), createArguments: args } });
export const exercise = (tpl, cid, choice, arg = {}) =>
  ({ ExerciseCommand: { templateId: templateId(tpl), contractId: cid, choice, choiceArgument: arg } });

// Choices that may unwind or settle a CIP-0056 allocation take the registry's
// off-ledger context per allocation; desk-issued legs need none.
export const NO_CONTEXTS = [];
// A Locked value in the Daml-LF JSON encoding.
export const escrowed = (escrowCid) => ({ tag: 'Escrowed', value: { escrowCid } });
export const allocated = (allocCid) => ({ tag: 'Allocated', value: { allocCid } });
