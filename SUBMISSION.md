# Talang · HackCanton Season 3 submission

**Track:** Financial Applications / DeFi
**Sponsor challenges:** BitSafe Decentralization Manager (Contribution Pool); NODERS DevNet; CIP-0056 token settlement (Canton Coin, CBTC; USDCx not yet)
**Repo:** https://github.com/PugarHuda/talang
**Live desk:** https://talang-desk.vercel.app/desk (read-only, NODERS DevNet)
**Videos:** pitch `media/talang-pitch.mp4` (subtitled); desk walkthrough `media/talang-desk-captioned.mp4` (73 s, captioned, recorded against a seeded local ledger by `scripts/record-desk.mjs`); BitSafe DecMan demo `media/decman-demo-captioned.mp4` (79 s, DecMan's own UI on the three-participant LocalNet)
**Verify in 2 minutes:** README.md, section "Verify in 2 minutes".

## One line

A repo desk on Canton where a borrower gets cash against collateral from a panel of
lenders, each lender's rate sealed to the borrower alone, and the repo then lives on
the ledger: margin, substitution, rolls, repurchase and default enforced by contract,
priced by a BitSafe decentralized committee, settled in real token-standard assets.

## Value

Asking for a repo price leaks. When a fund asks five dealers for cash against a block
of Treasuries, all five learn it needs liquidity and what it holds, and the four that
lose keep that knowledge. Large holders split requests across days or stay with one
dealer, and pay for it in rate. After the trade, margin calls are argued from each
side's own spreadsheet and the regulator gets a report rebuilt after the fact.

On Talang a quote is a contract signed by one lender and the borrower and nobody else,
so it never reaches a rival's node. The borrower can still prove best execution: the
regulator gets how many quotes were weighed and where the winner ranked, and each loser
gets its rank, without a single losing rate or name leaving the borrower. Margin is
computed from a mark that k of n independent pricers must confirm, so neither side and
no single operator can move it.

## ICP

- **Borrower:** a fund or corporate treasury holding tokenized government bonds,
  T-bill tokens or CBTC on Canton that needs stablecoin for days to weeks without
  selling, and does not want to advertise that it is raising cash.
- **Lenders:** Canton-native liquidity providers, market makers and bank desks with
  idle USDCx who want secured yield, and care about the haircut, who sets the price,
  and getting the collateral if the borrower does not pay. A lender can be a
  syndicate that decides by threshold.
- **Regulator or auditor:** needs every live repo and every lifecycle event as it
  happens, and evidence of best execution, with no use for the losing quotes.

## Metrics

Measured on 9 October: on a Canton 3.4.11 sandbox (`npm run e2e:mcp`, `npm run governance`, `npm run qa:desk`, CI), and with fetch stubbed for the hosted API (`npm run test:proxy`):

| Metric | Value |
|---|---|
| Rival quotes visible on any lender node | 0, checked on every run |
| Requests, quotes or loss notices visible to the regulator | 0 |
| Repo states seeded through the Ledger API | 6 (sealed, live, substitution pending, margin call, roll, closed with fee) |
| Daml scripts / MCP end-to-end checks | 22 / 33 |
| Playwright desk checks / read-only API checks | 29 / 45 |
| Governed mark below threshold | refused by BitSafe's `GovernanceRules` |

Targets for the pilot (BRIEF.md):

- A borrower takes a quote in under ten minutes from request.
- At least two lenders quote on most requests.
- Every margin call is answered or defaulted inside its window, with no dispute over units.
- Zero rival quotes visible on any lender node, every run.

No user interviews are claimed here. The validation log in BRIEF.md records only
conversations that happened.

## GTM

1. **Shadow book on DevNet (2 weeks).** One borrower and two lenders run their real
   collateral list and rates through the desk without moving value.
2. **Small live repos on MainNet (4 weeks).** Collateral from one tokenized-bond or
   CBTC registry, cash in USDCx, both through CIP-0056. Ticket size capped.
3. **Independent marks and a regulator node.** The valuation committee becomes a
   BitSafe decentralized party run by independent price providers; an auditor runs
   an observer node.

**Revenue:** a venue fee in bp per annum of principal, collected inside the
repurchase and every roll, so it cannot be skipped. Built and tested.

## MVP

- **Contract** (`daml/Talang.daml`, `daml/TalangGovernance.daml`): request, sealed
  quotes in desk cash or a CIP-0056 allocation, atomic award, loss notices, best
  execution, margin calls from fresh marks, substitution, rolls, repurchase in desk
  cash or as a standard allocation request, venue fee, default, regulator reports;
  BitSafe-governed marks and lender syndicates.
- **Tests:** 22 Daml scripts including every refusal, the token rail against a
  registry implementing the Splice interfaces, and BitSafe's own `GovernanceRules`.
- **Desk** (`web/`, `server.mjs`): one page per role, each reading only its own node.
- **AI agents** (`mcp/server.mjs`): lender, borrower and regulator desks over MCP.
- **Runs without credentials:** `npm run local` + sandbox reproduces everything; CI
  does it on every push.

**Also run:** the valuation committee onboarded through BitSafe DecMan and hosted on a
three-participant LocalNet; it publishes with one node down and cannot with two.
Marks come from live sources (US Treasury par yields, three BTC exchanges).

**On DevNet:** `talang-repo` 1.0.0 vetted on the NODERS participant and seeded; the hosted desk reads it (docs/evidence/devnet-run.log). A repo with both legs in real tokens, Canton Coin cash and CBTC collateral, each allocated through its registry, awarded and repurchased, 12 of 12 steps (docs/evidence/token-repo-amulet-cbtc-devnet.json).

**Not yet:** USDCx on DevNet (no registry or faucet documented there); Grofty Wallet on TestNet.

**Real CBTC on DevNet:** the BitSafe faucet's CBTC accepted, allocated through the DA Utility registry as repo collateral, and released at repurchase (docs/evidence/cbtc-rail-devnet.json). The first version (0.1.0) was
uploaded to the NODERS DevNet participant and driven through the desk on 3 October
(commit `900da46`; package `237ad836…54f78194b`, vetted since 3 October), with no update ids recorded.

## Pitch: 4-minute demo script

1. **(0:00) The leak.** "Asking five dealers for repo tells all five you need cash."
   Show the borrower sending one request to three lenders.
2. **(0:30) Sealed.** Switch to Lender A, then Lender B: each sees only its own quote.
   Run `privacy_check` from Lender B's MCP agent: 0 rival quotes.
3. **(1:00) Award and best execution.** The cheapest rate's haircut does not cover, so
   the borrower takes rank 2. Switch to Lender A: "rank 3 of 3", nothing else. Switch
   to the regulator: 3 quotes weighed, winner rank 2, 10 bp over best, no names.
4. **(1:45) The price.** `npm run governance`: one pricer's mark is refused by BitSafe's
   GovernanceRules; two of three publish. A rogue single-pricer mark cannot drive a
   margin call; the governed markdown can.
5. **(2:30) Life of the repo.** Lender's agent calls margin on a short repo; offers a
   roll; borrower's agent accepts and pays the interest so far plus the venue fee.
6. **(3:15) Real assets.** On DevNet, Canton Coin cash and CBTC collateral as registry
   allocations, awarded and repurchased (`docs/evidence/token-repo-amulet-cbtc-devnet.json`).
   `TokenTest`: USDCx quotes; repurchase appears in any wallet as an allocation request;
   default executes the CBTC to the lender.
7. **(3:45) Close.** Regulator view: every event, every fee, no losing rate anywhere.
