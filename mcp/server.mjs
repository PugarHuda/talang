#!/usr/bin/env node
// Talang MCP server: Claude as one lender's repo desk agent.
//
// The agent reads only what that lender's node holds, so it is under the same
// privacy rules as a human at the desk: it never sees a rival lender's rate. Every
// write is an ordinary Daml command the contract re-checks; a margin call the mark
// does not justify is refused by the ledger, not by this file.
//
//   TALANG_ROLE=lenderA node mcp/server.mjs      (stdio; credentials from .env.noders)
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PARTIES, acs, submit, exercise, created } from '../lib/ledger.mjs';
import { assess, latestMark, lendable, N } from '../lib/repo.mjs';

const ROLE = process.env.TALANG_ROLE ?? 'lenderA';
const ME = PARTIES[ROLE];
if (!ME || !ROLE.startsWith('lender')) throw new Error(`TALANG_ROLE must be a lender role in parties.json, got ${ROLE}`);
const roleOf = (p) => Object.entries(PARTIES).find(([, v]) => v === p)?.[0] ?? p.split('::')[0];

// Contract ids are long; tools accept any unique prefix.
const pick = (list, id, what) => {
  const hits = list.filter((c) => c.cid.startsWith(id));
  if (hits.length !== 1) throw new Error(`${hits.length ? 'ambiguous' : 'no'} ${what} matching "${id}"`);
  return hits[0];
};
const short = (cid) => cid.slice(0, 16);

const TOOLS = [
  { name: 'portfolio', description: `Every open repo ${ROLE} funded: cash owed now, collateral, the latest mark and whether it is fresh, coverage (>= 1 means covered), units short, maturity, outstanding margin calls and substitutions waiting for review.`,
    inputSchema: { type: 'object', properties: {} } },
  { name: 'open_requests', description: 'Repo requests this lender was invited to quote, with collateral value at the latest mark and whether a sealed quote is already in.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'quote', description: 'Seal a quote on a request: annual rate in basis points and haircut in percent. Locks the full principal from this lender\'s free USDC. Only the borrower will see it.',
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
  { name: 'privacy_check', description: 'Count what this lender\'s node can see that is not its own: rival quotes should be zero.',
    inputSchema: { type: 'object', properties: {} } },
];

async function run(name, a = {}) {
  const { contracts } = await acs(ME);
  const of = (tpl) => contracts.filter((c) => c.tpl === tpl);

  if (name === 'portfolio') {
    const calls = of('MarginCall'), subs = of('Substitution');
    return of('RepoTrade').map((t) => ({ repo: short(t.cid), borrower: roleOf(t.arg.borrower), ...assess(t, contracts), cid: undefined,
      marginCall: calls.filter((c) => c.arg.tradeCid === t.cid).map((c) => ({ id: short(c.cid), unitsDue: N(c.arg.unitsDue), respondBy: c.arg.respondBy }))[0] ?? null,
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
      return { request: short(r.cid), borrower: roleOf(r.arg.borrower), principal: N(t.principal),
        collateral: `${N(t.collateralQty)} ${t.collateralInstrument}`, termDays: N(t.termDays),
        collateralValue: m ? N(t.collateralQty) * m.price : null, mark: m?.price ?? null,
        maxHaircutThatCovers: m ? 1 - N(t.principal) / (N(t.collateralQty) * m.price) : null, invitedLenders: r.arg.lenders.length,
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
    if (a.decision === 'decline') { await submit(ME, exercise('Substitution', s.cid, 'Decline')); return { declined: true }; }
    const m = latestMark(contracts, s.arg.newInstrument);
    if (!m) throw new Error('no mark for ' + s.arg.newInstrument);
    await submit(ME, exercise('Substitution', s.cid, 'Approve', { markCid: m.cid }));
    return { approved: true, newCollateral: `${N(s.arg.newQty)} ${s.arg.newInstrument}`, atMark: m.price };
  }

  if (name === 'privacy_check') {
    const quotes = of('RepoQuote');
    return { party: roleOf(ME), quotesVisible: quotes.length, rivalQuotesVisible: quotes.filter((q) => q.arg.lender !== ME).length,
      reposVisible: of('RepoTrade').length, reposNotMine: of('RepoTrade').filter((t) => t.arg.lender !== ME).length };
  }
  throw new Error('unknown tool ' + name);
}

const server = new Server({ name: 'talang', version: '0.1.0' }, { capabilities: { tools: {} },
  instructions: `You are the repo desk agent for ${ROLE} on Talang, a sealed-bid repo desk on Canton. `
    + 'Start from portfolio. Call margin only on a repo whose coverage is below 1 at a FRESH mark, and say why in numbers. '
    + 'Approve a substitution only if wouldCover >= 1 at a fresh mark. When quoting, keep the haircut at or below '
    + 'maxHaircutThatCovers or the borrower cannot take the quote. Ask the human before any write unless told to act.' });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const out = await run(req.params.name, req.params.arguments);
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e.message.replace(/^submit \d+: /, 'ledger refused: ') }] };
  }
});
await server.connect(new StdioServerTransport());
