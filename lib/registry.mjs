// Off-ledger API of a CIP-0056 registry run on the DA Utility (CBTC on DevNet).
// Public, no auth. Every answer carries `disclosedContracts`, which the submit
// that uses it must pass on to the ledger.
const HOST = (process.env.REGISTRY_URL ?? 'https://api.utilities.digitalasset-dev.com').replace(/\/$/, '');
const base = (admin) => `${HOST}/api/token-standard/v0/registrars/${encodeURIComponent(admin)}`;

async function post(url, json) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(json), signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`registry ${r.status} ${url.replace(HOST, '')}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// Ledger API wants only these four fields of a disclosed contract.
export const disclosed = (cs) => cs.map(({ templateId, contractId, createdEventBlob, synchronizerId }) =>
  ({ templateId, contractId, createdEventBlob, synchronizerId }));

// args: AllocationFactory_Allocate choice arguments with extraArgs left empty.
// -> { factoryId, choiceContext: { choiceContextData, disclosedContracts } }
export const allocationFactory = (admin, args) =>
  post(`${base(admin)}/registry/allocation-instruction/v1/allocation-factory`, { choiceArguments: args, excludeDebugFields: true });

// kind: 'execute-transfer' | 'withdraw' | 'cancel' -> { choiceContextData, disclosedContracts }
export const allocationContext = (admin, allocationId, kind) =>
  post(`${base(admin)}/registry/allocations/v1/${encodeURIComponent(allocationId)}/choice-contexts/${kind}`, { meta: {} });

// kind: 'accept' | 'reject' | 'withdraw' -> { choiceContextData, disclosedContracts }
// The path is singular `transfer-instruction` (transfer-instruction-v1.yaml).
export const transferInstructionContext = (admin, instructionId, kind) =>
  post(`${base(admin)}/registry/transfer-instruction/v1/${encodeURIComponent(instructionId)}/choice-contexts/${kind}`, { meta: {} });
