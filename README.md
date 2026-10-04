# Talang

A sealed-bid repo desk on Canton. A borrower asks a panel of lenders for cash
against bonds; each lender's rate and haircut reach the borrower and nobody else.
The quote the borrower takes opens a repo that lives on the ledger until it is
repurchased.

| Step | Who | What the ledger enforces |
|---|---|---|
| Request | borrower | Only the invited lenders see it, and it carries no rate |
| Quote | lender | Full principal locked behind the quote; rivals and the regulator never receive it |
| Award | borrower | Opening leg atomic: bonds pledged, cash delivered, losers refunded unrevealed |
| Margin call | lender | Shortfall computed from the valuation agent's signed mark, not from either side |
| Substitution | borrower, then lender | Swap happens only if the substitute covers what is owed at a fresh mark |
| Repurchase | borrower | Principal plus ACT/360 interest, collateral home, change returned |
| Default | lender | After an unanswered call or past maturity, the pledge goes to the lender |
| Report | regulator | Sees every lifecycle event of an open repo, nothing upstream of it |

Holdings and pledges implement the Canton Token Standard `HoldingV1` interface,
so a standard wallet shows a pledge as a locked position.

## Build and test

```
daml build --all
cd test && daml test
```

## Run the desk on DevNet

The package `talang-desk` is live on the NODERS HackCanton DevNet participant.
Put the M2M client settings in `.env.noders` (gitignored), then:

```
npm run seed     # one repo in every state: sealed quotes, live, under margin call, closed
npm run desk     # http://localhost:8090, switch roles in the sidebar
npm run marks    # re-publish fresh marks; the contract refuses marks older than 24h
```

The hosted copy is read-only: `api/` exposes reads only, scoped to this desk's
parties, and has no submit endpoint.

## Prior work disclosure

Talang reuses patterns from [Tirai](https://github.com/PugarHuda/tirai) (HackCanton
Season 2): escrow-on-quote, sealed quotes with no observers, regulator reports.
The repo model, margin, substitution, default and interest logic in
`daml/Talang.daml` are new. Work started on 2 October 2026, before the Season 4
delivery phase; commits from 13 November 2026 onward are the delivery-phase work.

## AI desk agent (MCP)

`mcp/server.mjs` puts Claude at one lender's desk. It reads only that lender's node,
so it is bound by the same privacy as a human trader: it never sees a rival's rate.

| Tool | What it does |
|---|---|
| `portfolio` | Every repo the lender funded: owed now, mark, coverage, units short, open calls, substitutions to review |
| `open_requests` | Requests to quote, with collateral value and the largest haircut that still covers |
| `quote` | Seal a rate and haircut, locking the principal |
| `call_margin` | Call margin at the latest fresh mark; the contract computes the units and refuses if covered |
| `review_substitution` | Approve or decline offered collateral; approval re-checks coverage |
| `privacy_check` | Count what the node holds that is not the lender's own |

Claude Desktop / Claude Code config:

```json
{ "mcpServers": { "talang-lenderB": {
  "command": "node", "args": ["<repo>/mcp/server.mjs"], "env": { "TALANG_ROLE": "lenderB" } } } }
```

`npm run e2e:mcp` drives it end to end on DevNet: rival quotes invisible, a margin call
on a covered repo refused by the ledger, then accepted after a 6% markdown.
