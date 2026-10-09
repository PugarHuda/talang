// CIP-0103 wallet connection through the official @canton-network/dapp-sdk (Grofty, Loop or any
// wallet the SDK's picker finds). What a wallet can do here:
// - sign Talang commands itself, only when its party is one of the desk's parties, i.e. its
//   participant hosts the talang-repo package (a generic CIP-0103 wallet on our own node);
// - drive a desk role it is bound to (TALANG_WALLET_ROLES) from any network, Grofty TestNet
//   included: the desk submits that role's commands on its own ledger only with this wallet's
//   signMessage signature over each exact command (api/wallet-verify.mjs checks it);
// - pay with standard tokens (CC, USDCx), which is all Grofty's participant can execute:
//   it runs the standard Canton / token-standard packages, not third-party DARs.
// ponytail: SDK loaded from esm.sh on first use; not yet run against a live wallet.
const SDK = 'https://esm.sh/@canton-network/dapp-sdk@1.7.1';
let sdk = null;

// The npm 1.7.1 build exposes getPrimaryAccount / getActiveNetwork / signMessage on the CIP-0103
// provider only; the current docs also list them on the SDK. Use whichever exists.
const rpc = async (method, params) => (typeof sdk[method] === 'function' ? sdk[method](params)
  : sdk.getConnectedProvider().request(params === undefined ? { method } : { method, params }));

export const wallet = {
  party: null,
  publicKey: null,
  networkId: null,
  async connect() {
    // ponytail: test seam, a page may preset a fake SDK object; real pages never set it.
    sdk ??= globalThis.TALANG_WALLET_SDK ?? (await import(SDK));
    const r = await sdk.connect();
    if (r && r.isConnected === false) throw new Error(r.reason ?? 'wallet did not connect');
    const account = await rpc('getPrimaryAccount').catch(async () => (await sdk.listAccounts()).find((a) => a.primary));
    if (!account?.partyId) throw new Error('the wallet has no primary Canton account');
    const net = await rpc('getActiveNetwork').catch(() => null);
    this.party = account.partyId;
    this.publicKey = account.publicKey ?? null;
    this.networkId = net?.networkId ?? account.networkId ?? null;
    import('/wallet-pay.js').then((m) => m.show(this)).catch((e) => console.error('wallet panel', e));
    return this.party;
  },
  // CIP-0103 signMessage with the primary account's key. The spec answers { signature }; older
  // Grofty builds answered a bare string.
  async sign(message) {
    if (!this.party) throw new Error('no wallet connected');
    const r = await rpc('signMessage', { message });
    const signature = typeof r === 'string' ? r : r?.signature;
    if (!signature) throw new Error('the wallet returned no signature');
    return signature;
  },
  // Talang command, same shape the desk server submits (JSON Ledger API v2). The caller only uses
  // this when the wallet's party is a desk party; Grofty would refuse the unknown package.
  submit(command) {
    if (!this.party) throw new Error('no wallet connected');
    return sdk.prepareExecuteAndWait({ commands: [command] });
  },
  // The desk's /api/submit. For a role bound to a wallet the desk answers 401 with a challenge
  // naming the exact command; this wallet signs it and the command goes again with the signature.
  async deskSubmit(role, command) {
    const send = async (extra) => {
      const r = await fetch('/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role, command, ...extra }) });
      return [r, await r.json().catch(() => ({}))];
    };
    let [r, j] = await send();
    if (r.status === 401 && j.walletChallenge) {
      if (!this.party) throw new Error(`${j.error}. Connect that wallet first.`);
      const signature = await this.sign(j.walletChallenge);
      [r, j] = await send({ walletAuth: { message: j.walletChallenge, signature, publicKey: this.publicKey, partyId: this.party } });
      if (r.ok) dispatchEvent(new Event('wallet:signed'));
    }
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  },
  // Plain token transfer, Grofty's documented transfer shape. Resolves { tx } with tx.payload.updateId.
  pay({ receiver, amount, tokenSymbol }) {
    if (!this.party) throw new Error('no wallet connected');
    return sdk.prepareExecuteAndWait({ receiver, amount: String(amount), tokenSymbol });
  },
};

// Receipts of wallet-signed commands, shown to the roles the ledger lets see them.
if (typeof document !== 'undefined') import('/wallet-receipts.js').catch((e) => console.error('wallet receipts', e));
