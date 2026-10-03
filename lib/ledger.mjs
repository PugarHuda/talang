// JSON Ledger API client shared by the seed script, the local desk server and the
// hosted read-only proxy. The bearer token is fetched and held server-side only.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
export const PKG = '#talang-desk';
export const PARTIES = (() => {
  try { return JSON.parse(env('TALANG_PARTIES')); } catch {}
  return JSON.parse(readFileSync(join(ROOT, 'parties.json'), 'utf8'));
})();

export const TEMPLATES = ['Holding', 'Escrow', 'Mark', 'RepoRFQ', 'RepoQuote', 'RepoTrade',
  'MarginCall', 'Substitution', 'RepoReport'];

async function fetchT(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(timer); }
}

let tok = null, tokExp = 0;
async function token() {
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

export async function api(path, { method = 'GET', json } = {}) {
  const r = await fetchT(LEDGER + path, { method,
    headers: { authorization: `Bearer ${await token()}`, ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined });
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
      filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: {
        TemplateFilter: { value: { templateId: `${PKG}:Talang:${tpl}`, includeCreatedEventBlob: false } } } }] } } },
      verbose: true, activeAtOffset: off } });
    if (!Array.isArray(r.data)) throw new Error(`active-contracts ${tpl}: ${JSON.stringify(r.data).slice(0, 160)}`);
    return r.data.map((x) => x.contractEntry?.JsActiveContract?.createdEvent).filter(Boolean)
      .map((e) => ({ cid: e.contractId, tpl, arg: e.createArgument }));
  }));
  return { offset: off, contracts: parts.flat() };
}

let seq = 0;
export async function submit(actAs, command) {
  const commandId = `talang-${Date.now()}-${seq++}`;
  for (let i = 0; i < 4; i++) {
    const r = await api('/v2/commands/submit-and-wait-for-transaction', { method: 'POST', json: {
      commands: { userId: USER, commandId, actAs: [actAs], commands: [command] } } });
    if (r.ok) return r.data;
    const msg = `submit ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`;
    if (![409, 429, 500, 502, 503, 504].includes(r.status) || /DUPLICATE_COMMAND/.test(msg)) throw new Error(msg);
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw new Error('submit gave up after retries');
}

// Contract id of the first created event whose template ends with `tpl`.
export const created = (tx, tpl) => (tx?.transaction?.events ?? []).map((e) => e.CreatedEvent).filter(Boolean)
  .find((c) => c.templateId?.endsWith(`:Talang:${tpl}`))?.contractId;

export const create = (tpl, args) => ({ CreateCommand: { templateId: `${PKG}:Talang:${tpl}`, createArguments: args } });
export const exercise = (tpl, cid, choice, arg = {}) =>
  ({ ExerciseCommand: { templateId: `${PKG}:Talang:${tpl}`, contractId: cid, choice, choiceArgument: arg } });
