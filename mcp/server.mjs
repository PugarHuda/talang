#!/usr/bin/env node
// Talang MCP server: Claude at one desk on Talang, a sealed-bid repo desk on Canton.
//
// The agent reads only what its own party's node holds, so it is under the same
// privacy rules as a human at that desk: a lender's agent never sees a rival's
// rate, the borrower's agent never sees a lender's other business, and the
// regulator's agent sees reports and nothing upstream of them. Every write is an
// ordinary Daml command the contract re-checks; a margin call the mark does not
// justify, or a quote whose haircut leaves the cash uncovered, is refused by the
// ledger, not by this file.
//
//   TALANG_ROLE=lenderA   node mcp/server.mjs   lender desk
//   TALANG_ROLE=borrower  node mcp/server.mjs   borrower (treasury) desk
//   TALANG_ROLE=regulator node mcp/server.mjs   supervisor
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PARTIES, acs, submit, create, exercise, created, NO_CONTEXTS } from '../lib/ledger.mjs';
import { assess, latestMark, lendable, owed, venueFee, N } from '../lib/repo.mjs';

const ROLE = process.env.TALANG_ROLE ?? 'lenderA';
const ME = PARTIES[ROLE];
const KIND = ROLE.startsWith('lender') ? 'lender' : ROLE;
if (!ME || !['lender', 'borrower', 'regulator'].includes(KIND))
  throw new Error(`TALANG_ROLE must be a lender, borrower or regulator role in the parties file, got ${ROLE}`);
const roleOf = (p) => Object.entries(PARTIES).find(([, v]) => v === p)?.[0] ?? p.split('::')[0];

// Contract ids are long; tools accept any unique prefix.
const pick = (list, id, what) => {
  const hits = list.filter((c) => c.cid.startsWith(id));
  if (hits.length !== 1) throw new Error(`${hits.length ? 'ambiguous' : 'no'} ${what} matching "${id}"`);
  return hits[0];
};
const short = (cid) => cid.slice(0, 16);
const NOTHING = { type: 'object', properties: {} };

const TOOLS = {
  lender: [
    { name: 'portfolio', description: `Every open repo ${ROLE} funded: cash owed now, collateral, the latest mark and whether it is fresh, coverage (>= 1 means covered), units short, maturity, outstanding margin calls, substitutions waiting for review and roll offers out.`,
      inputSchema: NOTHING },
    { name: 'open_requests', description: 'Repo requests this lender was invited to quote, with collateral value at the latest mark, the largest haircut that still covers, the venue fee and whether a sealed quote is already in.',
      inputSchema: NOTHING },
    { name: 'quote', description: 'Seal a quote on a request: annual rate in basis points and haircut in percent. Locks the full principal from this lender\'s free cash. Only the borrower will see it.',
      inputSchema: { type: 'object', required: ['request', 'rateBps', 'haircutPct'], properties: {
        request: { type: 'string', description: 'request id or unique prefix' },
        rateBps: { type: 'number' }, haircutPct: { type: 'number' } } } },
    { name: 'call_margin', description: 'Issue a margin call on an under-covered repo, against the latest fresh mark. The contract computes the units due and refuses if the repo is still covered.',
      inputSchema: { type: 'object', required: ['repo'], properties: {
        repo: { type: 'string', description: 'repo id or unique prefix' },
        hoursToRespond: { type: 'number', description: 'default 24' } } } },
    { name: 'review_substitution', description: 'Approve or decline collateral the borrower offered as a substitute. Approval re-checks coverage at the latest mark of the new collateral.',
      inputSchema: { type: 'object', required: ['substitution', 'decision'], properties: {
        substitution: { type: 'string' }, decision: { type: 'string', enum: ['approve', 'decline'] } } } },
    { name: 'offer_roll', description: 'Offer the borrower an extension of a live repo at a new rate. If accepted, interest so far is paid now and the clock restarts at the new rate; the contract re-checks coverage at a fresh mark.',
      inputSchema: { type: 'object', required: ['repo', 'newRateBps', 'extraDays'], properties: {
        repo: { type: 'string' }, newRateBps: { type: 'number' }, extraDays: { type: 'integer' },
        hoursValid: { type: 'number', description: 'default 48' } } } },
    { name: 'loss_history', description: 'Requests this lender quoted and lost, with its rank among the quotes the borrower weighed. That is all a loser is ever told: no winning rate, no winner.',
      inputSchema: NOTHING },
    { name: 'privacy_check', description: 'Count what this lender\'s node can see that is not its own: rival quotes should be zero.',
      inputSchema: NOTHING },
  ],
  borrower: [
    { name: 'quotes', description: 'Every open request with the sealed quotes received, ranked by rate, each with what it lends against the collateral at the latest fresh mark and whether it covers the cash. A quote that does not cover cannot be taken.',
      inputSchema: NOTHING },
    { name: 'award', description: 'Take one quote on a request. The collateral is pledged and the cash arrives in one transaction; every other quote is refunded unrevealed, its lender told only its rank; the regulator gets a best-execution record with no lender names.',
      inputSchema: { type: 'object', required: ['request', 'quote'], properties: {
        request: { type: 'string' }, quote: { type: 'string', description: 'quote id prefix, or "best" for the cheapest covered quote' } } } },
    { name: 'book', description: 'Every open repo: lender, rate, what is owed today including the venue fee, coverage at the latest mark, margin calls to answer, roll offers to consider.',
      inputSchema: NOTHING },
    { name: 'accept_roll', description: 'Accept a lender\'s roll offer: pay the interest so far (and the venue fee) now, keep the cash, continue at the offered rate.',
      inputSchema: { type: 'object', required: ['offer'], properties: { offer: { type: 'string' } } } },
    { name: 'privacy_check', description: 'What this node holds: the borrower sees its own requests, quotes made to it and its repos, and nothing of the lenders\' other business.',
      inputSchema: NOTHING },
  ],
  regulator: [
    { name: 'lifecycle', description: 'Every lifecycle event of every open or closed repo, in time order: open, margin calls, margin posted, substitutions, rolls, closes with the venue fee, defaults.',
      inputSchema: NOTHING },
    { name: 'best_execution', description: 'For every award: how many sealed quotes the borrower weighed, where the one it took ranked on rate and the gap to the best rate in bp. No lender is named, no losing quote is shown.',
      inputSchema: NOTHING },
    { name: 'privacy_check', description: 'Count what the regulator\'s node holds beyond reports and best-execution records: requests and quotes should be zero.',
      inputSchema: NOTHING },
  ],
}[KIND];

async function run(name, a = {}) {
  const { contracts } = await acs(ME);
  const of = (tpl) => contracts.filter((c) => c.tpl === tpl);

  // ---- lender ----
  if (name === 'portfolio') {
    const calls = of('MarginCall'), subs = of('Substitution'), rolls = of('RollOffer');
    return of('RepoTrade').filter((t) => t.arg.lender === ME).map((t) => ({ repo: short(t.cid), borrower: roleOf(t.arg.borrower), ...assess(t, contracts), cid: undefined,
      marginCall: calls.filter((c) => c.arg.tradeCid === t.cid).map((c) => ({ id: short(c.cid), unitsDue: N(c.arg.unitsDue), respondBy: c.arg.respondBy }))[0] ?? null,
      rollOffer: rolls.filter((r) => r.arg.tradeCid === t.cid).map((r) => ({ id: short(r.cid), newRateBps: N(r.arg.newRateBps), extraDays: N(r.arg.extraDays) }))[0] ?? null,
      substitution: subs.filter((s) => s.arg.tradeCid === t.cid).map((s) => {
        const m = latestMark(contracts, s.arg.newInstrument);
        return { id: short(s.cid), offered: `${N(s.arg.newQty)} ${s.arg.newInstrument}`, mark: m?.price ?? null, markFresh: m?.fresh ?? false,
          wouldCover: m ? lendable(N(t.arg.haircut), N(s.arg.newQty), m.price) / assess(t, contracts).owed : null };
      })[0] ?? null }));
  }

  if (name === 'open_requests') {
    const mine = of('RepoQuote');
    return of('RepoRFQ').map((r) => {
      const t = r.arg.terms, m = latestMark(contracts, t.collateralInstrument), q = mine.find((x) => x.arg.rfqId === r.cid);
      return { request: short(r.cid), borrower: roleOf(r.arg.borrower), principal: N(t.principal), cash: t.cashInstrument,
        collateral: `${N(t.collateralQty)} ${t.collateralInstrument}`, termDays: N(t.termDays),
        collateralValue: m ? N(t.collateralQty) * m.price : null, mark: m?.price ?? null,
        maxHaircutThatCovers: m ? 1 - N(t.principal) / (N(t.collateralQty) * m.price) : null, invitedLenders: r.arg.lenders.length,
        venueFeeBps: r.arg.venue ? N(r.arg.venue.feeBps) : 0,
        myQuote: q ? { rateBps: N(q.arg.rateBps), haircut: N(q.arg.haircut) } : null };
    });
  }

  if (name === 'quote') {
    const r = pick(of('RepoRFQ'), a.request, 'request'), t = r.arg.terms;
    const cash = of('Holding').filter((h) => h.arg.owner === ME && h.arg.instrument === t.cashInstrument && h.arg.issuer === t.cashIssuer)
      .sort((x, y) => N(x.arg.amount) - N(y.arg.amount)).find((h) => N(h.arg.amount) >= N(t.principal));
    if (!cash) throw new Error(`no free ${t.cashInstrument} holding of at least ${N(t.principal)} to lock behind the quote`);
    const cashCid = N(cash.arg.amount) === N(t.principal) ? cash.cid
      : created(await submit(ME, exercise('Holding', cash.cid, 'Split', { splitAmount: t.principal })), 'Holding');
    await submit(ME, exercise('RepoRFQ', r.cid, 'SubmitQuote',
      { lender: ME, rateBps: String(a.rateBps), haircut: String(a.haircutPct / 100), cashCid }));
    return { sealed: true, request: short(r.cid), rateBps: a.rateBps, haircutPct: a.haircutPct, locked: N(t.principal) };
  }

  if (name === 'call_margin') {
    const t = pick(of('RepoTrade'), a.repo, 'repo'), m = latestMark(contracts, t.arg.collateralInstrument);
    if (!m) throw new Error('no mark for ' + t.arg.collateralInstrument);
    const respondBy = new Date(Date.now() + (a.hoursToRespond ?? 24) * 36e5).toISOString();
    const tx = await submit(ME, exercise('RepoTrade', t.cid, 'CallMargin', { markCid: m.cid, respondBy }));
    return { called: true, marginCall: short(created(tx, 'MarginCall') ?? ''), respondBy, atMark: m.price };
  }

  if (name === 'review_substitution') {
    const s = pick(of('Substitution'), a.substitution, 'substitution');
    if (a.decision === 'decline') { await submit(ME, exercise('Substitution', s.cid, 'Decline', { contexts: NO_CONTEXTS })); return { declined: true }; }
    const m = latestMark(contracts, s.arg.newInstrument);
    if (!m) throw new Error('no mark for ' + s.arg.newInstrument);
    await submit(ME, exercise('Substitution', s.cid, 'Approve', { markCid: m.cid, contexts: NO_CONTEXTS }));
    return { approved: true, newCollateral: `${N(s.arg.newQty)} ${s.arg.newInstrument}`, atMark: m.price };
  }

  if (name === 'offer_roll') {
    const t = pick(of('RepoTrade'), a.repo, 'repo');
    const expiresAt = new Date(Date.now() + (a.hoursValid ?? 48) * 36e5).toISOString();
    const tx = await submit(ME, create('RollOffer', {
      tradeCid: t.cid, borrower: t.arg.borrower, lender: ME, newRateBps: String(a.newRateBps), extraDays: String(a.extraDays), expiresAt }));
    return { offered: true, offer: short(created(tx, 'RollOffer') ?? ''), newRateBps: a.newRateBps, extraDays: a.extraDays, expiresAt };
  }

  if (name === 'loss_history') {
    return of('LossNotice').map((n) => ({ request: short(n.arg.rfqId), rank: N(n.arg.rank), outOf: N(n.arg.outOf), at: n.arg.at }));
  }

  // ---- borrower ----
  if (name === 'quotes') {
    const quotes = of('RepoQuote');
    return of('RepoRFQ').map((r) => {
      const t = r.arg.terms, m = latestMark(contracts, t.collateralInstrument);
      const qs = quotes.filter((q) => q.arg.rfqId === r.cid).map((q) => {
        const lends = m ? lendable(N(q.arg.haircut), N(t.collateralQty), m.price) : null;
        return { quote: short(q.cid), lender: roleOf(q.arg.lender), rateBps: N(q.arg.rateBps), haircut: N(q.arg.haircut),
          lendsAtMark: lends, covers: lends != null && lends >= N(t.principal),
          interestToMaturity: Math.round(N(t.principal) * N(q.arg.rateBps) / 10000 * N(t.termDays) / 360 * 100) / 100 };
      }).sort((x, y) => x.rateBps - y.rateBps || x.haircut - y.haircut);
      return { request: short(r.cid), principal: N(t.principal), collateral: `${N(t.collateralQty)} ${t.collateralInstrument}`,
        termDays: N(t.termDays), mark: m?.price ?? null, markFresh: m?.fresh ?? false, quotes: qs };
    });
  }

  if (name === 'award') {
    const r = pick(of('RepoRFQ'), a.request, 'request'), t = r.arg.terms;
    const m = latestMark(contracts, t.collateralInstrument);
    if (!m?.fresh) throw new Error(`no fresh mark for ${t.collateralInstrument}`);
    const qs = of('RepoQuote').filter((q) => q.arg.rfqId === r.cid);
    const covered = qs.filter((q) => lendable(N(q.arg.haircut), N(t.collateralQty), m.price) >= N(t.principal))
      .sort((x, y) => N(x.arg.rateBps) - N(y.arg.rateBps) || N(x.arg.haircut) - N(y.arg.haircut));
    const win = a.quote === 'best' ? covered[0] : pick(qs, a.quote, 'quote');
    if (!win) throw new Error('no quote covers the cash at the latest mark');
    const col = of('Holding').find((h) => h.arg.owner === ME && h.arg.instrument === t.collateralInstrument
      && h.arg.issuer === t.collateralIssuer && N(h.arg.amount) === N(t.collateralQty));
    if (!col) throw new Error(`no holding of exactly ${N(t.collateralQty)} ${t.collateralInstrument} to pledge`);
    const tx = await submit(ME, exercise('RepoRFQ', r.cid, 'Award', { winner: win.cid, losers: qs.filter((q) => q.cid !== win.cid).map((q) => q.cid),
      collateralCid: col.cid, markCid: m.cid, contexts: NO_CONTEXTS }));
    return { opened: short(created(tx, 'RepoTrade') ?? ''), lender: roleOf(win.arg.lender), rateBps: N(win.arg.rateBps),
      haircut: N(win.arg.haircut), refunded: qs.length - 1 };
  }

  if (name === 'book') {
    const calls = of('MarginCall'), rolls = of('RollOffer');
    return of('RepoTrade').map((t) => {
      const fee = venueFee(t.arg);
      return { repo: short(t.cid), lender: roleOf(t.arg.lender), ...assess(t, contracts), cid: undefined, venueFee: fee,
        repurchaseToday: Math.round((owed(t.arg) + fee) * 100) / 100,
        marginCall: calls.filter((c) => c.arg.tradeCid === t.cid).map((c) => ({ id: short(c.cid), unitsDue: N(c.arg.unitsDue), respondBy: c.arg.respondBy }))[0] ?? null,
        rollOffer: rolls.filter((r) => r.arg.tradeCid === t.cid).map((r) => ({ id: short(r.cid), newRateBps: N(r.arg.newRateBps), extraDays: N(r.arg.extraDays), expiresAt: r.arg.expiresAt }))[0] ?? null };
    });
  }

  if (name === 'accept_roll') {
    const o = pick(of('RollOffer'), a.offer, 'roll offer');
    const t = of('RepoTrade').find((x) => x.cid === o.arg.tradeCid);
    if (!t) throw new Error('the repo this offer was for has changed; ask the lender for a new offer');
    const m = latestMark(contracts, t.arg.collateralInstrument);
    if (!m?.fresh) throw new Error(`no fresh mark for ${t.arg.collateralInstrument}`);
    const due = owed(t.arg) - N(t.arg.terms.principal) + venueFee(t.arg);
    const cash = of('Holding').filter((h) => h.arg.owner === ME && h.arg.instrument === t.arg.terms.cashInstrument
      && h.arg.issuer === t.arg.terms.cashIssuer).sort((x, y) => N(y.arg.amount) - N(x.arg.amount))[0];
    if (!cash || N(cash.arg.amount) < due) throw new Error(`need ${due} ${t.arg.terms.cashInstrument} in one holding to pay the interest`);
    const tx = await submit(ME, exercise('RollOffer', o.cid, 'AcceptRoll', { cashCid: cash.cid, markCid: m.cid }));
    return { rolled: short(created(tx, 'RepoTrade') ?? ''), paidNow: due, newRateBps: N(o.arg.newRateBps), extraDays: N(o.arg.extraDays) };
  }

  // ---- regulator ----
  if (name === 'lifecycle') {
    return of('RepoReport').sort((x, y) => x.arg.at.localeCompare(y.arg.at)).map((r) => ({ at: r.arg.at, event: r.arg.event,
      borrower: roleOf(r.arg.borrower), lender: roleOf(r.arg.lender), principal: N(r.arg.terms.principal), rateBps: N(r.arg.rateBps),
      collateral: `${N(r.arg.collateralQty)} ${r.arg.collateralInstrument}`, cashMoved: N(r.arg.cashMoved), venueFee: N(r.arg.feePaid) }));
  }

  if (name === 'best_execution') {
    return of('BestExecution').map((b) => ({ at: b.arg.at, quotesConsidered: N(b.arg.quotesConsidered), winnerRank: N(b.arg.winnerRank),
      winningRateBps: N(b.arg.winningRateBps), winningHaircut: N(b.arg.winningHaircut), spreadToBestBps: N(b.arg.spreadToBestBps) }));
  }

  if (name === 'privacy_check') {
    const count = (tpl) => of(tpl).length;
    if (KIND === 'lender') {
      const quotes = of('RepoQuote');
      return { party: roleOf(ME), quotesVisible: quotes.length, rivalQuotesVisible: quotes.filter((q) => q.arg.lender !== ME).length,
        reposVisible: count('RepoTrade'), reposNotMine: of('RepoTrade').filter((t) => t.arg.lender !== ME).length,
        lossNoticesNotMine: of('LossNotice').filter((n) => n.arg.lender !== ME).length, bestExecutionVisible: count('BestExecution') };
    }
    if (KIND === 'borrower') {
      return { party: roleOf(ME), requests: count('RepoRFQ'), quotesMadeToMe: count('RepoQuote'), repos: count('RepoTrade'),
        lossNoticesIssued: count('LossNotice'), otherBorrowersRepos: of('RepoTrade').filter((t) => t.arg.borrower !== ME).length };
    }
    return { party: roleOf(ME), reports: count('RepoReport'), bestExecution: count('BestExecution'),
      requestsVisible: count('RepoRFQ'), quotesVisible: count('RepoQuote'), lossNoticesVisible: count('LossNotice'), positionsVisible: count('Holding') };
  }
  throw new Error('unknown tool ' + name);
}

const INSTRUCTIONS = {
  lender: `You are the repo desk agent for ${ROLE} on Talang, a sealed-bid repo desk on Canton. `
    + 'Start from portfolio. Call margin only on a repo whose coverage is below 1 at a FRESH mark, and say why in numbers. '
    + 'Approve a substitution only if wouldCover >= 1 at a fresh mark. When quoting, keep the haircut at or below '
    + 'maxHaircutThatCovers or the borrower cannot take the quote. Ask the human before any write unless told to act.',
  borrower: 'You are the treasury agent for the borrower on Talang. Start from quotes or book. Prefer the cheapest quote that '
    + 'covers; explain in numbers why a cheaper one cannot be taken. Before accepting a roll, compare the new rate with what '
    + 'you pay now and say what is paid today. Ask the human before any write unless told to act.',
  regulator: 'You are the supervisor\'s agent on Talang. You see lifecycle reports and best-execution records only. Flag '
    + 'awards where the winner was not rank 1 and explain the spread; flag defaults and margin calls. Never speculate about losing lenders: '
    + 'they are not visible to you by design.',
}[KIND];

const server = new Server({ name: 'talang', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    if (!TOOLS.some((t) => t.name === req.params.name)) throw new Error(`${req.params.name} is not a ${KIND} tool`);
    const out = await run(req.params.name, req.params.arguments);
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message.replace(/^submit \d+: /, 'ledger refused: ') }] };
  }
});
await server.connect(new StdioServerTransport());
