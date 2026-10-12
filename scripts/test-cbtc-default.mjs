// Offline check of scripts/cbtc-default.mjs PHASE=default against a fake ledger and
// registry (no network, no sandbox). The fake allocation is visible to the borrower
// only, as the DA Utility DvpLegAllocation is on DevNet: the default must pass it as a
// disclosed contract or the fake ledger answers CONTRACT_NOT_FOUND (the 2026-10-12 failure).
//   node scripts/test-cbtc-default.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (!process.env.CBTC_MOCK) {
  const me = fileURLToPath(import.meta.url);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(me).href, join(me, '..', 'cbtc-default.mjs')], {
    cwd: mkdtempSync(join(tmpdir(), 'cbtc-default-')), encoding: 'utf8',
    env: { ...process.env, CBTC_MOCK: '1', PHASE: 'default', ENV_FILE: 'none', DEVNET_LEDGER_URL: 'http://mock', DEVNET_TOKEN_URL: '',
      LEDGER_HMAC_SECRET: '', LEDGER_USER_ID: 'u', PARTY_LEDGERS: '{}', TALANG_PARTIES: '{"lenderA":"A::1","borrower":"B::1","agent":"G::1"}' } });
  process.stdout.write(r.stdout + r.stderr);
  if (r.status !== 0 || !/default: 0\.001 CBTC executed/.test(r.stdout)) { console.error('✗ cbtc-default phase 2 mock failed'); process.exit(1); }
  console.log('✓ cbtc-default phase 2 mock passed');
  process.exit(0);
}
const ADMIN = 'cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff';
const P = JSON.parse(process.env.TALANG_PARTIES);
const ALLOC = 'alloc1', past = new Date(Date.now() - 3 * 3600e3).toISOString();
let defaulted = false;
globalThis.__submits = [];
const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const ce = (o) => ({ contractEntry: { JsActiveContract: { synchronizerId: 'sync::1', createdEvent: o } } });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url); const body = opts.body ? JSON.parse(opts.body) : null;
  if (url.endsWith('/v2/state/ledger-end')) return ok({ offset: 10 });
  if (url.includes('/choice-contexts/execute-transfer')) return ok({ choiceContextData: { values: {} },
    disclosedContracts: [{ templateId: 'x:Utility.Registry:Rules', contractId: 'rules1', createdEventBlob: 'b', synchronizerId: 'sync::1', debug: 1 }] });
  if (url.endsWith('/v2/state/active-contracts')) {
    const [party, f] = Object.entries(body.eventFormat.filtersByParty)[0];
    const flt = f.cumulative[0].identifierFilter;
    const tpl = flt.TemplateFilter?.value.templateId, iface = flt.InterfaceFilter?.value.interfaceId;
    if (tpl?.endsWith(':RepoTrade')) return ok(defaulted ? [] : [ce({ contractId: 'trade1', createArgument: { terms: { principal: '51.25', termDays: '2' },
      collateral: [{ tag: 'Allocated', value: { allocCid: ALLOC } }] } })]);
    if (tpl?.endsWith(':MarginCall')) return ok(defaulted ? [] : [ce({ contractId: 'call1', createArgument: { lender: P.lenderA, borrower: P.borrower,
      instrument: 'CBTC', issuer: ADMIN, tradeCid: 'trade1', respondBy: past, unitsDue: '0.0001', price: '52000' } })]);
    if (iface?.includes('AllocationV1')) {
      if (party !== P.borrower || defaulted) return ok([]);   // lender A is no stakeholder
      return ok([ce({ contractId: ALLOC, templateId: 'pkg:Utility.Registry.V0.Holding.Allocation:DvpLegAllocation',
        createdEventBlob: flt.InterfaceFilter.value.includeCreatedEventBlob ? 'BLOB' : '',
        interfaceViews: [{ viewValue: { allocation: { settlement: { settleBefore: new Date(Date.now() + 5 * 864e5).toISOString() } } } }] })]);
    }
    if (iface?.includes('HoldingV1')) return ok(party === P.lenderA && defaulted ? [ce({ contractId: 'h', templateId: 't',
      interfaceViews: [{ viewValue: { owner: P.lenderA, instrumentId: { admin: ADMIN, id: 'CBTC' }, lock: null, amount: '0.001' } }] })] : []);
    return ok([]);
  }
  if (url.endsWith('/v2/commands/submit-and-wait-for-transaction')) {
    const dc = body.commands.disclosedContracts ?? [];
    __submits.push(body);
    if (!dc.some((d) => d.contractId === ALLOC && d.createdEventBlob === 'BLOB' && d.synchronizerId === 'sync::1'))
      return new Response(JSON.stringify({ code: 'CONTRACT_NOT_FOUND' }), { status: 404 });
    defaulted = true;
    return ok({ transaction: { updateId: 'u1', offset: 11, events: [] } });
  }
  throw new Error('unexpected fetch ' + url);
};
