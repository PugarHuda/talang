// CIP-0103 wallet connection (Grofty, Loop or any wallet implementing the Canton
// dApp API). Once connected, commands for the wallet's own party are signed and
// submitted by the wallet, not by the desk server's token: the hosted read-only
// copy can then act, because the key never touches it.
// ponytail: loads the official SDK on first use; built against @canton-network/dapp-sdk
// 1.4.0's documented API, not yet run with a live wallet.
const SDK = 'https://esm.sh/@canton-network/dapp-sdk@1.4.0';
let sdk = null;

export const wallet = {
  party: null,
  async connect() {
    sdk ??= await import(SDK);
    const r = await sdk.connect();
    if (r && r.isConnected === false) throw new Error('wallet did not connect');
    const accounts = await sdk.listAccounts();
    if (!accounts?.length) throw new Error('the wallet has no Canton account');
    this.party = accounts[0].partyId;
    return this.party;
  },
  // Same command shape the desk server submits (JSON Ledger API v2).
  submit(command) {
    if (!this.party) throw new Error('no wallet connected');
    return sdk.prepareExecuteAndWait({ commands: [command] });
  },
};
