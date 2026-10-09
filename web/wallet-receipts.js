// "Signed by a wallet key": receipts of desk commands a bound wallet signed (a lender's sealed
// quote, a borrower's award), listed for the acting role when the ledger lets it see them.
// Each one can be re-checked by the desk: signature under the wallet's key, key owns the party.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const line = (msg, key) => new RegExp(`^${key}: (.*)$`, 'm').exec(msg)?.[1] ?? '';

let list = [], on = false;
async function render() {
  if (!on) return;
  const role = document.getElementById('role')?.value;
  const r = role && await post('/api/wallet-receipts', { role }).catch(() => null);
  // The hosted read-only copy has no receipts endpoint; nothing to show there.
  list = r?.ok ? await r.json() : [];
  let el = document.getElementById('wallet-receipts');
  if (!list.length) return el?.remove();
  if (!el) {
    el = document.createElement('section');
    el.id = 'wallet-receipts';
    el.className = 'banner';
    el.style.cssText = 'background:transparent;border-color:currentColor;color:inherit';
    document.getElementById('view').before(el);
  }
  el.innerHTML = `<p><b>Signed by a wallet key</b>: these commands reached the ledger only because the wallet that drives the role signed them; the desk never holds that key.</p>`
    + list.map((x, i) => `<p><code>${esc(line(x.message, 'action'))}</code> · ${esc(x.role)} · signer <code>${esc(x.signer)}</code>
      · update <code>${esc(x.updateId ?? '?')}</code>
      ${x.created.map((c) => `· created ${esc(c.templateId.split(':').pop())} <code>${esc(c.contractId.slice(0, 16))}…</code>`).join(' ')}
      <button class="ghost wallet" type="button" data-verify="${i}">Verify signature</button> <span id="wr-${i}"></span></p>`).join('');
}

addEventListener('click', async (e) => {
  const i = e.target.closest?.('[data-verify]')?.dataset.verify;
  if (i === undefined) return;
  const x = list[i], out = document.getElementById('wr-' + i);
  out.textContent = 'checking…';
  const v = await (await post('/api/wallet-verify', { message: x.message, signature: x.signature, publicKey: x.publicKey, partyId: x.signer })).json();
  out.textContent = v.ok ? `valid: the signature verifies and the key's fingerprint is ${x.signer.split('::')[0]}'s namespace` : `not valid: ${v.reason}`;
});
addEventListener('wallet:signed', render);
document.getElementById('role')?.addEventListener('change', render);
// Only a desk with wallet-driven roles has receipts. ponytail: first render waits for app.js to settle the role.
fetch('/api/config').then((r) => r.json()).then((c) => (on = !!c.walletRoles) && setTimeout(render, 1500)).catch(() => {});
