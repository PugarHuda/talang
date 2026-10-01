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

## Prior work disclosure

Talang reuses patterns from [Tirai](https://github.com/PugarHuda/tirai) (HackCanton
Season 2): escrow-on-quote, sealed quotes with no observers, regulator reports.
The repo model, margin, substitution, default and interest logic in
`daml/Talang.daml` are new. Work started on 2 October 2026, before the Season 4
delivery phase; commits from 13 November 2026 onward are the delivery-phase work.
