# Talang

Landing: https://talang-desk.vercel.app · desk: https://talang-desk.vercel.app/desk
(read-only; it reads `talang-repo` 1.0.0 contracts seeded on the NODERS DevNet participant) · desk walkthrough: [media/talang-desk-captioned.mp4](media/talang-desk-captioned.mp4) (73 s, captioned screen capture of the local desk, recorded by `scripts/record-desk.mjs`)

A sealed-bid repo desk on Canton. A borrower asks a panel of lenders for cash
against collateral; each lender's rate and haircut reach the borrower and nobody
else. The quote the borrower takes opens a repo that lives on the ledger until it
is repurchased: margin, substitution, rolls, repurchase and default are enforced by
contract, the price source can be a BitSafe decentralized party, and both legs can
be real Canton Token Standard assets such as USDCx and CBTC.

| Step | Who | What the ledger enforces |
|---|---|---|
| Request | borrower | Only the invited lenders see it, and it carries no rate |
| Quote | lender | Full principal locked behind the quote, as a desk escrow or a CIP-0056 allocation; rivals and the regulator never receive it |
| Award | borrower | Opening leg atomic: collateral pledged, cash delivered, losers refunded unrevealed |
| Loss notice | each loser | Told its rank among the quotes weighed, and nothing else: no winning rate, no winner |
| Best execution | regulator | How many quotes were weighed, the winner's rank on rate, the gap to the best rate in bp; no lender named |
| Margin call | lender | Shortfall computed from the valuation agent's mark, refused while the repo is covered |
| Substitution | borrower, then lender | Swap happens only if the substitute covers what is owed at a fresh mark |
| Roll | lender offers, borrower accepts | Interest so far paid now, new rate from today, coverage re-checked at a fresh mark |
| Repurchase | borrower | Principal plus ACT/360 interest to the lender, the venue's fee to the operator, collateral home, change returned |
| Default | lender | After an unanswered call or past maturity, the pledge goes to the lender |
| Report | regulator | Every lifecycle event of an open repo, nothing upstream of it |

## Why Canton for a sealed-bid repo RFQ

| | Public EVM chain | Privacy L2 / Sui-style object chain | Canton |
|---|---|---|---|
| Who sees a lender's rate and haircut | Everyone: calldata and mempool are public | Hidden only behind ZK proofs, encryption or an enclave the desk has to build and keep audited | The borrower who asked; the quote has no other stakeholder, so no other node receives it |
| Opening leg: cash to the borrower, collateral to the lender | Atomic on one chain, with both amounts public | Atomic on its own chain; assets from other issuers arrive through a bridge | One Daml transaction across both legs, including CIP-0056 assets from separate registries (USDCx, CBTC) |
| Regulator view | The same public data as everyone, or an off-chain report | Viewing keys or a separate disclosure channel | `RepoReport` and `BestExecution` contracts with the regulator as observer: lifecycle and winner's rank, no losing rates, no lender named |
| k-of-n governance of marks and lender syndicates | A multisig contract; votes and prices public | A multisig or committee scheme per chain | BitSafe `GovernanceRules` on a decentralized party hosted on several nodes; on LocalNet it still publishes with one of three nodes down, not with two |

![Landing](docs/img/landing-desktop.png)

The desk is at `/desk` (`?role=lenderB` opens it as a role); the landing page is at `/`.

![Regulator view: best execution with no names, lifecycle with venue fees](docs/img/desk-regulator.png)

## What is new in this version

| | Where | Verified |
|---|---|---|
| **CIP-0056 cash and collateral.** Quotes funded by a USDCx (or any registry) `Allocation`; collateral such as CBTC held as an `Allocation` to the lender that stays executable through the claim window. Repurchase unwinds it, default executes it, margin and substitution add or swap allocations. | `daml/Talang.daml` (`Locked`, `SubmitTokenQuote`, `AwardWithTokenCollateral`, `PostTokenMargin`, `ProposeTokenSubstitution`) | 7 scripts in `test/daml/TokenTest.daml` against a registry that implements the real Splice `Allocation` interface |
| **Token repurchase as a wallet request.** `RepurchaseNotice` implements the standard `AllocationRequest`, so any CIP-0056 wallet shows "allocate 50,125 USDCx to the lender and 2.08 to the venue". A notice is good for the day it names. | `RepurchaseNotice`, `VenueAgreement` | `tokenLifecycle`, `staleNotice` |
| **BitSafe Decentralization Manager.** Marks published by a k-of-n valuation committee; a lender that is a k-of-n syndicate quotes, calls margin, defaults and offers rolls only after a threshold of its members confirms. Uses BitSafe's released `governance-action-v1` and `governance-core-v1` DARs unchanged. | `daml/TalangGovernance.daml` | `test/daml/GovernanceTest.daml`; on a Canton participant by `scripts/governance.mjs` ([evidence](docs/evidence/bitsafe-governed-marks-local-sandbox.json)); live-price oracle, one pricer per exchange, by `scripts/oracle.mjs` ([evidence](docs/evidence/oracle-local-sandbox.json)) |
| **Best execution and loss notices.** | `award` in `daml/Talang.daml` | `bestExecution`, and from every node in `npm run e2e:mcp` |
| **Venue fee**, bp per annum ACT/360, inside repurchase and roll. | `Venue`, `Repurchase`, `Roll` | `venueFeeOnRepurchase`, `tokenLifecycle` |
| **Rolls.** | `RollOffer`, `Roll` | `rollToNewRate`, `rollRefusals` |
| **Three MCP desks**: lender, borrower, regulator. | `mcp/server.mjs` | 19 checks in `scripts/e2e-mcp.mjs` on a Canton participant |

## Build and test

```
daml build --all
cd test && daml test        # 22 scripts: core, desk, CIP-0056 tokens, BitSafe governance
npm run test:proxy          # hosted read-only API, no network or credentials
```

## Tests

Counts are what was observed, with where. "CI" is GitHub Actions run
[37890916049](https://github.com/PugarHuda/talang/actions/runs/37890916049) (commit
`e053a49`, local Canton sandbox 3.4.11).

| Suite | Covers | Result | Where observed |
|---|---|---|---|
| `daml test` (`test/daml/`) | Core lifecycle, default paths and refusals (`TalangTest`); venue fee, best execution, rolls (`DeskTest`); CIP-0056 legs against `MockRegistry` (`TokenTest`); BitSafe valuation committee and lender syndicate on the real `GovernanceRules` (`GovernanceTest`); 1.1.0 rules: 2-hour minimum margin window, default keeps only what is owed and returns the excess (`marginWindowFloor`, `defaultReturnsExcess`, `defaultAcrossPledges`) | 22 of 22 scripts ok (two are setup fixtures) | Locally on 9 October, and in CI |
| `npm run test:proxy` | `api/acs.mjs`, `api/config.mjs` and `api/wallet-verify.mjs` with fetch stubbed (wallet-verify POST only, never reaches the ledger); only POST acs and GET config served, bad roles rejected before the ledger is reached, every ledger call a read scoped to one desk party, no client secret or bearer token in any response, no other file in `api/` | 45 of 45 checks | Locally on 9 October |
| `npm run e2e:mcp` | Every MCP desk end to end: tool lists per role, privacy read from each node, award, roll offered and withdrawn, substitution declined, margin call refused under 2 hours then answered, claim and default refused early, cancel and withdraw unlock cash, repurchase, regulator exposure | 33 of 33 checks (31 of 31 with two lenders) | Local sandbox on 9 October, and in CI |
| `npm run qa:desk` | Playwright through every role and every desk button, outcomes re-read from each node; refusals (short haircut, stale mark, early default, bad inputs, double click), privacy in page and API, read-only mode, server hardening, accessible names, 390 px layout | 29 of 29 checks | Local sandbox on 9 October |
| `scripts/cbtc-rail.mjs` | Real CBTC on DevNet: the faucet's transfer offer accepted through the registry, CBTC allocated through the registry's `AllocationFactory` as repo collateral, award, repurchase cancelling the allocation | 7 of 7 steps | [NODERS DevNet](docs/evidence/cbtc-rail-devnet.json) |
| `npm run governance` | BitSafe 2-of-3 marks: 1-of-3 refused, 2-of-3 executed, margin call on one pricer's own mark refused | 8 of 8 steps (2 expected refusals) | [local sandbox](docs/evidence/bitsafe-governed-marks-local-sandbox.json); [DecMan LocalNet](docs/evidence/bitsafe-governed-marks-localnet.json), 8 of 8 steps |
| `scripts/localnet-offline.mjs` | Committee on three LocalNet participants: publishes with one node stopped, cannot with two | 6 of 6 steps (1 expected refusal) | [DecMan LocalNet](docs/evidence/bitsafe-node-offline-localnet.json) |
| `npm run token-rail` | USDCx-funded sealed quotes, CBTC collateral as an allocation, repurchase read as an `AllocationRequest`, settlement | 8 of 8 steps | [local sandbox](docs/evidence/cip56-token-repo-local-sandbox.json), and in CI |
| `npm run oracle` | Committee of three exchange pricers: honest round published, manipulated round refused, Treasury notes priced | 4 of 4 steps (1 expected refusal) | [local sandbox](docs/evidence/oracle-local-sandbox.json) |

## Run the whole stack locally, no credentials

```
daml sandbox --json-api-port 7575 --dar .daml/dist/talang-repo-1.1.0.dar --wall-clock-time
npm ci
npm run local                               # allocate the desk's parties on the sandbox
ENV_FILE=.env.local npm run seed            # one repo in every state
ENV_FILE=.env.local npm run e2e:mcp         # every MCP desk, 33 checks, privacy read from each node
ENV_FILE=.env.local npm run governance      # BitSafe 2-of-3 marks through GovernanceRules
ENV_FILE=.env.local npm run token-rail      # USDCx quotes, CBTC collateral, repurchase as an AllocationRequest (needs `daml build --all`)
ENV_FILE=.env.local npm run desk            # http://localhost:8090 (landing), /desk?role=lenderB
```

CI runs exactly this on every push (`.github/workflows/ci.yml`).

## Run the desk on DevNet

Put the M2M client settings in `.env.noders` (gitignored), then `npm run upload`
(talang-repo and BitSafe's governance DARs), `npm run seed`, `npm run e2e:mcp`,
`npm run governance` and `npm run desk`, as above without `ENV_FILE`.
`npm run marks` re-publishes fresh marks; the contract refuses marks older than 24h.

The package is `talang-repo` 1.0.0, a new package name: the `talang-desk` 0.1.0
package from the first commits was uploaded to the NODERS DevNet participant, and this
version changes template shapes in ways a smart-contract upgrade may not.

The hosted copy is read-only: `api/` exposes reads only, scoped to this desk's
parties, and has no submit endpoint.

## AI desk agents (MCP)

`mcp/server.mjs` puts Claude at one desk. It reads only that party's node, so it is
bound by the same privacy as a human: a lender's agent never sees a rival's rate,
and the regulator's agent sees reports and nothing upstream.

| Role | Tools |
|---|---|
| `lenderA` / `lenderB` / `lenderC` | `portfolio`, `open_requests`, `quote`, `call_margin`, `review_substitution`, `offer_roll`, `loss_history`, `privacy_check` |
| `borrower` | `quotes` (ranked, with coverage), `award` (`"best"` takes the cheapest covered quote), `book` (owed today incl. venue fee), `accept_roll`, `privacy_check` |
| `regulator` | `lifecycle`, `best_execution`, `privacy_check` |

```json
{ "mcpServers": { "talang-borrower": {
  "command": "node", "args": ["<repo>/mcp/server.mjs"], "env": { "TALANG_ROLE": "borrower" } } } }
```

## Sponsor integrations

| | Status |
|---|---|
| **NODERS DevNet / NaaS** | `talang-desk` 0.1.0 was uploaded to the HackCanton DevNet participant and driven through the desk on 3 October (commit `900da46`; package `237ad836995110225ea8cc6337f8af63d2ed3625d6ee8a5421644b154f78194b`, vetted on participant `hackcanton-devnet-3` since 3 October per the NODERS console); no update ids were recorded for that run. `talang-repo` 1.0.0 (package `24fdd6f484e99f2f5d3c2b84f6e7fdd706ee5eeffed214023347c38bcd3fc3bb`) was uploaded through the NODERS console on 9 October and is vetted on `hackcanton-devnet-3`; the seed ran there from a Vercel build (`scripts/devnet-ci.mjs`), so the hosted desk reads live DevNet repos, margin calls, substitutions, loss notices and best-execution records ([run log](docs/evidence/devnet-run.log)). On DevNet the app user may not upload packages or grant itself rights (both 403), so lender C and the governance committee's parties wait on NODERS granting act-as; the governance run there is **not yet**. |
| **BitSafe Decentralization Manager** | Valuation committee and lender syndicate as `GovernableAction`s on BitSafe's own `GovernanceRules`. Threshold refusal and execution proven in Daml scripts and on a participant. Also run on a three-participant DecMan LocalNet: the committee is onboarded through DecMan and hosted on all three nodes; with one node stopped it still publishes, with two stopped it cannot ([docs/bitsafe.md](docs/bitsafe.md#decman-localnet-three-participants), [evidence](docs/evidence/bitsafe-node-offline-localnet.json)). |
| **CIP-0056: USDCx, CBTC, Canton Coin** | Both legs implemented through the standard `Allocation` / `AllocationRequest` interfaces, tested against a registry implementing them, in Daml scripts and on a participant ([evidence](docs/evidence/cip56-token-repo-local-sandbox.json)). **CBTC is run against the live registry on DevNet** ([evidence](docs/evidence/cbtc-rail-devnet.json)): the BitSafe faucet's transfer offer accepted through the DA Utility registry, CBTC allocated through its `AllocationFactory` (choice context and disclosed contracts from the registry's off-ledger API, `lib/registry.mjs`), held as collateral while the desk's USDC funds the loan, and the allocation cancelled through the registry at repurchase. **Both legs in real tokens on DevNet** ([evidence](docs/evidence/token-repo-amulet-cbtc-devnet.json)): Canton Coin as cash (DevNet tap, the lender's quote funded by an Amulet allocation through the Scan registry's AllocationFactory) and CBTC as collateral; award, repurchase notice, the borrower's Amulet allocation for the 50.01 due, settlement with Amulet to the lender and CBTC home. Any CIP-0056 instrument can be either leg by env (`scripts/token-repo.mjs`, [docs/token-legs.md](docs/token-legs.md)). USDCx: **not yet** on DevNet, where no USDCx registry exists; the TestNet/MainNet presets are ready. |
| **Grofty Wallet (CIP-0103)** | Grofty signs only standard token operations on its own participant, so Talang does not send its Daml commands through it. Instead the wallet's key **authorises the desk**: a desk role bound to a wallet (`TALANG_WALLET_ROLES`) acts only after the wallet signs a single-use challenge naming the exact command (CIP-0103 `signMessage`); the server checks nonce, signer, Ed25519/P-256 signature and that the key's fingerprint is the party's namespace before submitting (`api/wallet-verify.mjs`). Each signed command leaves a receipt, so a borrower can verify which wallet key sealed a lender's quote while rival lenders see nothing. The venue fee can be paid in USDCx or CC with `prepareExecuteAndWait({receiver, amount, tokenSymbol})` on TestNet or MainNet, network shown on the receipt (`web/wallet.js`, `web/wallet-pay.js`, `web/wallet-receipts.js`). Verified with a stub wallet holding a real Ed25519 key against the local ledger; **not yet run with a live Grofty wallet**. |

## Prior work disclosure

Talang reuses patterns from [Tirai](https://github.com/PugarHuda/tirai) (HackCanton
Season 2): escrow-on-quote, sealed quotes with no observers, regulator reports, the
CIP-0056 allocation settlement and its mock registry. Talang itself is new work for
HackCanton Season 3: the first commit is 2 October 2026, inside the delivery phase
(18 September to 9 October). `git log` is the record.
