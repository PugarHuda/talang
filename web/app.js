// Talang desk. Every number shown is read from the acting role's own view of the
// ledger; every action is a Daml command the contract re-checks.
import { wallet } from '/wallet.js';

const $ = (s) => document.querySelector(s);
const PKG = '#talang-repo';
const DAY = 864e5, HOUR = 36e5;
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
// A party this desk has no role for (lender C on DevNet) shows by the last word of its hint, e.g. dealerC.
const roleOf = (party) => Object.entries(CFG.parties).find(([, v]) => v === party)?.[0] ?? party.split('::')[0].split('-').pop();
const NAMES = { borrower: 'Borrower', lenderA: 'Lender A', lenderB: 'Lender B', lenderC: 'Lender C', regulator: 'Regulator', agent: 'Agent', venue: 'Venue' };
const LENDERS = ['lenderA', 'lenderB', 'lenderC'];
const name = (party) => esc(NAMES[roleOf(party)] ?? roleOf(party));
const me = () => CFG.parties[ROLE];
const of = (tpl) => DATA.filter((c) => c.tpl === tpl);

// talang-repo 1.2.0 templates live in their own module (lib/ledger.mjs AGREEMENTS).
const AGREEMENTS = ['HaircutSchedule', 'MasterAgreementProposal', 'MasterAgreement', 'CloseOutReport'];
const mod = (tpl) => (AGREEMENTS.includes(tpl) ? 'TalangAgreements' : 'Talang');
const create = (tpl, args) => ({ CreateCommand: { templateId: `${PKG}:${mod(tpl)}:${tpl}`, createArguments: args } });
const exercise = (tpl, cid, choice, arg = {}) =>
  ({ ExerciseCommand: { templateId: `${PKG}:${mod(tpl)}:${tpl}`, contractId: cid, choice, choiceArgument: arg } });
const createdEvent = (tx, tpl) => (tx?.transaction?.events ?? []).map((e) => e.CreatedEvent).filter(Boolean)
  .find((c) => c.templateId?.endsWith(`:${mod(tpl)}:${tpl}`));
const createdCid = (tx, tpl) => createdEvent(tx, tpl)?.contractId;

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}
// A connected CIP-0103 wallet signs for its own party; every other role goes through the desk server.
const viaWallet = (role) => wallet.party && wallet.party === CFG.parties[role];
const act = (command, role = ROLE) => (viaWallet(role) ? wallet.submit(command) : wallet.deskSubmit(role, command));
// The hosted copy is read-only unless the acting role is the connected wallet's party.
const canAct = () => !CFG.readOnly || viaWallet(ROLE);
function syncReadOnly() {
  const ro = !canAct();
  document.body.classList.toggle('readonly', ro);
  $('#readonly').hidden = !ro;
}

// ---- money arithmetic, mirrored from the contract so the page can show it ----
function mark(instrument, agent) {
  // Only marks from the desk's agent or its valuation committee, as mcp/server.mjs: anyone may
  // publish a "Mark" to a party, and the contract would refuse one from another agent anyway.
  // With `agent` (the repo's or request's), only that agent's: the contract takes no other.
  // A mark dated in the future is refused by the contract, so it is never the latest here.
  const trusted = [CFG.parties.agent, CFG.parties.committee].filter(Boolean);
  const m = of('Mark').filter((c) => c.arg.instrument === instrument && trusted.includes(c.arg.agent) && (!agent || c.arg.agent === agent)
    && Date.parse(c.arg.asOf) <= Date.now()).sort((a, b) => Date.parse(b.arg.asOf) - Date.parse(a.arg.asOf))[0];
  const age = m && Date.now() - Date.parse(m.arg.asOf);
  // A margin call needs a mark under an hour old (1.2.0), anything else one under a day.
  return m && { cid: m.cid, price: N(m.arg.price), asOf: m.arg.asOf, fresh: age < DAY, callable: age < HOUR };
}
// A lender's published haircut schedule (1.2.0): instrument -> minimum haircut.
const schedule = (lender) => of('HaircutSchedule').find((c) => c.arg.lender === lender);
const floorOf = (lender, instrument) => { const s = schedule(lender); return s && (instrument in s.arg.floors ? N(s.arg.floors[instrument]) : null); };
// Repos under a master agreement, and its event of default if there is one.
const underAgreement = (ma) => of('RepoTrade').filter((t) => t.arg.borrower === ma.borrower && t.arg.lender === ma.lender && t.arg.regulator === ma.regulator);
function defaultEvent(trades) {
  const call = of('MarginCall').find((c) => trades.some((t) => t.cid === c.arg.tradeCid) && Date.now() > Date.parse(c.arg.respondBy));
  const matured = trades.filter((t) => Date.now() > Date.parse(t.arg.maturity));
  return { call, matured, any: !!call || matured.length > 0 };
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
  const a = t.arg, m = mark(a.collateralInstrument, a.agent), o = owed(a);
  const cover = m ? lendable(N(a.haircut), N(a.collateralQty), m.price) / o : null;
  const pill = cover == null ? '<span class="pill mute">no mark</span>'
    : cover >= 1 ? `<span class="pill ok">covered ${pct(cover)}</span>` : `<span class="pill bad">short ${pct(cover)}</span>`;
  const late = Date.now() > Date.parse(a.maturity);
  return `<div class="card"><h3>${money(a.terms.principal)} USDC against ${units(a.collateralQty)} ${esc(a.collateralInstrument)} ${pill}</h3>
    <div class="row"><span>Funded by <b>${name(a.lender)}</b></span><span>Rate <b>${N(a.rateBps)} bp</b></span>
    <span>Haircut <b>${pct(a.haircut)}</b></span><span>Owed now <b>${money(o)}</b></span>
    ${a.terms.minTransfer != null ? `<span>Min transfer <b>${money(a.terms.minTransfer)}</b></span>` : ''}
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
    <label>Minimum transfer (USDC)<input id="n-mta" type="number" placeholder="none" /></label>
    <div class="ask" role="group" aria-labelledby="n-ask"><span id="n-ask">Ask</span><span>${LENDERS.filter((l) => CFG.parties[l]).map((l) => `<label style="display:inline;flex-direction:row"><input type="checkbox" class="n-lender" value="${l}" ${l === 'lenderC' ? '' : 'checked'} style="width:auto" /> ${NAMES[l]}</label>`).join(' ')}</span></div>
    <button data-act="request">Send request</button>
    <button class="ghost" data-act="bonds">Demo issuer: give me bonds</button></div></div>`;

  h += `<h2>Requests and sealed quotes</h2>`;
  h += rfqs.length ? rfqs.map((r) => {
    const t = r.arg.terms, m = mark(t.collateralInstrument, r.arg.agent);
    const qs = quotes.filter((q) => q.arg.rfqId === r.cid)
      .sort((x, y) => N(x.arg.rateBps) - N(y.arg.rateBps) || N(x.arg.haircut) - N(y.arg.haircut));
    return `<div class="card"><h3>${money(t.principal)} USDC against ${units(t.collateralQty)} ${esc(t.collateralInstrument)}, ${esc(t.termDays)} days</h3>
      <div class="row"><span>Asked <b>${r.arg.lenders.map(name).join(', ')}</b></span><span>Mark <b>${m ? money(m.price) : '—'}</b></span>
      ${r.arg.venue ? `<span>Venue fee <b>${N(r.arg.venue.feeBps)} bp</b></span>` : ''}
      ${t.minTransfer != null ? `<span>Min transfer <b>${money(t.minTransfer)}</b></span>` : ''}
      ${r.arg.lenders.filter(schedule).map((l) => { const f = floorOf(l, t.collateralInstrument);
        return `<span>${name(l)} schedule <b>${f == null ? 'not eligible' : 'min ' + pct(f)}</b></span>`; }).join('')}</div>
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

  h += `<h2>Margin calls</h2>` + (calls.length ? calls.map((c) => {
    // 1.2.0: a fresh mark newer than the call's that shows cover cancels the call.
    const t = trades.find((x) => x.cid === c.arg.tradeCid), m = mark(c.arg.instrument, t?.arg.agent);
    const newer = m?.fresh && (!c.arg.markAsOf || Date.parse(m.asOf) > Date.parse(c.arg.markAsOf));
    const cover = t && newer ? lendable(N(t.arg.haircut), N(t.arg.collateralQty), m.price) / owed(t.arg) : null;
    return `<div class="card"><h3>${name(c.arg.lender)} calls ${units(c.arg.unitsDue)} ${esc(c.arg.instrument)}</h3>
    <div class="row"><span>Owed <b>${money(c.arg.owed)}</b></span><span>At mark <b>${money(c.arg.price)}</b></span>
    ${c.arg.markAsOf ? `<span>Mark struck <b>${when(c.arg.markAsOf)}</b></span>` : ''}
    <span>Respond by <b>${when(c.arg.respondBy)}</b></span>
    ${cover != null ? `<span>Newer mark <b>${money(m.price)}</b> covers <b>${pct(cover)}</b></span>` : ''}</div>
    <div class="actions"><button data-act="post" data-cid="${c.cid}">Post ${units(c.arg.unitsDue)} ${esc(c.arg.instrument)}</button>
    ${cover != null ? `<button class="ghost" data-act="refute" data-cid="${c.cid}" ${cover >= 1 ? '' : 'disabled'}>${cover >= 1 ? 'Refute with the newer mark' : 'Newer mark still short'}</button>` : ''}
    <button class="ghost" data-act="bonds-for" data-inst="${esc(c.arg.instrument)}" data-amount="${c.arg.unitsDue}">Demo issuer: give me the bonds</button></div></div>`;
  }).join('') : '<p class="empty">None.</p>');

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
    const pending = subs.find((s) => s.arg.tradeCid === t.cid);
    // 1.2.0 takes substitutes from the repo's own collateral issuer only.
    const others = mine(null, t.arg.collateralIssuer).filter((x) => x.arg.instrument !== 'USDC' && x.arg.instrument !== t.arg.collateralInstrument);
    return tradeCard(t, `<button data-act="repurchase" data-cid="${t.cid}">Repurchase for ${money(owed(t.arg) + fee(t.arg))}</button>
      ${pending ? `<span class="pill warn">substitution waiting for lender</span>
          <button class="ghost" data-act="withdraw-sub" data-cid="${pending.cid}">Withdraw substitute</button>`
        : others.length ? `<select class="in" id="sub-${t.cid.slice(0, 12)}" aria-label="Collateral to offer as substitute">${others.map((x) => `<option value="${x.cid}">${units(x.arg.amount)} ${esc(x.arg.instrument)}</option>`).join('')}</select>
          <button class="ghost" data-act="substitute" data-cid="${t.cid}">Offer as substitute</button>` : ''}
      <button class="ghost" data-act="cash">Demo issuer: give me 100k USDC</button>`);
  }).join('') : '<p class="empty">No open repos.</p>');

  const scheds = of('HaircutSchedule');
  h += `<h2>Lender haircut schedules</h2>` + (scheds.length ? `<div class="card"><table><tr><th>Lender</th><th>Minimum haircut by collateral</th></tr>
    ${scheds.map((c) => `<tr><td>${name(c.arg.lender)}</td><td>${Object.entries(c.arg.floors).map(([i, f]) => `${esc(i)} ${pct(f)}`).join(' · ')}</td></tr>`).join('')}</table>
    <p class="empty">A lender quoting through its schedule cannot go below these floors, and collateral not listed is refused.</p></div>`
    : '<p class="empty">No lender has published one to you.</p>');
  return h + agreementsSection() + holdingsCard();
}

function lenderView() {
  const rfqs = of('RepoRFQ'), quotes = of('RepoQuote'), trades = of('RepoTrade');
  const calls = of('MarginCall'), subs = of('Substitution');
  const rivals = quotes.filter((q) => q.arg.lender !== me()).length;
  let h = `<div class="card proof"><b>Privacy, read from this node:</b> you can see ${quotes.length} quote${quotes.length === 1 ? '' : 's'},
    ${rivals === 0 ? 'all of them your own. Rival quotes never reached you.' : `<span class="pill bad">${rivals} from rivals</span>`}</div>`;

  h += `<h2>Requests you were asked to quote</h2>` + (rfqs.length ? rfqs.map((r) => {
    const t = r.arg.terms, m = mark(t.collateralInstrument, r.arg.agent);
    const mineQ = quotes.find((q) => q.arg.rfqId === r.cid);
    const sched = schedule(me()), floor = floorOf(me(), t.collateralInstrument);
    return `<div class="card"><h3>${name(r.arg.borrower)} wants ${money(t.principal)} USDC against ${units(t.collateralQty)} ${esc(t.collateralInstrument)}, ${esc(t.termDays)} days</h3>
      <div class="row"><span>Mark <b>${m ? money(m.price) : '—'}</b></span><span>Collateral value <b>${m ? money(N(t.collateralQty) * m.price) : '—'}</b></span>
      ${t.minTransfer != null ? `<span>Min transfer <b>${money(t.minTransfer)}</b></span>` : ''}
      ${sched ? `<span>Your schedule <b>${floor == null ? 'not eligible' : 'min ' + pct(floor)}</b></span>` : ''}</div>
      ${sched && floor == null ? `<p class="empty" style="margin:6px 0 0"><span class="pill warn">${esc(t.collateralInstrument)} is not on your haircut schedule</span> a quote goes through the schedule, so the ledger will refuse it.</p>` : ''}
      ${mineQ ? `<div class="actions"><span class="pill ok">your sealed quote: ${N(mineQ.arg.rateBps)} bp, ${pct(mineQ.arg.haircut)}</span>
        <button class="ghost" data-act="withdraw" data-cid="${mineQ.cid}">Withdraw</button></div>`
      : `<div class="form" style="margin-top:10px"><label>Rate (bp)<input id="r-${r.cid.slice(0, 12)}" type="number" value="525" /></label>
        <label>Haircut (%)<input id="h-${r.cid.slice(0, 12)}" type="number" step="0.5" value="${floor != null ? Math.max(2, +(floor * 100).toFixed(4)) : 2}" /></label>
        <button data-act="quote" data-cid="${r.cid}">Seal quote, lock ${money(t.principal)} USDC</button>
        <button class="ghost" data-act="cash-for" data-amount="${t.principal}">Demo issuer: give me the cash</button></div>`}</div>`;
  }).join('') : '<p class="empty">No requests.</p>');

  const losses = of('LossNotice');
  h += `<h2>Quotes you lost</h2>` + (losses.length ? `<div class="card"><table><tr><th>When</th><th>Your rank</th><th></th></tr>
    ${losses.map((n) => `<tr><td>${when(n.arg.at)}</td><td>${esc(n.arg.rank)} of ${esc(n.arg.outOf)}</td>
      <td><span class="pill mute">no winning rate, no winner: that is all a loser is told</span></td></tr>`).join('')}</table></div>`
    : '<p class="empty">None.</p>');

  h += `<h2>Substitutions to approve</h2>` + (subs.length ? subs.map((s) => {
    const t = trades.find((x) => x.cid === s.arg.tradeCid), m = mark(s.arg.newInstrument, t?.arg.agent);
    const cover = t && m ? lendable(N(t.arg.haircut), N(s.arg.newQty), m.price) / owed(t.arg) : null;
    const issuerOk = !t || s.arg.newIssuer === t.arg.collateralIssuer, floor = floorOf(me(), s.arg.newInstrument);
    const schedOk = !schedule(me()) || (floor != null && t && N(t.arg.haircut) >= floor);
    return `<div class="card"><h3>${name(s.arg.borrower)} offers ${units(s.arg.newQty)} ${esc(s.arg.newInstrument)}${t ? ` for ${units(t.arg.collateralQty)} ${esc(t.arg.collateralInstrument)}` : ''}</h3>
      <div class="row"><span>Mark <b>${m ? money(m.price) : '—'}</b></span><span>Would cover <b>${cover == null ? '—' : pct(cover)}</b></span>
      ${issuerOk ? '' : `<span><span class="pill bad">issued by another issuer than the repo's collateral</span></span>`}
      ${schedOk ? '' : `<span><span class="pill warn">outside your haircut schedule</span></span>`}</div>
      <div class="actions"><button data-act="approve" data-cid="${s.cid}" ${cover >= 1 && m?.fresh && issuerOk ? '' : 'disabled'}>Approve swap</button>
      <button class="ghost" data-act="decline" data-cid="${s.cid}">Decline</button></div></div>`;
  }).join('') : '<p class="empty">None.</p>');

  h += `<h2>Your margin calls</h2>` + (calls.length ? calls.map((c) => {
    const due = Date.now() > Date.parse(c.arg.respondBy);
    // 1.2.0: a default must follow the deadline within a day; after that, call again on a fresh mark.
    const lapsed = Date.now() > Date.parse(c.arg.respondBy) + DAY;
    return `<div class="card"><h3>${units(c.arg.unitsDue)} ${esc(c.arg.instrument)} called from ${name(c.arg.borrower)}</h3>
      <div class="row"><span>At mark <b>${money(c.arg.price)}</b></span>${c.arg.markAsOf ? `<span>Mark struck <b>${when(c.arg.markAsOf)}</b></span>` : ''}
      <span>Respond by <b>${when(c.arg.respondBy)}</b></span></div>
      <div class="actions"><button data-act="default" data-cid="${c.cid}" ${due && !lapsed ? '' : 'disabled'}>${lapsed ? 'Over a day past the deadline: call again' : due ? 'Declare default, keep collateral' : 'Borrower still has time'}</button></div></div>`;
  }).join('') : '<p class="empty">None.</p>');

  h += `<h2>Repos you funded</h2>` + (trades.length ? trades.map((t) => {
    const m = mark(t.arg.collateralInstrument, t.arg.agent);
    const gap = m ? owed(t.arg) - lendable(N(t.arg.haircut), N(t.arg.collateralQty), m.price) : 0, short = gap > 0;
    const called = calls.some((c) => c.arg.tradeCid === t.cid && Date.now() <= Date.parse(c.arg.respondBy) + DAY);
    const mta = t.arg.terms.minTransfer != null ? N(t.arg.terms.minTransfer) : null;
    const late = Date.now() > Date.parse(t.arg.maturity);
    const offered = of('RollOffer').some((o) => o.arg.tradeCid === t.cid), k = t.cid.slice(0, 12);
    return tradeCard(t, `${short && !called ? `<span class="form"><label>Respond within (h)<input id="mc-h-${k}" type="number" min="2" value="24" /></label>
        <button data-act="call" data-cid="${t.cid}" ${m.fresh ? '' : 'disabled'}>Call margin on ${money(gap)} short</button></span>
        ${m.callable ? '' : '<span class="pill warn">mark over an hour old: the ledger wants a newer one for a call</span>'}
        ${mta != null && gap < mta ? `<span class="pill warn">shortfall below the ${money(mta)} minimum transfer: the ledger will refuse a call</span>` : ''}` : ''}
      ${late ? `<button data-act="claim" data-cid="${t.cid}">Claim collateral, past maturity</button>`
        : offered ? '<span class="pill warn">roll offered, waiting for the borrower</span>'
        : `<span class="form"><label>Roll at (bp)<input id="ro-r-${k}" type="number" value="${N(t.arg.rateBps) - 15}" /></label>
           <label>Extra days<input id="ro-d-${k}" type="number" value="30" /></label>
           <button class="ghost" data-act="offer-roll" data-cid="${t.cid}">Offer roll</button></span>`}`);
  }).join('') : '<p class="empty">None.</p>');
  return h + scheduleSection() + agreementsSection() + holdingsCard();
}

// 1.2.0: the lender's own haircut floors per collateral instrument, published to the borrower.
function scheduleSection() {
  const s = schedule(me());
  const insts = [...new Set([...of('Mark').map((m) => m.arg.instrument), ...Object.keys(s?.arg.floors ?? {})])].sort();
  return `<h2>Your haircut schedule</h2><div class="card">
    <p class="empty" style="margin:0 0 10px">${s ? 'Published to the borrower. Your quotes and substitution approvals go through it: the ledger refuses a haircut under the floor and collateral left blank.'
      : 'None published: quotes go out unchecked. Set a minimum haircut per collateral; leave one blank to refuse it.'}</p>
    <div class="form">${insts.map((i) => `<label>${esc(i)} min haircut (%)<input class="hs-floor" data-inst="${esc(i)}" type="number" step="0.5" min="0" max="49.99"
      value="${s && i in s.arg.floors ? +(N(s.arg.floors[i]) * 100).toFixed(4) : ''}" placeholder="not eligible" /></label>`).join('')}
    ${canAct() ? `<button data-act="schedule">${s ? 'Revise schedule' : 'Sign and publish schedule'}</button>
      ${s ? `<button class="ghost" data-act="drop-schedule" data-cid="${s.cid}">Withdraw schedule</button>` : ''}` : ''}</div></div>`;
}

// 1.2.0: master agreements (GMRA-style), one per borrower-lender pair, and close-out netting.
function agreementsSection() {
  const lender = LENDERS.includes(ROLE), side = lender ? 'borrower' : 'lender';
  const mas = of('MasterAgreement'), props = of('MasterAgreementProposal');
  const reps = of('CloseOutReport').sort((a, b) => b.arg.at.localeCompare(a.arg.at));
  const taken = (party) => [...mas, ...props].some((c) => c.arg[side] === party);
  const open = (lender ? ['borrower'] : LENDERS).filter((r) => CFG.parties[r] && !taken(CFG.parties[r]));
  let h = `<h2>Master agreements</h2>`;
  if (canAct() && open.length) h += `<div class="card"><div class="form">
    <label>Counterparty<select class="in" id="ma-cp">${open.map((r) => `<option value="${r}">${NAMES[r]}</option>`).join('')}</select></label>
    <label>Form<input id="ma-form" value="GMRA 2011" /></label>
    <button data-act="propose-master">Offer master agreement</button></div></div>`;
  h += props.map((p) => `<div class="card"><h3>${esc(p.arg.form)} between ${name(p.arg.borrower)} and ${name(p.arg.lender)} <span class="pill warn">offered by ${name(p.arg.proposer)}</span></h3>
    <div class="actions">${p.arg.proposer === me() ? `<button class="ghost" data-act="withdraw-master" data-cid="${p.cid}">Withdraw offer</button>`
      : `<button data-act="sign-master" data-cid="${p.cid}">Sign master agreement</button>`}</div></div>`).join('');
  h += mas.map((c) => {
    const trades = underAgreement(c.arg), ev = defaultEvent(trades);
    const why = ev.call ? 'margin call past its deadline' : ev.matured.length ? `${ev.matured.length} repo${ev.matured.length > 1 ? 's' : ''} past maturity` : null;
    return `<div class="card"><h3>${esc(c.arg.form)} between ${name(c.arg.borrower)} and ${name(c.arg.lender)} <span class="pill ok">signed by both</span></h3>
      <div class="row"><span>Repos under it <b>${trades.length}</b></span><span>Owed across them <b>${money(trades.reduce((a, t) => a + owed(t.arg), 0))}</b></span>
      <span>Event of default <b>${why ?? 'none'}</b></span></div>
      ${lender ? `<div class="actions"><button data-act="close-out" data-cid="${c.cid}" ${trades.length ? '' : 'disabled'}>${why ? `Close out all ${trades.length} repos, net to one sum` : 'Close out (the ledger refuses without an event of default)'}</button></div>` : ''}</div>`;
  }).join('');
  if (!props.length && !mas.length && !(canAct() && open.length)) h += '<p class="empty">None.</p>';
  return h + closeOutTable(reps);
}

const closeOutTable = (reps) => `<h2>Close-outs</h2>` + (reps.length ? `<div class="card"><table><tr><th>When</th><th>Borrower</th><th>Lender</th><th>Trigger</th><th>Repos netted</th>
  <th>Owed</th><th>Collateral value</th><th>Kept by lender</th><th>Returned</th></tr>
  ${reps.map((r) => `<tr><td>${when(r.arg.at)}</td><td>${name(r.arg.borrower)}</td><td>${name(r.arg.lender)}</td>
    <td><span class="pill bad">${esc(r.arg.trigger)}</span></td><td>${esc(r.arg.reposNetted)}</td><td>${money(r.arg.owed)}</td><td>${money(r.arg.collateralValue)}</td>
    <td>${money(r.arg.valueKept)}</td><td>${money(r.arg.valueReturned)}</td></tr>`).join('')}</table>
  <p class="empty">Valued at fresh marks with no haircut; excess collateral on one repo covers a shortfall on another.</p></div>`
  : '<p class="empty">None.</p>');

// A record from before 1.2.0 carries the exact gap; winning rate minus it is the best losing
// rate, so the page shows it as the same band the contract now writes (bucketName in Talang.daml).
const band = (gap) => (gap <= 0 ? '0' : gap <= 5 ? '1-5' : gap <= 25 ? '6-25' : '>25');
function regulatorView() {
  const reps = of('RepoReport').sort((a, b) => b.arg.at.localeCompare(a.arg.at));
  const bex = of('BestExecution').sort((a, b) => b.arg.at.localeCompare(a.arg.at));
  const seen = DATA.filter((c) => !['RepoReport', 'BestExecution', 'CloseOutReport'].includes(c.tpl)).length;
  return `<div class="card proof"><b>Privacy, read from this node:</b> ${reps.length} lifecycle reports, and
    ${seen === 0 ? 'no request, quote, loss notice or position. Losing rates never reached the regulator.' : `<span class="pill bad">${seen} other contracts</span>`}</div>
    <h2>Best execution</h2><div class="card">${bex.length ? `<table><tr><th>When</th><th>Quotes weighed</th><th>Winner's rank</th><th>Rate taken</th><th>Haircut</th><th>Over best rate (band)</th></tr>
    ${bex.map((b) => `<tr><td>${when(b.arg.at)}</td><td>${esc(b.arg.quotesConsidered)}</td>
      <td>${N(b.arg.winnerRank) === 1 ? '<span class="pill ok">1 · best</span>' : `<span class="pill warn">${esc(b.arg.winnerRank)}</span>`}</td>
      <td>${N(b.arg.winningRateBps)} bp</td><td>${pct(b.arg.winningHaircut)}</td><td>${((s) => (s === '0' ? '—' : esc(s) + ' bp'))(b.arg.spreadBucket ?? band(N(b.arg.spreadToBestBps)))}</td></tr>`).join('')}</table>
      <p class="empty">No lender is named and no losing quote is shown: the regulator learns how price discovery went, not who lost.</p>`
    : '<p class="empty">No awards yet.</p>'}</div>
    <h2>Repo lifecycle reports</h2><div class="card">${reps.length ? `<table><tr><th>When</th><th>Event</th><th>Borrower</th><th>Lender</th>
    <th>Principal</th><th>Rate</th><th>Haircut</th><th>Collateral</th><th>Cash moved</th><th>Venue fee</th></tr>
    ${reps.map((r) => `<tr><td>${when(r.arg.at)}</td><td><span class="pill ${r.arg.event === 'DEFAULT' ? 'bad' : r.arg.event === 'CLOSE' ? 'ok' : r.arg.event === 'ROLL' ? 'warn' : 'mute'}">${esc(r.arg.event)}</span></td>
      <td>${name(r.arg.borrower)}</td><td>${name(r.arg.lender)}</td><td>${money(r.arg.terms.principal)}</td><td>${N(r.arg.rateBps)} bp</td>
      <td>${pct(r.arg.haircut)}</td><td>${units(r.arg.collateralQty)} ${esc(r.arg.collateralInstrument)}</td><td>${N(r.arg.cashMoved) ? money(r.arg.cashMoved) : ''}</td><td>${N(r.arg.feePaid) ? money(r.arg.feePaid) : ''}</td></tr>`).join('')}</table>`
    : '<p class="empty">No reports.</p>'}</div>` + closeOutTable(of('CloseOutReport').sort((a, b) => b.arg.at.localeCompare(a.arg.at)));
}

function agentView() {
  const marks = of('Mark').sort((a, b) => b.arg.asOf.localeCompare(a.arg.asOf));
  return (!canAct() ? '' : `<h2>Publish a mark</h2><div class="card"><div class="form">
    <label>Instrument<input id="m-inst" value="UST10Y" /></label><label>Price per unit<input id="m-price" type="number" value="${marks.find((m) => m.arg.instrument === 'UST10Y')?.arg.price ?? ''}" /></label>
    <button data-act="mark">Publish to borrower and lenders</button></div></div>`) + `
    <h2>Marks</h2><div class="card"><table><tr><th>Instrument</th><th>Price</th><th>As of</th><th></th></tr>
    ${marks.map((m) => `<tr><td>${esc(m.arg.instrument)}</td><td>${money(m.arg.price)}</td><td>${when(m.arg.asOf)}</td>
      <td>${Date.now() - Date.parse(m.arg.asOf) < DAY ? '<span class="pill ok">fresh</span>' : '<span class="pill mute">stale</span>'}</td></tr>`).join('')}</table></div>`;
}

const venueView = () => `<div class="card emptystate"><h3>No venue screen yet</h3>
  <p class="empty">The operator's fee is collected inside each repurchase and roll; the regulator's lifecycle reports show every fee paid.</p></div>`;
const VIEWS = { borrower: borrowerView, lenderA: lenderView, lenderB: lenderView, lenderC: lenderView, regulator: regulatorView, agent: agentView };

// ---- side by side ----
// Each role's column is that role's own /api/acs read, one request per role, the same
// call the desk makes when acting as it. A count of 0 means the contract never reached
// that party's node, not that the page filtered it out.
let SBS = new URLSearchParams(location.search).get('view') === 'side-by-side';
const deskRoles = () => [...$('#role').options].map((o) => o.value).filter((r) => CFG.parties[r]);

function sbsCounts(role, contracts) {
  const party = CFG.parties[role], n = (tpl) => contracts.filter((c) => c.tpl === tpl).length;
  const quotes = contracts.filter((c) => c.tpl === 'RepoQuote');
  // A quote is a lender's own when it names that lender; for anyone else every quote is someone else's.
  const own = quotes.filter((q) => q.arg.lender === party).length;
  return { requests: n('RepoRFQ'), quotes: quotes.length, own, rivals: quotes.length - own, repos: n('RepoTrade'),
    losses: n('LossNotice'), bex: n('BestExecution'), reports: n('RepoReport'), total: contracts.length };
}

// One plain sentence per role, stated from the counts above.
function sbsVerdict(role, c) {
  if (LENDERS.includes(role)) return c.rivals === 0
    ? `<span class="pill ok">0 rival quotes</span> ${c.own ? `Sees ${c.own} quote${c.own === 1 ? '' : 's'}, all its own.` : 'Sees no quote at all.'}`
    : `<span class="pill bad">${c.rivals} rival quote${c.rivals === 1 ? '' : 's'} visible</span>`;
  if (role === 'regulator') return c.requests + c.quotes === 0
    ? `<span class="pill ok">0 requests, 0 quotes</span> Sees ${c.reports} report${c.reports === 1 ? '' : 's'} and ${c.bex} best-execution record${c.bex === 1 ? '' : 's'}, no names on the latter.`
    : `<span class="pill bad">${c.requests} requests, ${c.quotes} quotes visible</span>`;
  if (role === 'borrower') return `Sees the ${c.quotes} quote${c.quotes === 1 ? '' : 's'} sent to its own requests.`;
  return '';
}

function sbsCard(role, res) {
  const head = `<h3><span class="mono ${role}" aria-hidden="true">${MONO[role] ?? '?'}</span>${esc(NAMES[role] ?? role)}</h3>`;
  if (res.status === 'rejected') return `<div class="card" data-role="${role}">${head}<p class="verdict"><span class="pill bad">${esc(res.reason.message)}</span></p></div>`;
  const c = sbsCounts(role, res.value.contracts), lender = LENDERS.includes(role);
  const row = (label, v, sub) => `<dt${sub ? ' class="sub"' : ''}>${label}</dt><dd class="${sub ? 'sub ' : ''}${v ? '' : 'zero'}" data-k="${label}">${v}</dd>`;
  return `<div class="card" data-role="${role}">${head}<dl>
    ${row('Open requests', c.requests)}${row('Quotes', c.quotes)}
    ${lender ? row('its own', c.own, true) + row('from rivals', c.rivals, true) : ''}
    ${row('Repos', c.repos)}${row('Loss notices', c.losses)}${row('Best-execution records', c.bex)}${row('Reports', c.reports)}
    ${row('All contracts', c.total)}</dl>
    <p class="verdict">${sbsVerdict(role, c)}</p><p class="off">offset ${esc(res.value.offset)}</p></div>`;
}

async function sideBySide(force) {
  const roles = deskRoles();
  const res = await Promise.allSettled(roles.map((role) => read(role)));
  const ok = res.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw res[0]?.reason ?? new Error('no roles');
  $('#status').textContent = `● live · ${Math.max(...ok.map((r) => r.value.offset))}`; $('#status').className = 'status';
  if (!SBS) return; // left the view while the reads were in flight
  if (!force && res.every((r) => r.status === 'fulfilled' && r.value.same) && Date.now() - painted < 60000) return;
  painted = Date.now();
  $('#view').innerHTML = `<section class="sbs-head"><div><p class="kicker">Side by side</p><h1>Every role, its own node</h1></div>
    <p class="note">Each column is one read of that party's active contracts, the same read the desk makes when acting as it. Nothing is filtered by this page.</p></section>
    <div class="sbs" id="sbs">${roles.map((r, i) => sbsCard(r, res[i])).join('')}</div>`;
}

// Flag, button, heading and URL; ?view=side-by-side reopens this view on reload.
function markSbs(on) {
  SBS = on;
  $('#side-by-side').setAttribute('aria-pressed', String(on));
  $('#who').hidden = on;
  document.body.classList.toggle('sbs-mode', on);
  const u = new URL(location.href);
  on ? u.searchParams.set('view', 'side-by-side') : u.searchParams.delete('view');
  history.replaceState(null, '', u);
}

function setSbs(on) {
  markSbs(on);
  if (on) $('#roles').querySelectorAll('[data-role]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  else rolePills();
  $('#view').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel short"></div>';
  refresh(true);
}

// ---- actions ----
const val = (id) => $(id)?.value;
// A number field as the decimal text the ledger expects. A browser number input turns
// blank or non-numeric text into "", and N("") is 0, so a cleared haircut would quote
// 0%: refuse it here, naming the field. Whether the value is allowed stays the contract's call.
// Plain decimal text only: the ledger's Numeric 10 takes no exponent ("1e3") and no 11th
// decimal, and its refusal of either is not one a person can read.
function num(id, label) {
  const v = val(id)?.trim();
  if (!v || !/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`${label}: enter a number`);
  if (/\.\d{11}/.test(v)) throw new Error(`${label}: at most 10 decimals`);
  return v;
}
// A count of days is an Int on the ledger; "30.5" would come back as a bare parse error.
function whole(id, label) {
  const v = num(id, label);
  if (!/^-?\d+$/.test(v)) throw new Error(`${label}: enter whole days`);
  return v;
}
// A ledger refusal arrives as the participant's JSON; show its reason, not the envelope.
function readable(msg) {
  msg = msg.replace(/^submit \d+: /, '');
  let cause;
  try { cause = JSON.parse(msg.slice(msg.indexOf('{'))).cause; } catch { return msg; }
  if (!cause) return msg;
  const pre = /Template precondition violated: (\w+)/.exec(cause);
  if (pre) return `Refused by the contract: the ${pre[1]} terms are out of range (amounts, quantities and days must be above zero)`;
  const why = /UNHANDLED_EXCEPTION[\s\S]*?\(error category \d+\): ([\s\S]*)$/.exec(cause);
  if (why) return 'Refused by the contract: ' + why[1];
  if (/CONTRACT_NOT_FOUND|could not be found/i.test(msg)) return 'That is no longer on the ledger (someone acted on it, or another tab did): the page has been refreshed';
  return 'Refused by the ledger: ' + cause.split(/\. |, correlationId/)[0];
}
const ACTIONS = {
  async request() {
    if (!document.querySelector('.n-lender:checked')) throw new Error('Ask: pick at least one lender');
    await act(create('RepoRFQ', { borrower: me(), regulator: CFG.parties.regulator, agent: CFG.parties.agent,
      venue: CFG.parties.venue ? { operator: CFG.parties.venue, feeBps: '10.0' } : null,
      lenders: [...document.querySelectorAll('.n-lender:checked')].map((x) => CFG.parties[x.value]), deadline: null, terms: {
        cashIssuer: CFG.parties.cashIssuer, cashInstrument: 'USDC', principal: num('#n-cash', 'Cash wanted'),
        collateralIssuer: CFG.parties.bondIssuer, collateralInstrument: val('#n-inst'),
        collateralQty: num('#n-qty', 'Units'), termDays: whole('#n-term', 'Term'),
        // Blank: no minimum transfer, any shortfall may be called.
        minTransfer: val('#n-mta')?.trim() ? num('#n-mta', 'Minimum transfer') : null } }));
    return 'Request sent to the panel';
  },
  async bonds() { await faucet('bondIssuer', val('#n-inst'), num('#n-qty', 'Units')); return 'Bonds issued to you'; },
  async 'bonds-for'(b) { await faucet('bondIssuer', b.dataset.inst, b.dataset.amount); return 'Bonds issued to you'; },
  async cash() { await faucet('cashIssuer', 'USDC', 100000); return '100,000 USDC issued to you'; },
  async 'cash-for'(b) { await faucet('cashIssuer', 'USDC', b.dataset.amount); return 'Cash issued to you'; },
  async award(b) {
    const rfq = of('RepoRFQ').find((r) => r.cid === b.dataset.rfq), t = rfq.arg.terms;
    const losers = of('RepoQuote').filter((q) => q.arg.rfqId === rfq.cid && q.cid !== b.dataset.cid).map((q) => q.cid);
    const m = mark(t.collateralInstrument, rfq.arg.agent);
    if (!m?.fresh) throw new Error('no fresh mark for ' + t.collateralInstrument + ': ask the agent to publish one');
    const col = await exact(t.collateralInstrument, t.collateralIssuer, t.collateralQty);
    await act(exercise('RepoRFQ', rfq.cid, 'AwardSealed', { winner: b.dataset.cid, losers, collateralCid: col, markCid: m.cid, contexts: NO_CONTEXTS }));
    return 'Repo opened: cash received, bonds pledged, other quotes refunded with their rank only';
  },
  async cancel(b) { await act(exercise('RepoRFQ', b.dataset.cid, 'CancelRFQ')); return 'Request cancelled'; },
  async post(b) {
    const c = of('MarginCall').find((x) => x.cid === b.dataset.cid).arg;
    // The contract pledges the whole holding posted: post exactly the units called when one holding
    // has them, and merge everything only when none does (the button says how many units go).
    const cid = mine(c.instrument, c.issuer).some((h) => N(h.arg.amount) >= N(c.unitsDue))
      ? await exact(c.instrument, c.issuer, c.unitsDue) : await merged(c.instrument, c.issuer);
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
    const m = mark(t.collateralInstrument, t.agent);
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
    // Percent to a fraction with at most 10 decimals: 1.1 / 100 is 0.011000000000000001 in
    // floating point, which the ledger's Numeric 10 refuses to decode.
    const rate = num(`#r-${k}`, 'Rate'), haircut = (N(num(`#h-${k}`, 'Haircut')) / 100).toFixed(10);
    const cash = await exact('USDC', t.cashIssuer, t.principal), sched = schedule(me());
    // A lender with a published schedule quotes through it, so the ledger checks the floor.
    await act(sched ? exercise('HaircutSchedule', sched.cid, 'QuoteWithinSchedule', { rfqCid: r.cid, rateBps: rate, haircut, cashCid: cash })
      : exercise('RepoRFQ', r.cid, 'SubmitQuote', { lender: me(), rateBps: rate, haircut, cashCid: cash }));
    return sched ? 'Quote sealed through your haircut schedule; cash locked behind it' : 'Quote sealed to the borrower; cash locked behind it';
  },
  async withdraw(b) { await act(exercise('RepoQuote', b.dataset.cid, 'WithdrawQuote', { contexts: NO_CONTEXTS })); return 'Quote withdrawn, cash returned'; },
  async approve(b) {
    const s = of('Substitution').find((x) => x.cid === b.dataset.cid).arg, sched = schedule(me());
    const markCid = mark(s.newInstrument, of('RepoTrade').find((x) => x.cid === s.tradeCid)?.arg.agent).cid;
    await act(sched ? exercise('HaircutSchedule', sched.cid, 'ApproveWithinSchedule', { substitutionCid: b.dataset.cid, markCid, contexts: NO_CONTEXTS })
      : exercise('Substitution', b.dataset.cid, 'Approve', { markCid, contexts: NO_CONTEXTS }));
    return 'Collateral swapped';
  },
  async decline(b) { await act(exercise('Substitution', b.dataset.cid, 'Decline', { contexts: NO_CONTEXTS })); return 'Substitute returned to the borrower'; },
  async call(b) {
    const t = of('RepoTrade').find((x) => x.cid === b.dataset.cid).arg;
    // The ledger gives the borrower at least 2 hours; 2 here would land a moment short of it.
    const hours = N(num(`#mc-h-${b.dataset.cid.slice(0, 12)}`, 'Respond within'));
    await act(exercise('RepoTrade', b.dataset.cid, 'CallMargin', { markCid: mark(t.collateralInstrument, t.agent).cid,
      respondBy: new Date(Date.now() + hours * HOUR + 60000).toISOString() }));
    return 'Margin called';
  },
  async default(b) { await act(exercise('MarginCall', b.dataset.cid, 'Default', { contexts: NO_CONTEXTS })); return 'Default declared: you keep collateral up to what is owed, the rest goes back to the borrower'; },
  async claim(b) { await act(exercise('RepoTrade', b.dataset.cid, 'ClaimAfterMaturity', { contexts: NO_CONTEXTS })); return 'Collateral claimed'; },
  async 'offer-roll'(b) {
    const t = of('RepoTrade').find((x) => x.cid === b.dataset.cid).arg, k = b.dataset.cid.slice(0, 12);
    await act(create('RollOffer', { tradeCid: b.dataset.cid, borrower: t.borrower, lender: me(),
      newRateBps: num(`#ro-r-${k}`, 'Roll rate'), extraDays: whole(`#ro-d-${k}`, 'Extra days'), expiresAt: new Date(Date.now() + 2 * DAY).toISOString() }));
    return 'Roll offered to the borrower';
  },
  async refute(b) {
    const c = of('MarginCall').find((x) => x.cid === b.dataset.cid).arg;
    await act(exercise('MarginCall', b.dataset.cid, 'RefuteMarginCall', { markCid: mark(c.instrument, of('RepoTrade').find((x) => x.cid === c.tradeCid)?.arg.agent).cid }));
    return 'Margin call cancelled: the newer mark shows the pledge covers what is owed';
  },
  async 'withdraw-sub'(b) { await act(exercise('Substitution', b.dataset.cid, 'WithdrawSubstitution', { contexts: NO_CONTEXTS })); return 'Substitute withdrawn and unlocked'; },
  async schedule() {
    const floors = {};
    for (const i of document.querySelectorAll('.hs-floor')) {
      const v = i.value.trim();
      if (!v) continue;
      if (!Number.isFinite(N(v))) throw new Error(`${i.dataset.inst}: enter a number`);
      floors[i.dataset.inst] = (N(v) / 100).toFixed(10);
    }
    if (!Object.keys(floors).length) throw new Error('give at least one collateral a minimum haircut');
    const old = schedule(me()), audience = [CFG.parties.borrower];
    await act(old ? exercise('HaircutSchedule', old.cid, 'ReviseSchedule', { newFloors: floors, newAudience: audience })
      : create('HaircutSchedule', { lender: me(), floors, audience }));
    return old ? 'Haircut schedule revised' : 'Haircut schedule signed and published to the borrower';
  },
  async 'drop-schedule'(b) { await act(exercise('HaircutSchedule', b.dataset.cid, 'Archive')); return 'Haircut schedule withdrawn'; },
  async 'propose-master'() {
    const other = CFG.parties[val('#ma-cp')], lender = LENDERS.includes(ROLE);
    await act(create('MasterAgreementProposal', { borrower: lender ? other : me(), lender: lender ? me() : other,
      regulator: CFG.parties.regulator, form: val('#ma-form')?.trim() || 'GMRA 2011', proposer: me() }));
    return 'Master agreement offered; it binds once the other side signs';
  },
  async 'sign-master'(b) { await act(exercise('MasterAgreementProposal', b.dataset.cid, 'SignMaster')); return 'Master agreement signed by both sides'; },
  async 'withdraw-master'(b) { await act(exercise('MasterAgreementProposal', b.dataset.cid, 'WithdrawMasterProposal')); return 'Offer withdrawn'; },
  async 'close-out'(b) {
    const ma = of('MasterAgreement').find((x) => x.cid === b.dataset.cid).arg, trades = underAgreement(ma);
    const markCids = trades.map((t) => {
      const m = mark(t.arg.collateralInstrument, t.arg.agent);
      if (!m?.fresh) throw new Error('no fresh mark for ' + t.arg.collateralInstrument + ': ask the agent to publish one');
      return m.cid;
    });
    const tx = await act(exercise('MasterAgreement', b.dataset.cid, 'CloseOut', { tradeCids: trades.map((t) => t.cid), markCids,
      defaultedCall: defaultEvent(trades).call?.cid ?? null, contexts: NO_CONTEXTS }));
    const r = createdEvent(tx, 'CloseOutReport')?.createArgument;
    return r ? `Closed out ${r.reposNetted} repos on ${r.trigger}: owed ${money(r.owed)}, kept ${money(r.valueKept)}, returned ${money(r.valueReturned)}` : 'Closed out';
  },
  async mark() {
    const instrument = val('#m-inst')?.trim();
    // The contract only checks the price; a mark on "" would be published and match nothing.
    if (!instrument) throw new Error('Instrument: enter a name');
    await act(create('Mark', { agent: me(), instrument, price: num('#m-price', 'Price'), asOf: new Date().toISOString(),
      audience: [CFG.parties.borrower, ...LENDERS.map((l) => CFG.parties[l]).filter(Boolean)] }));
    return 'Mark published';
  },
};

function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 9000 : 4000);
}

// One action at a time: a second click, or the 5 s repaint handing back a fresh enabled
// button, while a command is in flight would submit it twice (a second request, a second
// sealed quote locking more cash).
let busy = false;
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || busy || !canAct()) return;
  busy = true; b.disabled = true;
  try { toast(await ACTIONS[b.dataset.act](b)); await refresh(true); }
  catch (err) { toast(readable(err.message), true); b.disabled = false; if (/CONTRACT_NOT_FOUND/.test(err.message)) refresh(true); }
  finally { busy = false; }
});

// ---- refresh ----
// Last read per role. The next poll sends its offset as `since`; a server that finds nothing
// new for that party answers `unchanged` and the contracts are not sent again.
const LAST = {};
async function read(role) {
  const prev = LAST[role];
  const r = await post('/api/acs', { role, ...(prev ? { since: prev.offset } : {}) });
  if (r.unchanged && prev) return (LAST[role] = { ...prev, offset: r.offset, same: true });
  const same = !!prev && JSON.stringify(r.contracts) === JSON.stringify(prev.contracts);
  return (LAST[role] = { offset: r.offset, contracts: r.contracts, same });
}
let painted = 0;
// The 5 s repaint must not undo what the person typed or picked and has not sent yet: a
// form reset to its defaults would send 4,800,000 when they typed 900,000. Fields they
// changed are carried over to the new page by id (or class and instrument).
const fieldKey = (e) => e.id || `${e.className}|${e.dataset.inst ?? e.value}`;
const dirty = (e) => (e.type === 'checkbox' ? e.checked !== e.defaultChecked
  : e.tagName === 'SELECT' ? [...e.options].some((o) => o.selected !== o.defaultSelected) : e.value !== e.defaultValue);
function repaint(html) {
  const kept = new Map([...$('#view').querySelectorAll('input, select')].filter(dirty)
    .map((e) => [fieldKey(e), e.type === 'checkbox' ? e.checked : e.value]));
  $('#view').innerHTML = html;
  for (const e of $('#view').querySelectorAll('input, select')) {
    const k = fieldKey(e);
    if (!kept.has(k)) continue;
    if (e.type === 'checkbox') e.checked = kept.get(k);
    else if (e.tagName !== 'SELECT' || [...e.options].some((o) => o.value === kept.get(k))) e.value = kept.get(k);
  }
}
async function refresh(force) {
  // Never repaint under a field being typed in.
  if (!force && (busy || document.activeElement?.matches('input, select.in'))) return;
  const role = ROLE;
  try {
    if (SBS) return await sideBySide(force);
    const r = await read(role);
    // Switched to side by side, or to another role, while this read was in flight: painting
    // it now would show the previous role's contracts under the new role's name.
    if (SBS || role !== ROLE) return;
    DATA = r.contracts;
    $('#status').textContent = `● live · ${r.offset}`; $('#status').className = 'status';
    // Same contracts: keep the page (and keyboard focus) as it is; repaint once a minute so
    // clock-based labels (fresh/stale mark, past maturity) still move.
    if (!force && r.same && Date.now() - painted < 60000) return;
    painted = Date.now();
    repaint((VIEWS[ROLE] ?? venueView)());
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
    if (b && SBS && b.dataset.role === ROLE) return setSbs(false);
    if (b && b.dataset.role !== ROLE) { $('#role').value = b.dataset.role; $('#role').dispatchEvent(new Event('change')); }
  };
  if ($('#role-name')) $('#role-name').textContent = $('#role').selectedOptions[0]?.text ?? ROLE;
  document.body.dataset.role = ROLE;
}

async function start() {
  CFG = await (await fetch('/api/config')).json();
  // Roles this ledger has no party for (lender C and the venue on DevNet) get no pill:
  // picking one would only ask the API for an unknown role.
  [...$('#role').options].forEach((o) => CFG.parties[o.value] || o.remove());
  // ?role=or a remembered role this desk does not run (a typo, an issuer, a venue-less ledger).
  if (!CFG.parties[ROLE] || ![...$('#role').options].some((o) => o.value === ROLE)) ROLE = 'borrower';
  syncReadOnly();
  $('#wallet').onclick = async () => {
    try {
      const party = await wallet.connect();
      const role = Object.entries(CFG.parties).find(([, v]) => v === party)?.[0];
      // A wallet from another network (Grofty on TestNet) can still drive a role bound to it.
      const bound = Object.entries(CFG.walletRoles ?? {}).find(([, v]) => v === party)?.[0];
      $('#wallet').textContent = role ? `Wallet · ${NAMES[role] ?? role}` : `Wallet · ${party.split('::')[0].slice(0, 18)}`;
      $('#wallet').title = party;
      if (!role && bound && CFG.parties[bound]) {
        ROLE = bound; $('#role').value = bound; $('#role').dispatchEvent(new Event('change'));
        return toast(`Wallet connected: it drives ${NAMES[bound] ?? bound}, each command needs its signature`);
      }
      if (!role) return toast(`Wallet connected as ${party.slice(0, 40)}…: its participant does not host Talang's contracts; the wallet panel says what it can do on this desk`, true);
      ROLE = role; $('#role').value = role; $('#role').dispatchEvent(new Event('change'));
      toast(`Signing as ${NAMES[role] ?? role} with your wallet`);
    } catch (err) { toast('Wallet: ' + err.message, true); }
  };
  $('#role').value = ROLE;
  $('#party').textContent = me();
  rolePills();
  $('#side-by-side').onclick = () => setSbs(!SBS);
  $('#role').onchange = () => {
    if (SBS) markSbs(false);
    ROLE = $('#role').value; try { localStorage.setItem('talang.role', ROLE); } catch {}
    $('#party').textContent = me(); rolePills(); syncReadOnly();
    $('#view').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel short"></div>'; refresh(true);
  };
  if (SBS) setSbs(true); else await refresh(true);
  timer = setInterval(refresh, 5000);
}
start();
