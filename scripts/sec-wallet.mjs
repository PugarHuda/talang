// Regression for api/wallet-verify.mjs: replay, command binding, foreign keys, forged action
// lines and the challenge bound. No ledger needed (submit is stubbed).
//   ENV_FILE=.env.local node scripts/sec-wallet.mjs
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

const key = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64') };
};
const me = key(), other = key();
const { fingerprint } = await import('../api/wallet-verify.mjs?probe');
const party = `wallet::${await fingerprint(me.pub)}`;
process.env.TALANG_WALLET_ROLES = JSON.stringify({ lenderB: party });
const { walletSubmit } = await import('../api/wallet-verify.mjs');

let submitted = 0;
const submit = async () => (submitted++, { transaction: { updateId: 'u', events: [] } });
const cmd = (choice = 'WithdrawQuote', cid = '00aa') => ({ ExerciseCommand: { templateId: '#talang-repo:Talang:RepoQuote', contractId: cid, choice, choiceArgument: {} } });
const auth = (message, k = me, p = party) => ({ message, partyId: p, publicKey: k.pub, signature: sign(null, Buffer.from(message), k.privateKey).toString('base64') });
const challengeFor = async (c) => (await walletSubmit('lenderB', c, undefined, submit))[1].walletChallenge;

// signed once: goes through; replayed: refused
let m = await challengeFor(cmd());
assert.equal((await walletSubmit('lenderB', cmd(), auth(m), submit))[0], 200);
assert.equal((await walletSubmit('lenderB', cmd(), auth(m), submit))[0], 401, 'replay must fail');
// a signature over one command does not authorise another
m = await challengeFor(cmd());
assert.equal((await walletSubmit('lenderB', cmd('WithdrawQuote', '00bb'), auth(m), submit))[0], 401, 'command swap must fail');
// the right message signed by a key that is not the party's
m = await challengeFor(cmd());
assert.equal((await walletSubmit('lenderB', cmd(), auth(m, other), submit))[0], 403, 'foreign key must fail');
// someone else's key claiming this party id
m = await challengeFor(cmd());
assert.equal((await walletSubmit('lenderB', cmd(), { ...auth(m, other), partyId: party }, submit))[0], 403);
// a choice name with a newline cannot add a line the wallet shows (e.g. a forged nonce)
m = await challengeFor(cmd('WithdrawQuote\nnonce: forged'));
assert.equal(m.split('\n').filter((l) => l.startsWith('nonce: ')).length, 1, 'forged nonce line');
// garbage auth does not throw
assert.equal((await walletSubmit('lenderB', cmd(), { message: 42 }, submit))[0], 400);
// the challenge store is bounded: 1500 unsigned asks, the first is evicted
const first = await challengeFor(cmd());
for (let i = 0; i < 1500; i++) await challengeFor(cmd());
assert.equal((await walletSubmit('lenderB', cmd(), auth(first), submit))[0], 401, 'challenge store unbounded');
assert.equal(submitted, 1);
console.log('sec-wallet: all checks pass');
