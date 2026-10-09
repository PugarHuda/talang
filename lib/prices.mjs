// Live prices for the desk's instruments, from public sources. Nothing here is
// typed in: every mark the seed and the valuation committee publish comes from one
// of these calls, and the source and its timestamp travel with it.
//   CBTC   BTC/USD spot, one exchange per pricer (Coinbase, Kraken, Bitstamp)
//   UST2Y / UST5Y / UST10Y   a Treasury note of 100,000 face with the coupon below,
//          priced at the latest US Treasury daily par yield for its tenor
const get = async (url) => {
  const r = await fetch(url, { headers: { 'user-agent': 'talang-desk' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
};

export const BTC_SOURCES = {
  coinbase: async () => Number((await (await get('https://api.coinbase.com/v2/prices/BTC-USD/spot')).json()).data.amount),
  kraken: async () => Number(Object.values((await (await get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD')).json()).result)[0].c[0]),
  bitstamp: async () => Number((await (await get('https://www.bitstamp.net/api/v2/ticker/btcusd/')).json()).last),
};

export const NOTES = {
  UST2Y: { tenor: '2 Yr', years: 2, coupon: 3.875 },
  UST5Y: { tenor: '5 Yr', years: 5, coupon: 4.0 },
  UST10Y: { tenor: '10 Yr', years: 10, coupon: 4.25 },
};
export const FACE = 100000;

// Latest row of the US Treasury daily par yield curve.
export async function treasuryCurve() {
  const year = new Date().getUTCFullYear();
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
  const [head, latest] = (await (await get(url)).text()).trim().split(/\r?\n/);
  const cols = head.split(',').map((c) => c.replace(/"/g, ''));
  const vals = latest.split(',');
  return { date: vals[0], yield: (tenor) => Number(vals[cols.indexOf(tenor)]) };
}

// Price of a fixed-coupon note, semi-annual, at yield y (percent), rounded to cents.
export function notePrice(years, couponPct, yieldPct, face = FACE) {
  const n = years * 2, c = couponPct / 200, y = yieldPct / 200;
  const pv = c * (1 - (1 + y) ** -n) / y + (1 + y) ** -n;
  return Math.round(face * pv * 100) / 100;
}

// One price per instrument, with where it came from.
export async function livePrices({ btcSource = 'coinbase' } = {}) {
  const curve = await treasuryCurve();
  const out = {};
  for (const [inst, n] of Object.entries(NOTES)) {
    const y = curve.yield(n.tenor);
    out[inst] = { price: notePrice(n.years, n.coupon, y), source: `US Treasury par yield ${n.tenor} ${y}% on ${curve.date}, ${n.coupon}% coupon, 100,000 face` };
  }
  out.CBTC = { price: Math.round((await BTC_SOURCES[btcSource]()) * 100) / 100, source: `${btcSource} BTC-USD spot` };
  return out;
}
