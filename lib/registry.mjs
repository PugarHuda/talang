// Off-ledger API of a CIP-0056 registry. Public, no auth. Every answer carries
// `disclosedContracts`, which the submit that uses it must pass on to the ledger.
//
// A registry is named by its base URL, the part before `/registry/...`:
//   DA Utility (CBTC, USDCx): https://api.utilities.digitalasset-dev.com/api/token-standard/v0/registrars/<admin>
//   Canton Coin (Amulet):     a Scan, e.g. https://scan.sv-1.dev.global.canton.network.sync.global
//                             (Scan serves /registry/... at its root; /api/scan/... is IP-allowlisted)
const HOST = (process.env.REGISTRY_URL ?? 'https://api.utilities.digitalasset-dev.com').replace(/\/$/, '');
export const utilityBase = (admin, host = HOST) => `${host}/api/token-standard/v0/registrars/${encodeURIComponent(admin)}`;

async function call(url, json) {
  const r = await fetch(url, { method: json ? 'POST' : 'GET', headers: json ? { 'content-type': 'application/json' } : {},
    body: json ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`registry ${r.status} ${url}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// Ledger API wants only these four fields of a disclosed contract.
export const disclosed = (cs) => cs.map(({ templateId, contractId, createdEventBlob, synchronizerId }) =>
  ({ templateId, contractId, createdEventBlob, synchronizerId }));

// The registry at `baseUrl` (no trailing `/registry`).
export function registry(baseUrl) {
  const b = baseUrl.replace(/\/$/, '');
  return {
    // -> { adminId, supportedApis }
    info: () => call(`${b}/registry/metadata/v1/info`),
    // -> { id, name, symbol, decimals, ... }
    instrument: (id) => call(`${b}/registry/metadata/v1/instruments/${encodeURIComponent(id)}`),
    // args: AllocationFactory_Allocate choice arguments with extraArgs left empty.
    // -> { factoryId, choiceContext: { choiceContextData, disclosedContracts } }
    allocationFactory: (args) =>
      call(`${b}/registry/allocation-instruction/v1/allocation-factory`, { choiceArguments: args, excludeDebugFields: true }),
    // kind: 'execute-transfer' | 'withdraw' | 'cancel' -> { choiceContextData, disclosedContracts }
    allocationContext: (allocationId, kind) =>
      call(`${b}/registry/allocations/v1/${encodeURIComponent(allocationId)}/choice-contexts/${kind}`, { meta: {} }),
    // kind: 'accept' | 'reject' | 'withdraw' -> { choiceContextData, disclosedContracts }
    // The path is singular `transfer-instruction` (transfer-instruction-v1.yaml).
    transferInstructionContext: (instructionId, kind) =>
      call(`${b}/registry/transfer-instruction/v1/${encodeURIComponent(instructionId)}/choice-contexts/${kind}`, { meta: {} }),
  };
}

// The original admin-keyed helpers (DA Utility host), used by scripts/cbtc-rail.mjs.
export const allocationFactory = (admin, args) => registry(utilityBase(admin)).allocationFactory(args);
export const allocationContext = (admin, allocationId, kind) => registry(utilityBase(admin)).allocationContext(allocationId, kind);
export const transferInstructionContext = (admin, instructionId, kind) =>
  registry(utilityBase(admin)).transferInstructionContext(instructionId, kind);
