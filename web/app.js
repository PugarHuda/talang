// Talang desk. Every number shown is read from the acting role's own view of the
// ledger; every action is a Daml command the contract re-checks.
import { wallet } from '/wallet.js';

const $ = (s) => document.querySelector(s);
const PKG = '#talang-repo';
const DAY = 864e5;
let CFG, ROLE, DATA = [], timer;

// ?role=lenderB opens the desk as that role (handy for demo links); otherwise the last one used.
ROLE = new URLSearchParams(location.search).get('role');
try { ROLE ||= localStorage.getItem('talang.role'); } catch {}
ROLE ||= 'borrower';

const N = Number;
const money = (n) => N(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const units = (n) => N(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
const pct = (n) => (N(n) * 100).toFixed(2) + '%';
const when = (t) => new Date(t).toLocaleString();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const roleOf = (party) => Object.entries(CFG.parties).find(([, v]) => v === party)?.[0] ?? party.split('::')[0];
const NAMES = { borrower: 'Borrower', lenderA: 'Lender A', lenderB: 'Lender B', lenderC: 'Lender C', regulator: 'Regulator', agent: 'Agent', venue: 'Venue' };
const LENDERS = ['lenderA', 'lenderB', 'lenderC'];
const name = (party) => esc(NAMES[roleOf(party)] ?? roleOf(party));
const me = () => CFG.parties[ROLE];
const of = (tpl) => DATA.filter((c) => c.tpl === tpl);

const create = (tpl, args) => ({ CreateCommand: { templateId: `${PKG}:Talang:${tpl}`, createArguments: args } });
const exercise = (tpl, cid, choice, arg = {}) =>
  ({ ExerciseCommand: { templateId: `${PKG}:Talang:${tpl}`, contractId: cid, choice, choiceArgument: arg } });
const createdCid = (tx, tpl) => (tx?.transaction?.events ?? []).map((e) => e.CreatedEvent).filter(Boolean)
  .find((c) => c.templateId?.endsWith(`:Talang:${tpl}`))?.contractId;

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}
// A connected CIP-0103 wallet signs for its own party; every other role goes through the desk server.
const viaWallet = (role) => wallet.party && wallet.party === CFG.parties[role];
const act = (command, role = ROLE) => (viaWallet(role) ? wallet.submit(command) : post('/api/submit', { role, command }));
// The hosted copy is read-only unless the acting role is the connected wallet's party.
const canAct = () => !CFG.readOnly || viaWallet(ROLE);
function syncReadOnly() {
  const ro = !canAct();
  document.body.classList.toggle('readonly', ro);
  $('#readonly').hidden = !ro;
}

// ---- money arithmetic, mirrored from the contract so the page can show it ----
function mark(instrument) {
  const m = of('Mark').filter((c) => c.arg.instrument === instrument).sort((a, b) => b.arg.asOf.localeCompare(a.arg.asOf))[0];
  return m && { cid: m.cid, price: N(m.arg.price), asOf: m.arg.asOf, fresh: Date.now() - Date.parse(m.arg.asOf) < DAY };
}
const interest = (principal, rateBps, openedAt) =>
  Math.round(principal * rateBps / 10000 * Math.max(1, Math.floor((Date.now() - Date.parse(openedAt)) / DAY)) / 360 * 100) / 100;
const owed = (t) => N(t.terms.principal) + interest(N(t.terms.principal), N(t.rateBps), t.openedAt);
// The venue's fee on a repo today, collected inside the repurchase or a roll.
const fee = (t) => (t.venue && N(t.venue.feeBps) ? interest(N(t.terms.principal), N(t.venue.feeBps), t.openedAt) : 0);
const tokenLegs = (t) => (t.collateral ?? []).filter((c) => c.tag === 'Allocated').length;
const NO_CONTEXTS = [];
const lendable = (haircut, qty, price) => qty * price * (1 - haircut);

// Positions this role owns outright.
const mine = (instrument, issuer) => of('Holding').filter((c) => c.arg.owner === me()
  && (!instrument || c.arg.instrument === instrument) && (!issuer || c.arg.issuer === issuer));

// A holding of exactly `amount`, splitting a larger one if needed.
async function exact(instrument, issuer, amount) {
  const hs = mine(instrument, issuer).sort((a, b) => N(a.arg.amount) - N(b.arg.amount));
  const hit = hs.find((h) => N(h.arg.amount) === N(amount));
  if (hit) return hit.cid;
  const big = hs.find((h) => N(h.arg.amount) > N(amount));
  if (!big) throw new Error(`you hold no ${units(amount)} ${instrument}: use the demo issuer first`);
  return createdCid(await act(exercise('Holding', big.cid, 'Split', { splitAmount: String(amount) })), 'Holding');
}

// All holdings of one instrument merged into one.
async function merged(instrument, issuer) {
  const [first, ...rest] = mine(instrument, issuer);
  if (!first) throw new Error(`you hold no ${instrument}`);
  let cid = first.cid;
  for (const h of rest) cid = createdCid(await act(exercise('Holding', cid, 'Merge', { other: h.cid })), 'Holding');
  return cid;
}

const faucet = (issuerRole, instrument, amount) => act(create('Holding', {
  issuer: CFG.parties[issuerRole], owner: me(), instrument, amount: String(amount) }), issuerRole);

// ---- views ----
function holdingsCard() {
  const hs = of('Holding').filter((c) => c.arg.owner === me());
  const locked = of('Escrow').filter((c) => c.arg.owner === me());
  const rows = [...hs.map((h) => [h.arg.instrument, h.arg.amount, '<span class="pill mute">free</span>']),
    ...locked.map((e) => [e.arg.instrument, e.arg.amount, `<span class="pill warn">locked for ${name(e.arg.counterparty)}</span>`])];
  return `<h2>Positions</h2><div class="card">${rows.length ? `<table><tr><th>Instrument</th><th>Amount</th><th></th></tr>
    ${rows.map(([i, a, s]) => `<tr><td>${esc(i)}</td><td>${units(a)}</td><td>${s}</td></tr>`).join('')}</table>`
    : '<p class="empty">No positions.</p>'}</div>`;
}

function tradeCard(t, actions) {
  const a = t.arg, m = mark(a.collateralInstrument), o = owed(a);
  const cover = m ? lendable(N(a.haircut), N(a.collateralQty), m.price) / o : null;
  const pill = cover == null ? '<span class="pill mute">no mark</span>'
    : cover >= 1 ? `<span class="pill ok">covered ${pct(cover)}</span>` : `<span class="pill bad">short ${pct(cover)}</span>`;
  const late = Date.now() > Date.parse(a.maturity);
  return `<div class="card"><h3>${money(a.terms.principal)} USDC against ${units(a.collateralQty)} ${esc(a.collateralInstrument)} ${pill}</h3>
    <div class="row"><span>Funded by <b>${name(a.lender)}</b></span><span>Rate <b>${N(a.rateBps)} bp</b></span>
    <span>Haircut <b>${pct(a.haircut)}</b></span><span>Owed now <b>${money(o)}</b></span>
    ${a.venue ? `<span>Venue fee <b>${money(fee(a))}</b> <small>(${N(a.venue.feeBps)} bp)</small></span>` : ''}
    ${tokenLegs(a) ? `<span><span class="pill ok">${tokenLegs(a)} CIP-0056 allocation${tokenLegs(a) > 1 ? 's' : ''}</span></span>` : ''}
    <span>Mark <b>${m ? money(m.price) + (m.fresh ? '' : ' (stale)') : '—'}</b></span>
    <span>Opened <b>${when(a.openedAt)}</b></span><span>Matures <b>${when(a.maturity)}</b>${late ? ' <span class="pill bad">past</span>' : ''}</span></div>
    ${cover == null ? '' : meter(cover)}
    <div class="actions">${actions}</div></div>`;
}

// Coverage of what is owed by the collateral's lendable value; the bar tops out at 150%.
const meter = (cover) => `<div class="meter ${cover >= 1 ? 'ok' : 'bad'}" role="img" aria-label="Coverage ${pct(cover)}">
  <span style="width:${Math.min(cover / 1.5, 1) * 100}%"></span><i style="left:${100 / 1.5}%"></i></div>`;

function borrowerView() {
  const rfqs = of('RepoRFQ'), quotes = of('RepoQuote'), trades = of('RepoTrade');
  const calls = of('MarginCall'), subs = of('Substitution');
  const instruments = [...new Set(of('Mark').map((m) => m.arg.instrument))];
  let h = !canAct() ? '' : `<h2>New request</h2><div class="card"><div class="form">
    <label>Collateral<select class="in" id="n-inst">${instruments.map((i) => `<option>${esc(i)}</option>`).join('')}</select></label>
    <label>Units<input id="n-qty" type="number" value="50" /></label>
    <label>Cash wanted (USDC)<input id="n-cash" type="number" value="4800000" /></label>
    <label>Term (days)<input id="n-term" type="number" value="30" /></label>
    <label>Ask<span>${LENDERS.map((l) => `<label style="display:inline;flex-direction:row"><input type="checkbox" class="n-lender" value="${l}" ${l === 'lenderC' ? '' : 'checked'} style="width:auto" /> ${NAMES[l]}</label>`).join(' ')}</span></label>
    <button data-act="request">Send request</button>
    <button class="ghost" data-act="bonds">Demo issuer: give me bonds</button></div></div>`;

  h += `<h2>Requests and sealed quotes</h2>`;
  h += rfqs.length ? rfqs.map((r) => {
    const t = r.arg.terms, m = mark(t.collateralInstrument);
    const qs = quotes.filter((q) => q.arg.rfqId === r.cid)
      .sort((x, y) => N(x.arg.rateBps) - N(y.arg.rateBps) || N(x.arg.haircut) - N(y.arg.haircut));
    return `<div class="card"><h3>${money(t.principal)} USDC against ${units(t.collateralQty)} ${esc(t.collateralInstrument)}, ${esc(t.termDays)} days</h3>
      <div class="row"><span>Asked <b>${r.arg.lenders.map(name).join(', ')}</b></span><span>Mark <b>${m ? money(m.price) : '—'}</b></span>
      ${r.arg.venue ? `<span>Venue fee <b>${N(r.arg.venue.feeBps)} bp</b></span>` : ''}</div>
      <p class="empty" style="margin:6px 0 0">Taking a quote refunds the others unrevealed: each losing lender is told only its rank, and the regulator gets a best-execution record with no names.</p>
      ${qs.length ? `<table><tr><th>#</th><th>Lender</th><th>Rate</th><th>Haircut</th><th>Lends at mark</th><th></th></tr>
      ${qs.map((q, i) => {
        const lend = m ? lendable(N(q.arg.haircut), N(t.collateralQty), m.price) : 0;
        const ok = lend >= N(t.principal);
        return `<tr><td>${i + 1}</td><td>${name(q.arg.lender)}</td><td>${N(q.arg.rateBps)} bp</td><td>${pct(q.arg.haircut)}</td>
          <td>${money(lend)} ${ok ? '' : '<span class="pill bad">short</span>'}</td>
          <td><button data-act="award" data-cid="${q.cid}" data-rfq="${r.cid}" ${ok ? '' : 'disabled'}>Take this quote</button></td></tr>`;
      }).join('')}</table>` : '<p class="empty">No quotes yet.</p>'}
      <div class="actions"><button class="ghost" data-act="cancel" data-cid="${r.cid}">Cancel request</button></div></div>`;
  }).join('') : '<p class="empty">No open requests.</p>';

  h += `<h2>Margin calls</h2>` + (calls.length ? calls.map((c) => `<div class="card"><h3>${name(c.arg.lender)} calls ${units(c.arg.unitsDue)} ${esc(c.arg.instrument)}</h3>
    <div class="row"><span>Owed <b>${money(c.arg.owed)}</b></span><span>At mark <b>${money(c.arg.price)}</b></span>
    <span>Respond by <b>${when(c.arg.respondBy)}</b></span></div>
    <div class="actions"><button data-act="post" data-cid="${c.cid}">Post ${units(c.arg.unitsDue)} ${esc(c.arg.instrument)}</button>
    <button class="ghost" data-act="bonds-for" data-inst="${esc(c.arg.instrument)}" data-amount="${c.arg.unitsDue}">Demo issuer: give me the bonds</button></div></div>`).join('')
    : '<p class="empty">None.</p>');

  const rolls = of('RollOffer');
  h += `<h2>Roll offers</h2>` + (rolls.length ? rolls.map((o) => {
    const t = trades.find((x) => x.cid === o.arg.tradeCid);
    const now = t ? owed(t.arg) - N(t.arg.terms.principal) + fee(t.arg) : null;
    return `<div class="card"><h3>${name(o.arg.lender)} offers to extend ${t ? `${money(t.arg.terms.principal)} ${esc(t.arg.terms.cashInstrument)}` : 'a repo'} by ${esc(o.arg.extraDays)} days at ${N(o.arg.newRateBps)} bp</h3>
      <div class="row">${t ? `<span>Now at <b>${N(t.arg.rateBps)} bp</b></span><span>Pay today <b>${money(now)}</b> (interest so far${t.arg.venue ? ' + venue fee' : ''})</span>` : '<span class="pill mute">repo changed since the offer</span>'}
      <span>Offer expires <b>${when(o.arg.expiresAt)}</b></span></div>
      <div class="actions"><button data-act="roll" data-cid="${o.cid}" ${t ? '' : 'disabled'}>Accept roll</button></div></div>`;
  }).join('') : '<p class="empty">None.</p>');

  h += `<h2>Open repos</h2>` + (trades.length ? trades.map((t) => {
    const pending = subs.some((s) => s.arg.tradeCid === t.cid);
    const others = mine().filter((x) => x.arg.instrument !== 'USDC' && x.arg.instrument !== t.arg.collateralInstrument);
    return tradeCard(t, `<button data-act="repurchase" data-cid="${t.cid}">Repurchase for ${money(owed(t.arg) + fee(t.arg))}</button>
      ${pending ? '<span class="pill warn">substitution waiting for lender</span>'
        : others.length ? `<select class="in" id="sub-${t.cid.slice(0, 12)}">${others.map((x) => `<option value="${x.cid}">${units(x.arg.amount)} ${esc(x.arg.instrument)}</option>`).join('')}</select>
          <button class="ghost" data-act="substitute" data-cid="${t.cid}">Offer as substitute</button>` : ''}
      <button class="ghost" data-act="cash">Demo issuer: give me 100k USDC</button>`);
  }).join('') : '<p class="empty">No open repos.</p>');
  return h + holdingsCard();
}

function lenderView() {
  const rfqs = of('RepoRFQ'), quotes = of('RepoQuote'), trades = of('RepoTrade');
  const calls = of('MarginCall'), subs = of('Substitution');
  const rivals = quotes.filter((q) => q.arg.lender !== me()).length;
  let h = `<div class="card proof"><b>Privacy, read from this node:</b> you can see ${quotes.length} quote${quotes.length === 1 ? '' : 's'},
    ${rivals === 0 ? 'all of them your own. Rival quotes never reached you.' : `<span class="pill bad">${rivals} from rivals</span>`}</div>`;

  h += `<h2>Requests you were asked to quote</h2>` + (rfqs.length ? rfqs.map((r) => {
    const t = r.arg.terms, m = mark(t.collateralInstrument);
    const mineQ = quotes.find((q) => q.arg.rfqId === r.cid);
    return `<div class="card"><h3>${name(r.arg.borrower)} wants ${money(t.principal)} USDC against ${units(t.collateralQty)} ${esc(t.collateralInstrument)}, ${esc(t.termDays)} days</h3>
      <div class="row"><span>Mark <b>${m ? money(m.price) : '—'}</b></span><span>Collateral value <b>${m ? money(N(t.collateralQty) * m.price) : '—'}</b></span></div>
      ${mineQ ? `<div class="actions"><span class="pill ok">your sealed quote: ${N(mineQ.arg.rateBps)} bp, ${pct(mineQ.arg.haircut)}</span>
        <button class="ghost" data-act="withdraw" data-cid="${mineQ.cid}">Withdraw</button></div>`
      : `<div class="form" style="margin-top:10px"><label>Rate (bp)<input id="r-${r.cid.slice(0, 12)}" type="number" value="525" /></label>
        <label>Haircut (%)<input id="h-${r.cid.slice(0, 12)}" type="number" step="0.5" value="2" /></label>
        <button data-act="quote" data-cid="${r.cid}">Seal quote, lock ${money(t.principal)} USDC</button>
        <button class="ghost" data-act="cash-for" data-amount="${t.principal}">Demo issuer: give me the cash</button></div>`}</div>`;
  }).join('') : '<p class="empty">No requests.</p>');

  const losses = of('LossNotice');
  h += `<h2>Quotes you lost</h2>` + (losses.length ? `<div class="card"><table><tr><th>When</th><th>Your rank</th><th></th></tr>
    ${losses.map((n) => `<tr><td>${when(n.arg.at)}</td><td>${esc(n.arg.rank)} of ${esc(n.arg.outOf)}</td>
      <td><span class="pill mute">no winning rate, no winner: that is all a loser is told</span></td></tr>`).join('')}</table></div>`
    : '<p class="empty">None.</p>');

  h += `<h2>Substitutions to approve</h2>` + (subs.length ? subs.map((s) => {
    const t = trades.find((x) => x.cid === s.arg.tradeCid), m = mark(s.arg.newInstrument);
    const cover = t && m ? lendable(N(t.arg.haircut), N(s.arg.newQty), m.price) / owed(t.arg) : null;
    return `<div class="card"><h3>${name(s.arg.borrower)} offers ${units(s.arg.newQty)} ${esc(s.arg.newInstrument)}${t ? ` for ${units(t.arg.collateralQty)} ${esc(t.arg.collateralInstrument)}` : ''}</h3>
      <div class="row"><span>Mark <b>${m ? money(m.price) : '—'}</b></span><span>Would cover <b>${cover == null ? '—' : pct(cover)}</b></span></div>
      <div class="actions"><button data-act="approve" data-cid="${s.cid}" ${cover >= 1 && m?.fresh ? '' : 'disabled'}>Approve swap</button>
      <button class="ghost" data-act="decline" data-cid="${s.cid}">Decline</button></div></div>`;
  }).join('') : '<p class="empty">None.</p>');

  h += `<h2>Your margin calls</h2>` + (calls.length ? calls.map((c) => {
    const due = Date.now() > Date.parse(c.arg.respondBy);
    return `<div class="card"><h3>${units(c.arg.unitsDue)} ${esc(c.arg.instrument)} called from ${name(c.arg.borrower)}</h3>
      <div class="row"><span>Respond by <b>${when(c.arg.respondBy)}</b></span></div>
      <div class="actions"><button data-act="default" data-cid="${c.cid}" ${due ? '' : 'disabled'}>${due ? 'Declare default, keep collateral' : 'Borrower still has time'}</button></div></div>`;
  }).join('') : '<p class="empty">None.</p>');

  h += `<h2>Repos you funded</h2>` + (trades.length ? trades.map((t) => {
    const m = mark(t.arg.collateralInstrument);
    const short = m && lendable(N(t.arg.haircut), N(t.arg.collateralQty), m.price) < owed(t.arg);
    const called = calls.some((c) => c.arg.tradeCid === t.cid);
    const late = Date.now() > Date.parse(t.arg.maturity);
    const offered = of('RollOffer').some((o) => o.arg.tradeCid === t.cid), k = t.cid.slice(0, 12);
    return tradeCard(t, `${short && !called ? `<button data-act="call" data-cid="${t.cid}" ${m.fresh ? '' : 'disabled'}>Call margin (24h)</button>` : ''}
      ${late ? `<button data-act="claim" data-cid="${t.cid}">Claim collateral, past maturity</button>`
        : offered ? '<span class="pill warn">roll offered, waiting for the borrower</span>'
        : `<span class="form"><label>Roll at (bp)<input id="ro-r-${k}" type="number" value="${N(t.arg.rateBps) - 15}" /></label>
           <label>Extra days<input id="ro-d-${k}" type="number" value="30" /></label>
           <button class="ghost" data-act="offer-roll" data-cid="${t.cid}">Offer roll</button></span>`}`);
  }).join('') : '<p class="empty">None.</p>');
  return h + holdingsCard();
}

function regulatorView() {
  const reps = of('RepoReport').sort((a, b) => b.arg.at.localeCompare(a.arg.at));
  const bex = of('BestExecution').sort((a, b) => b.arg.at.localeCompare(a.arg.at));
  const seen = DATA.filter((c) => c.tpl !== 'RepoReport' && c.tpl !== 'BestExecution').length;
  return `<div class="card proof"><b>Privacy, read from this node:</b> ${reps.length} lifecycle reports, and
    ${seen === 0 ? 'no request, quote, loss notice or position. Losing rates never reached the regulator.' : `<span class="pill bad">${seen} other contracts</span>`}</div>
    <h2>Best execution</h2><div class="card">${bex.length ? `<table><tr><th>When</th><th>Quotes weighed</th><th>Winner's rank</th><th>Rate taken</th><th>Haircut</th><th>Over best rate</th></tr>
    ${bex.map((b) => `<tr><td>${when(b.arg.at)}</td><td>${esc(b.arg.quotesConsidered)}</td>
      <td>${N(b.arg.winnerRank) === 1 ? '<span class="pill ok">1 · best</span>' : `<span class="pill warn">${esc(b.arg.winnerRank)}</span>`}</td>
      <td>${N(b.arg.winningRateBps)} bp</td><td>${pct(b.arg.winningHaircut)}</td><td>${N(b.arg.spreadToBestBps) ? N(b.arg.spreadToBestBps) + ' bp' : '—'}</td></tr>`).join('')}</table>
      <p class="empty">No lender is named and no losing quote is shown: the regulator learns how price discovery went, not who lost.</p>`
    : '<p class="empty">No awards yet.</p>'}</div>
    <h2>Repo lifecycle reports</h2><div class="card">${reps.length ? `<table><tr><th>When</th><th>Event</th><th>Borrower</th><th>Lender</th>
    <th>Principal</th><th>Rate</th><th>Haircut</th><th>Collateral</th><th>Cash moved</th><th>Venue fee</th></tr>
    ${reps.map((r) => `<tr><td>${when(r.arg.at)}</td><td><span class="pill ${r.arg.event === 'DEFAULT' ? 'bad' : r.arg.event === 'CLOSE' ? 'ok' : r.arg.event === 'ROLL' ? 'warn' : 'mute'}">${esc(r.arg.event)}</span></td>
      <td>${name(r.arg.borrower)}</td><td>${name(r.arg.lender)}</td><td>${money(r.arg.terms.principal)}</td><td>${N(r.arg.rateBps)} bp</td>
      <td>${pct(r.arg.haircut)}</td><td>${units(r.arg.collateralQty)} ${esc(r.arg.collateralInstrument)}</td><td>${N(r.arg.cashMoved) ? money(r.arg.cashMoved) : ''}</td><td>${N(r.arg.feePaid) ? money(r.arg.feePaid) : ''}</td></tr>`).join('')}</table>`
    : '<p class="empty">No reports.</p>'}</div>`;
}

function agentView() {
  const marks = of('Mark').sort((a, b) => b.arg.asOf.localeCompare(a.arg.asOf));
  return (!canAct() ? '' : `<h2>Publish a mark</h2><div class="card"><div class="form">
    <label>Instrument<input id="m-inst" value="GILT10" /></label><label>Price per unit<input id="m-price" type="number" value="96000" /></label>
    <button data-act="mark">Publish to borrower and lenders</button></div></div>`) + `
    <h2>Marks</h2><div class="card"><table><tr><th>Instrument</th><th>Price</th><th>As of</th><th></th></tr>
    ${marks.map((m) => `<tr><td>${esc(m.arg.instrument)}</td><td>${money(m.arg.price)}</td><td>${when(m.arg.asOf)}</td>
      <td>${Date.now() - Date.parse(m.arg.asOf) < DAY ? '<span class="pill ok">fresh</span>' : '<span class="pill mute">stale</span>'}</td></tr>`).join('')}</table></div>`;
}

const venueView = () => `<div class="card emptystate"><h3>No venue screen yet</h3>
  <p class="empty">The operator's fee is collected inside each repurchase and roll; the regulator's lifecycle reports show every fee paid.</p></div>`;
const VIEWS = { borrower: borrowerView, lenderA: lenderView, lenderB: lenderView, lenderC: lenderView, regulator: regulatorView, agent: agentView };

// ---- actions ----
const val = (id) => $(id)?.value;
const ACTIONS = {
  async request() {
    await act(create('RepoRFQ', { borrower: me(), regulator: CFG.parties.regulator, agent: CFG.parties.agent,
      venue: CFG.parties.venue ? { operator: CFG.parties.venue, feeBps: '10.0' } : null,
      lenders: [...document.querySelectorAll('.n-lender:checked')].map((x) => CFG.parties[x.value]), deadline: null, terms: {
        cashIssuer: CFG.parties.cashIssuer, cashInstrument: 'USDC', principal: val('#n-cash'),
        collateralIssuer: CFG.parties.bondIssuer, collateralInstrument: val('#n-inst'),
        collateralQty: val('#n-qty'), termDays: val('#n-term') } }));
    return 'Request sent to the panel';
  },
  async bonds() { await faucet('bondIssuer', val('#n-inst'), val('#n-qty')); return 'Bonds issued to you'; },
  async 'bonds-for'(b) { await faucet('bondIssuer', b.dataset.inst, b.dataset.amount); return 'Bonds issued to you'; },
  async cash() { await faucet('cashIssuer', 'USDC', 100000); return '100,000 USDC issued to you'; },
  async 'cash-for'(b) { await faucet('cashIssuer', 'USDC', b.dataset.amount); return 'Cash issued to you'; },
  async award(b) {
    const rfq = of('RepoRFQ').find((r) => r.cid === b.dataset.rfq), t = rfq.arg.terms;
    const losers = of('RepoQuote').filter((q) => q.arg.rfqId === rfq.cid && q.cid !== b.dataset.cid).map((q) => q.cid);
    const m = mark(t.collateralInstrument);
    if (!m?.fresh) throw new Error('no fresh mark for ' + t.collateralInstrument + ': ask the agent to publish one');
    const col = await exact(t.collateralInstrument, t.collateralIssuer, t.collateralQty);
    await act(exercise('RepoRFQ', rfq.cid, 'Award', { winner: b.dataset.cid, losers, collateralCid: col, markCid: m.cid, contexts: NO_CONTEXTS }));
    return 'Repo opened: cash received, bonds pledged, other quotes refunded with their rank only';
  },
  async cancel(b) { await act(exercise('RepoRFQ', b.dataset.cid, 'CancelRFQ')); return 'Request cancelled'; },
  async post(b) {
    const c = of('MarginCall').find((x) => x.cid === b.dataset.cid).arg;
    const cid = await merged(c.instrument, c.issuer);
    await act(exercise('MarginCall', b.dataset.cid, 'PostMargin', { holdingCid: cid }));
    return 'Margin posted';
  },
  async repurchase(b) {
    const t = of('RepoTrade').find((x) => x.cid === b.dataset.cid).arg;
    const cid = await merged('USDC', t.terms.cashIssuer);
    await act(exercise('RepoTrade', b.dataset.cid, 'Repurchase', { cashCid: cid, contexts: NO_CONTEXTS }));
    return `Repurchased: collateral back, lender paid principal and interest${t.venue ? ', venue paid its fee' : ''}`;
  },
  async roll(b) {
    const o = of('RollOffer').find((x) => x.cid === b.dataset.cid).arg;
    const t = of('RepoTrade').find((x) => x.cid === o.tradeCid).arg;
    const m = mark(t.collateralInstrument);
    if (!m?.fresh) throw new Error('no fresh mark for ' + t.collateralInstrument);
    const cid = await merged(t.terms.cashInstrument, t.terms.cashIssuer);
    await act(exercise('RollOffer', b.dataset.cid, 'AcceptRoll', { cashCid: cid, markCid: m.cid }));
    return `Rolled: interest paid, continuing at ${N(o.newRateBps)} bp`;
  },
  async substitute(b) {
    await act(exercise('RepoTrade', b.dataset.cid, 'ProposeSubstitution', { holdingCid: val(`#sub-${b.dataset.cid.slice(0, 12)}`) }));
    return 'Substitute offered and locked; waiting for the lender';
  },
  async quote(b) {
    const r = of('RepoRFQ').find((x) => x.cid === b.dataset.cid), t = r.arg.terms, k = b.dataset.cid.slice(0, 12);
    const cash = await exact('USDC', t.cashIssuer, t.principal);
    await act(exercise('RepoRFQ', r.cid, 'SubmitQuote', { lender: me(), rateBps: val(`#r-${k}`),
      haircut: String(N(val(`#h-${k}`)) / 100), cashCid: cash }));
    return 'Quote sealed to the borrower; cash locked behind it';
  },
  async withdraw(b) { await act(exercise('RepoQuote', b.dataset.cid, 'WithdrawQuote', { contexts: NO_CONTEXTS })); return 'Quote withdrawn, cash returned'; },
  async approve(b) {
    const s = of('Substitution').find((x) => x.cid === b.dataset.cid).arg;
    await act(exercise('Substitution', b.dataset.cid, 'Approve', { markCid: mark(s.newInstrument).cid, contexts: NO_CONTEXTS }));
    return 'Collateral swapped';
  },
  async decline(b) { await act(exercise('Substitution', b.dataset.cid, 'Decline', { contexts: NO_CONTEXTS })); return 'Substitute returned to the borrower'; },
  async call(b) {
    const t = of('RepoTrade').find((x) => x.cid === b.dataset.cid).arg;
    await act(exercise('RepoTrade', b.dataset.cid, 'CallMargin', { markCid: mark(t.collateralInstrument).cid,
      respondBy: new Date(Date.now() + DAY).toISOString() }));
    return 'Margin called';
  },
  async default(b) { await act(exercise('MarginCall', b.dataset.cid, 'Default', { contexts: NO_CONTEXTS })); return 'Default declared: collateral is yours'; },
  async claim(b) { await act(exercise('RepoTrade', b.dataset.cid, 'ClaimAfterMaturity', { contexts: NO_CONTEXTS })); return 'Collateral claimed'; },
  async 'offer-roll'(b) {
    const t = of('RepoTrade').find((x) => x.cid === b.dataset.cid).arg, k = b.dataset.cid.slice(0, 12);
    await act(create('RollOffer', { tradeCid: b.dataset.cid, borrower: t.borrower, lender: me(),
      newRateBps: val(`#ro-r-${k}`), extraDays: val(`#ro-d-${k}`), expiresAt: new Date(Date.now() + 2 * DAY).toISOString() }));
    return 'Roll offered to the borrower';
  },
  async mark() {
    await act(create('Mark', { agent: me(), instrument: val('#m-inst'), price: val('#m-price'), asOf: new Date().toISOString(),
      audience: [CFG.parties.borrower, ...LENDERS.map((l) => CFG.parties[l])] }));
    return 'Mark published';
  },
};

function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 9000 : 4000);
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !canAct()) return;
  b.disabled = true;
  try { toast(await ACTIONS[b.dataset.act](b)); await refresh(true); }
  catch (err) { toast(err.message.replace(/^submit \d+: /, ''), true); b.disabled = false; }
});

// ---- refresh ----
async function refresh(force) {
  // Never repaint under a field being typed in.
  if (!force && document.activeElement?.matches('input, select.in')) return;
  try {
    const r = await post('/api/acs', { role: ROLE });
    DATA = r.contracts;
    $('#status').textContent = `● live · ${r.offset}`; $('#status').className = 'status';
    $('#view').innerHTML = (VIEWS[ROLE] ?? venueView)();
  } catch (err) {
    $('#status').textContent = '● ' + err.message; $('#status').className = 'status err';
  }
}

// Segmented role switcher; the <select id="role"> stays the source of truth.
const MONO = { borrower: 'B', lenderA: 'A', lenderB: 'B', lenderC: 'C', regulator: 'R', agent: 'V', venue: 'F' };
function rolePills() {
  const opts = [...$('#role').options];
  $('#roles').innerHTML = opts.map((o) => `<button type="button" class="rp rp-${o.value}" data-role="${o.value}" aria-pressed="${o.value === ROLE}">
    <span class="mono" aria-hidden="true">${MONO[o.value] ?? '?'}</span>${esc(o.text.split(' · ')[0])}</button>`).join('');
  $('#roles').onclick = (e) => {
    const b = e.target.closest('[data-role]');
    if (b && b.dataset.role !== ROLE) { $('#role').value = b.dataset.role; $('#role').dispatchEvent(new Event('change')); }
  };
  if ($('#role-name')) $('#role-name').textContent = $('#role').selectedOptions[0]?.text ?? ROLE;
  document.body.dataset.role = ROLE;
}

async function start() {
  CFG = await (await fetch('/api/config')).json();
  syncReadOnly();
  $('#wallet').onclick = async () => {
    try {
      const party = await wallet.connect();
      const role = Object.entries(CFG.parties).find(([, v]) => v === party)?.[0];
      $('#wallet').textContent = role ? `Wallet · ${NAMES[role] ?? role}` : 'Wallet connected';
      if (!role) return toast('Connected, but this wallet\'s party is not a party on this desk', true);
      ROLE = role; $('#role').value = role; $('#role').dispatchEvent(new Event('change'));
      toast(`Signing as ${NAMES[role] ?? role} with your wallet`);
    } catch (err) { toast('Wallet: ' + err.message, true); }
  };
  $('#role').value = ROLE;
  $('#party').textContent = me();
  rolePills();
  $('#role').onchange = () => {
    ROLE = $('#role').value; try { localStorage.setItem('talang.role', ROLE); } catch {}
    $('#party').textContent = me(); rolePills(); syncReadOnly();
    $('#view').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel short"></div>'; refresh(true);
  };
  await refresh(true);
  timer = setInterval(refresh, 5000);
}
start();
