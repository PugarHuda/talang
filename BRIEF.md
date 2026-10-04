# Talang · business brief

**One line.** A repo desk on Canton where a borrower gets cash against bonds from a
panel of lenders, each lender's rate sealed to the borrower alone, and the repo then
lives on the ledger: margin, substitution, repurchase and default enforced by contract.

## The problem

Repo is how holders of high-grade bonds raise short-term cash without selling them.
Asking for a price is itself information. When a fund asks five dealers for cash
against a block of Treasuries, all five learn that the fund needs liquidity and what
it holds, and the losing four keep that knowledge. Large holders split requests
across days or stay with one dealer to avoid the leak, and pay for it in rate.

After the trade, the work is manual. Margin calls are computed in each side's own
spreadsheet from its own price, substitutions travel by email, and the regulator gets
a periodic report reconstructed after the fact.

## Who it is for (ICP)

**Borrower:** a fund or treasury that holds tokenized government bonds or T-bill
tokens on Canton and needs USDC for days to weeks without selling. It cares about the
rate and about not advertising that it is raising cash.

**Lenders:** Canton-native liquidity providers and market makers with idle stablecoin
who want secured yield. They care about the haircut, the collateral's price source,
and getting the collateral if the borrower does not pay.

**Regulator or auditor:** needs every live repo and every lifecycle event, and has
no use for the losing quotes.

## What Talang does

| Pain | What the ledger enforces |
|---|---|
| Asking leaks to every dealer | Each quote is signed by lender and borrower only; rivals and the regulator never receive it |
| Quotes that cannot be funded | The lender locks the full principal behind its quote |
| Settlement risk at open | Bonds pledged and cash delivered in one atomic transaction; losing lenders refunded in the same one |
| Disputed margin calls | Units due computed from a valuation agent's signed mark, refused when the repo is still covered |
| Substitution by email | Swap only with the lender's consent and only if the new collateral covers at a fresh mark |
| Default handling | After an unanswered call or past maturity the pledge goes to the lender, by contract |
| After-the-fact reporting | The regulator is an observer of every lifecycle event as it happens |

An MCP agent sits at a lender's desk: it reads only that lender's node, ranks repos by
coverage, and drafts or issues margin calls the contract then re-checks.

## Why Canton

The product is the privacy model. On a public chain every quote is visible to every
participant, so a sealed panel needs commit-reveal schemes, zero-knowledge proofs or
a trusted operator. On Canton a quote that names only the lender and the borrower as
stakeholders is never sent to anyone else's node. The regulator's view is the same
mechanism in reverse: an observer on reports, absent from quotes. Holdings and
pledges implement the Canton Token Standard (CIP-0056), so tokenized collateral and
stablecoin cash from existing registries can be the two legs.

## Who pays

A venue fee in basis points per annum of the principal, collected inside the
repurchase so it cannot be skipped. **Not built yet.** Tirai (Season 2) collects a
venue fee inside settlement the same way, so the pattern is proven; in Talang it is
one field and a split in `Repurchase`.

## Pilot plan

1. **Shadow book on DevNet (2 weeks).** One borrower and two lenders run their real
   collateral list and real rates through the desk without moving value. Measure: time
   from request to award, quotes per request, margin calls the contract would issue.
2. **Small live repos on MainNet (4 weeks).** Collateral from one tokenized-bond
   registry and cash in USDCx, both through CIP-0056. Ticket size capped. Measure:
   repos opened, repurchased on time, calls answered within the window.
3. **Independent marks and a regulator node.** The valuation agent becomes a real price
   provider signing marks; an auditor or regulator runs an observer node.

**Integrations needed:** a CIP-0056 registry for the collateral (tokenized bonds or
T-bills) and one for the cash leg (USDCx or Canton Coin), a price provider to sign
marks, and wallets for the parties (CIP-0103).

## Evidence today

- Contract: 6 Daml scripts, including the full lifecycle, default paths and every
  refusal (`test/daml/TalangTest.daml`).
- Live on the NODERS HackCanton DevNet participant: requests, sealed quotes, open repos,
  a margin call, a substitution and a repurchase, all created through the desk.
- Privacy read from each node: lenders see 0 rival quotes, the regulator sees only reports.
- MCP agent: 11/11 end-to-end checks on DevNet (`npm run e2e:mcp`).

## Validation log

Conversations with borrowers, lenders and operators go here, dated, with what they
said in their words. Empty rows are deliberate: this table records only conversations
that happened.

| Date | Who (role, firm type) | What they said | What it changes |
|---|---|---|---|
| | | | |

## Success criteria for the pilot

- A borrower takes a quote in under ten minutes from request.
- At least two lenders quote on most requests.
- Every margin call issued is answered or defaulted inside its window, with no dispute
  over the units due.
- Zero rival quotes visible on any lender node, checked on every run.
