// Repo arithmetic, mirrored from daml/Talang.daml so tools can explain a number
// before the contract re-checks it. The contract stays the authority.
const DAY = 864e5;
export const N = Number;

export function latestMark(contracts, instrument, now = Date.now()) {
  const m = contracts.filter((c) => c.tpl === 'Mark' && c.arg.instrument === instrument)
    .sort((a, b) => b.arg.asOf.localeCompare(a.arg.asOf))[0];
  return m && { cid: m.cid, price: N(m.arg.price), asOf: m.arg.asOf, fresh: now - Date.parse(m.arg.asOf) < DAY };
}

// ACT/360 with a one-day floor, rounded to cents, as in `interest`.
export const interest = (principal, rateBps, openedAt, now = Date.now()) =>
  Math.round(principal * rateBps / 10000 * Math.max(1, Math.floor((now - Date.parse(openedAt)) / DAY)) / 360 * 100) / 100;

export const owed = (t, now) => N(t.terms.principal) + interest(N(t.terms.principal), N(t.rateBps), t.openedAt, now);
export const lendable = (haircut, qty, price) => qty * price * (1 - haircut);

// Coverage of one open repo at the latest mark: >= 1 means the pledge covers what is owed.
export function assess(trade, contracts, now = Date.now()) {
  const t = trade.arg, m = latestMark(contracts, t.collateralInstrument, now), o = owed(t, now);
  const cover = m ? lendable(N(t.haircut), N(t.collateralQty), m.price) / o : null;
  const unitsShort = m && cover < 1 ? Math.ceil((o / (1 - N(t.haircut)) / m.price - N(t.collateralQty)) * 1e4) / 1e4 : 0;
  return { cid: trade.cid, principal: N(t.terms.principal), owed: o, rateBps: N(t.rateBps), haircut: N(t.haircut),
    collateral: `${N(t.collateralQty)} ${t.collateralInstrument}`, mark: m?.price ?? null, markFresh: m?.fresh ?? false,
    coverage: cover, unitsShort, maturity: t.maturity, matured: now > Date.parse(t.maturity) };
}
