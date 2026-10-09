// Wallet panel: who the wallet is and on which network, what it can do on this desk, and a fee
// payment built only on standard token operations, so it also works from Grofty's participant.
// Recipients come from /api/config `walletRecipients` ({ testnet?, mainnet? }); nothing is assumed.
import { wallet } from '/wallet.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// One-line hints for errors Grofty documents; the error itself is always shown verbatim.
const HINTS = [
  [/USDCX_ONBOARDING_REQUIRED/, 'Onboard USDCx in your wallet first, then retry.'],
  [/USDCX_PREAPPROVAL_REQUIRED/, 'Set up the USDCx transfer preapproval in your wallet first, then retry.'],
  [/\b4001\b|reject/i, 'You declined the request in the wallet.'],
  [/\b4100\b|unauthori[sz]ed/i, 'Unlock the wallet and reconnect this page.'],
  [/-32601|method not found/i, 'This wallet build does not support the call (Grofty needs 2.0.4 or newer).'],
  [/-32603/, 'The wallet failed or the approval timed out (Grofty waits 180 s).'],
  [/insufficient|fund/i, 'The wallet needs the token and some CC for fees.'],
];
export const describe = (err) => {
  const raw = [err?.code, err?.message ?? String(err), err?.data && JSON.stringify(err.data)].filter((x) => x != null && x !== '').join(' · ');
  return { raw, hint: HINTS.find(([re]) => re.test(raw))?.[1] ?? '' };
};
// The wallet reports a CAIP-2 id such as canton:da-mainnet; the desk keys recipients by net.
export const netOf = (id) => (/testnet/i.test(id ?? '') ? 'testnet' : /mainnet/i.test(id ?? '') ? 'mainnet' : null);

export async function show(w = wallet) {
  const cfg = await (await fetch('/api/config')).json();
  const deskRole = Object.entries(cfg.parties ?? {}).find(([, v]) => v === w.party)?.[0];
  const bound = Object.entries(cfg.walletRoles ?? {}).filter(([, v]) => v === w.party).map(([r]) => r);
  const net = netOf(w.networkId);
  const to = net && cfg.walletRecipients?.[net];
  let el = document.getElementById('wallet-pay');
  if (!el) {
    el = document.createElement('section');
    el.id = 'wallet-pay';
    el.className = 'banner';
    el.style.cssText = 'background:transparent;border-color:currentColor;color:inherit';
    document.getElementById('view').before(el);
  }
  el.innerHTML = `
    <p><b>Wallet on ${esc(w.networkId ?? 'an unreported network')}</b> · <code>${esc(w.party)}</code></p>
    <p>${deskRole ? `This party is the desk's ${esc(deskRole)}, so the wallet signs and submits its Talang commands itself.`
      : bound.length ? `This wallet drives ${esc(bound.join(', '))}: the desk submits ${bound.length > 1 ? 'their' : 'its'} commands only with this wallet's signature on each exact command.`
      : `This wallet's participant does not host Talang's contracts (Grofty only runs standard token packages), so Talang commands stay with the desk and the wallet is used for payments only.`}</p>
    <p>Pay the venue fee from the wallet: a plain token transfer on <b>${esc(net ?? w.networkId ?? 'this network')}</b>, not tied to a repo contract.</p>
    <p>
      <input id="wp-amount" type="number" min="0" step="any" placeholder="amount" aria-label="Amount" style="width:8em">
      <select id="wp-token" aria-label="Token"><option value="USDCX">USDCx</option><option value="CC">CC</option></select>
      <button id="wp-pay" class="ghost wallet" type="button" ${to ? '' : 'disabled'}>Pay venue fee on ${esc(net ?? 'this network')}</button>
    </p>
    <p id="wp-out">${!net ? `The desk pays only on Canton TestNet or MainNet; the wallet reports ${esc(w.networkId ?? 'no network')}.`
      : !to ? `The venue has no ${esc(net)} party configured (walletRecipients.${esc(net)}), so there is nowhere to pay on ${esc(net)} yet.`
      : `Pays ${esc(to)} on ${esc(net)}.`}</p>`;
  el.querySelector('#wp-pay').onclick = async (e) => {
    const out = el.querySelector('#wp-out');
    const amount = el.querySelector('#wp-amount').value;
    const tokenSymbol = el.querySelector('#wp-token').value;
    if (!(Number(amount) > 0)) return (out.textContent = 'Enter an amount above zero.');
    e.target.disabled = true;
    out.textContent = `Waiting for the wallet to approve and submit on ${net}…`;
    try {
      const { tx } = await w.pay({ receiver: to, amount, tokenSymbol });
      const id = tx?.payload?.updateId;
      // ponytail: no explorer link, none with a public URL scheme is documented; add one when Grofty names it.
      out.innerHTML = id
        ? `Paid on <b>${esc(w.networkId)}</b>: ${esc(amount)} ${esc(tokenSymbol)} to <code>${esc(to)}</code>, update id <code>${esc(id)}</code>`
        : `The wallet answered without an update id: <code>${esc(JSON.stringify(tx))}</code>`;
    } catch (err) {
      const { raw, hint } = describe(err);
      out.innerHTML = `<b>${esc(raw)}</b>${hint ? ' ' + esc(hint) : ''}`;
    } finally { e.target.disabled = false; }
  };
}
