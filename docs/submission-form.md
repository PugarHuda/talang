# AppsFactory submission — paste-ready

Items marked **[cek]** are facts to verify before submitting. Nothing here claims more
than README and docs/evidence show.

---

## Project page

**Project name:** Talang

**Track:** Financial Applications

**Challenges:** BitSafe — Contribution Pool · NODERS (DevNet / NaaS) · Grofty Wallet (only if you run the live wallet flow before submitting) · BitSafe — Gold (only after NODERS + BitSafe confirm late entry)

**Elevator pitch (≤2000):**
Talang is a sealed-bid repo desk on Canton. A fund that holds tokenized Treasuries asks a panel of lenders for cash against them; each lender's rate and haircut is sealed to the borrower alone, because on Canton a quote that names only the lender and the borrower is never sent to anyone else's node. The borrower takes the cheapest quote that covers the loan, and in one atomic transaction the bonds are pledged, the cash is delivered and the losing lenders are refunded, told only their rank. The repo then lives on the ledger: margin calls computed from a signed mark and refused when the repo is still covered, substitution only with the lender's consent, rolls, repurchase with a venue fee that cannot be skipped, and default that returns any excess collateral to the borrower. The regulator observes every lifecycle event and gets best-execution records with no lender names and no losing rates.
Marks come from a BitSafe valuation committee: a decentralized party hosted on three participants through BitSafe's Decentralization Manager, where one pricer alone is refused and two of three publish; it keeps publishing with one node down. Both legs can be CIP-0056 tokens: on DevNet a repo has run with Canton Coin as cash and CBTC as collateral, each allocated through its registry and settled atomically at repurchase. A wallet's key (CIP-0103) can authorise each desk command, so a borrower can verify which key sealed a quote. MCP agents sit at the lender, borrower and regulator desks, each reading only its own node.
Live on the NODERS DevNet participant; one-command LocalNet demo for BitSafe; 22 Daml tests, 33 MCP end-to-end checks, 29 Playwright checks.

**Tech stack:** Daml 3.4, Canton, JSON Ledger API v2, CIP-0056 Token Standard, DA Utility Registry, BitSafe Decentralization Manager (governance-core-v1, governance-action-v1), CIP-0103 dApp SDK, Grofty Wallet, MCP (Model Context Protocol), Node.js, Vercel, Playwright, Docker

**Links:** repo https://github.com/PugarHuda/talang · desk https://talang-desk.vercel.app/desk · landing https://talang-desk.vercel.app · video: media/talang-desk-captioned.mp4 (upload to YouTube and paste the link) [cek]

**Contacts:** Telegram: [your handle] · Email: hudapugar@gmail.com

---

## Value / problem statement

### 1. The problem in one sentence

**Funds holding tokenized government bonds** struggle to **raise short-term cash against them without telling the market they need it**, because **asking a panel of dealers for a repo quote shows every dealer the request, and the losing dealers keep that knowledge**, which costs them **rate (they split requests or stay with one dealer to avoid the leak) and operational risk (margin, substitution and default handled in spreadsheets and email after the trade)**.

### 2. The value you create

| | Today | With Talang |
| --- | --- | --- |
| **What the user does** | Asks dealers one by one or stays with one; margin calls computed in each side's spreadsheet from its own price; substitutions by email; regulator gets a reconstructed report | Sends one request to a panel; each quote is sealed to the borrower alone; awards the cheapest quote that covers; margin, substitution, rolls, repurchase and default are contract choices; the regulator observes events as they happen |
| **Time / cost / risk** | Information leak priced into the rate; settlement risk at open; disputes over whose price is right | Losing lenders learn only their rank; pledge and cash in one atomic transaction; margin only from a committee-signed mark (2 of 3), refused when the repo is still covered |

- **Value proposition in one line:** competitive repo pricing without broadcasting that you need cash, and a repo whose lifecycle the ledger enforces.
- **Why users would switch:** better rates from a real panel without the leak, and no reconciliation between two spreadsheets for margin and default.

### 3. Why it matters

- **Cost of the problem:** repo is the main way bond holders fund themselves short term; the US repo market alone runs in the trillions of dollars per day [cek: OFR / Federal Reserve repo data]. A few basis points of information leakage on a large ticket is real money (at 10 bp a year, 9.5M for 60 days is 1,583.33 — the venue fee Talang charges, shown for scale).
- **How many have it:** every fund, treasury and dealer that funds bond positions; on Canton, every holder of tokenized Treasuries or T-bill tokens that needs stablecoin liquidity.
- **Evidence:** repo on distributed ledgers is already in production on Canton (Broadridge Distributed Ledger Repo [cek]); dealers' practice of splitting RFQs to limit information leakage is widely described in market-structure literature [cek: add one source]. No customer interviews yet — see Hypotheses.

### 4. Why now

- **What changed:** tokenized Treasuries and stablecoins now exist on Canton as CIP-0056 tokens (USDCx, CBTC, Canton Coin, DA Utility registry), so both legs of a repo can settle on-ledger; BitSafe's Decentralization Manager makes a multi-party price committee practical.
- **Why not before:** without a common token standard each registry needed custom settlement; without sub-transaction privacy a sealed panel needed commit-reveal or a trusted operator.

### 5. Why Canton

- **What Canton makes possible:** a quote whose only stakeholders are lender and borrower never reaches rival nodes; the regulator is an observer on reports and absent from quotes; pledge, cash and refunds settle atomically; a decentralized party (BitSafe) signs the marks.
- **Why not a public chain or a database:** on a public chain every quote is visible to every node, so a sealed panel needs ZK or a trusted operator; a database needs one operator everyone trusts with every quote and every price.

---

## ICP — Ideal Customer Profile

### 1. Who they are

| | |
| --- | --- |
| **Segment** | Holders of tokenized government bonds / T-bill tokens on Canton that need stablecoin liquidity (borrowers); Canton-native liquidity providers and market makers with idle stablecoin (lenders) |
| **Company size / stage** | Funds, corporate treasuries and trading firms already operating a Canton participant or using a NaaS provider |
| **User** | Treasury / funding desk trader (borrower); repo or liquidity desk trader (lender); compliance officer (regulator view) |
| **Buyer** | Head of treasury or funding (borrower side); the venue operator pays nothing and earns the fee |
| **Geography** | US and EU, where tokenized Treasury and repo activity on Canton is concentrated [cek] |

### 2. Their pain

- **Top pain point:** "When I ask five lenders for cash against my Treasuries, all five learn I need liquidity and what I hold; four of them didn't win and still know."
- **How often:** every funding need — daily to weekly for an active treasury.
- **What it costs:** worse rates from fewer competing quotes; operational time and disputes on margin calls; settlement risk at open.
- **How they solve it today:** one trusted dealer, split requests over days, bilateral spreadsheets and email for the lifecycle.

### 3. What they want

- **Job to be done:** "When I need cash for days to weeks against bonds I hold, I want competitive quotes without broadcasting my need, so I can fund cheaply and keep my position private."
- **What would make them switch:** a measurably better awarded rate with no information leak, and margin/default they don't have to reconcile.
- **What would stop them:** the collateral registry or cash token they use not being supported; legal agreement (GMRA) mapping; trust in the price source — answered by the BitSafe committee.

### 4. Where to find them

- **Communities and channels:** Canton Network ecosystem (Canton Foundation working groups, HackCanton), DA / NaaS provider customer channels, repo-market conferences (ICMA) [cek].
- **Tools they rely on:** Canton participants (own or NaaS such as NODERS), CIP-0056 registries (DA Utility, BitSafe CBTC), CIP-0103 wallets.
- **Real examples that fit:** Broadridge DLR participants [cek]; Canton-native liquidity providers in the HackCanton / Canton Foundation ecosystem [cek: name 2 you can link].

### 5. Who is NOT our customer (for now)

- Retail users: repo is an institutional product with legal agreements.
- Uncleared bilateral repo between parties who already trust one dealer and don't care about leakage.
- Tri-party repo with a clearing agent: not built; Talang is bilateral with on-ledger enforcement.

---

## Hypotheses (what is validated, what is not)

| Hypothesis | How we test it | Status |
| --- | --- | --- |
| Borrowers get better rates when quotes are sealed from rivals | Shadow book on DevNet: quotes per request, spread to best rate | Not yet tested with users |
| At least two lenders quote on most requests | Pilot: count quotes per request | Not yet |
| A committee-signed mark removes margin disputes | Pilot: margin calls issued vs. disputed | Mechanism built and run (LocalNet, sandbox); no users yet |
| Regulators accept best-execution records without names | Show to a compliance officer | Not yet |

No user interviews have happened yet; the validation log in BRIEF.md is deliberately empty.

---

## GTM — Go-to-Market

### 1. Positioning

For **funds and treasuries holding tokenized government bonds on Canton** who **need short-term cash without advertising it**, **Talang** is a **sealed-bid repo desk** that **gets them competing quotes no rival lender can see and enforces the repo's whole lifecycle on the ledger**. Unlike **asking dealers one by one and managing margin in spreadsheets**, **each quote reaches only the borrower's node, and margin, substitution, repurchase and default are contract choices driven by a committee-signed price**.

- **What users do today instead:** one trusted dealer or split requests over days; bilateral spreadsheets and email for margin and substitution.
- **Why Canton:** sub-transaction privacy is the product — a quote whose stakeholders are lender and borrower is never sent to other nodes; atomic DvP of CIP-0056 cash and collateral; decentralized parties (BitSafe) for the price committee.

### 2. First customers

- **Segment:** holders of tokenized Treasuries / T-bill tokens on Canton needing stablecoin for days to weeks (borrowers), and Canton-native liquidity providers with idle stablecoin seeking secured yield (lenders).
- **Why them first:** they already run Canton participants and hold CIP-0056 assets, so no new infrastructure; small tickets can start on DevNet as a shadow book.
- **First targets (hypothesis, not yet contacted):** issuers and holders of tokenized Treasury products on Canton, CBTC holders via BitSafe, liquidity providers active in HackCanton / Canton Foundation channels [cek: name them].

### 3. Distribution channels

| Channel | Why it reaches our users | First concrete action | Effort / cost |
| --- | --- | --- | --- |
| NaaS providers (NODERS) | They host the participants our users run on | Offer Talang as a deployable app to NODERS tenants; ask for an intro to 2 tenants | Low |
| Token registries (DA Utility, BitSafe CBTC) | Holders of the collateral and cash we settle | Publish the CIP-0056 leg templates and ask BitSafe for CBTC-holder intros | Low |
| Wallets (Grofty, CIP-0103) | Users' signing keys; wallet-authorised desk commands | Grofty bounty demo; list Talang in the wallet's dApp directory | Low |
| Canton Foundation / Featured App program | Ecosystem visibility and rewards | Apply as a Featured App after the MainNet pilot | Medium |
| Direct outreach to repo desks | Institutional funding desks | Shadow-book offer: run real requests without moving value | Medium |

### 4. Acquisition hypotheses

| Hypothesis | How we test it | Success metric | Status |
| --- | --- | --- | --- |
| Borrowers will send real requests to a shadow book because sealing removes the leak | DevNet shadow book, 2 weeks | ≥ 10 requests from ≥ 1 borrower | ⏳ not started |
| Lenders will quote because principal-locked quotes and committee marks reduce default risk | Same pilot | ≥ 2 quotes on ≥ 70% of requests | ⏳ not started |
| NaaS tenants adopt via their provider's recommendation | Ask NODERS for 2 tenant intros | 1 tenant runs the desk | ⏳ not started |

### 5. Business model

- **Who pays:** the borrower, a venue fee in bp per annum of principal (ACT/360), collected inside every repurchase and roll so it cannot be skipped — built.
- **Pricing hypothesis:** 5–10 bp p.a. (10 bp in the demo: 9.5M for 60 days pays 1,583.33).
- **Revenue on Canton:** venue fees; Featured App activity rewards once listed (not built yet).
- **Why now:** CIP-0056 tokens (CBTC, USDCx) and DecMan make both legs and the price source available on-ledger today.

### 6. First 90 days

| Period | Milestone | How we'll know it's done |
| --- | --- | --- |
| Weeks 1–4 | BitSafe-co-hosted decentralized committee on DevNet; shadow book with 1 borrower + 2 lenders | Committee marks drive margin calls on DevNet; first real requests logged |
| Weeks 5–8 | MainNet deployment with USDCx cash and one tokenized-bond registry, capped tickets | First repo opened and repurchased on MainNet |
| Weeks 9–12 | Regulator/auditor observer node; Featured App application | Observer node live; application submitted |

### 7. Risks and what we need

- **Could block adoption:** legal mapping to GMRA; registry support for each collateral; liquidity on the lender side; node access (app users cannot upload packages or grant rights on shared nodes).
- **What we need:** intros to tokenized-Treasury holders and liquidity providers; BitSafe co-hosting nodes; a NaaS tenant for the pilot.

---

## Metrics / Validation Evidence

### 1. North Star metric

- **Metric:** repos awarded per week where at least two lenders quoted.
- **Why:** it grows only if borrowers trust the sealing enough to ask and lenders trust it enough to compete.
- **How measured:** count of `BestExecution` records with at least 2 quotes weighed, read from the regulator's node.

### 2. What we needed to validate

| Assumption | Why it matters | Status |
| --- | --- | --- |
| Users have this problem | Without a leakage cost there is no reason to switch | ⏳ testing — no interviews yet |
| They would use our solution | Needs both sides to show up | ⏳ testing — shadow-book pilot planned |
| They would pay or switch | The venue fee is the business | ⏳ testing |
| The mechanism works on real infrastructure | Partners need proof before a pilot | ✅ confirmed on NODERS DevNet and a 3-participant DecMan LocalNet |

### 3. Conversations

No user interviews have happened yet. Ecosystem conversations that changed the build:

| # | Who | Date | Key takeaway |
| --- | --- | --- | --- |
| 1 | BitSafe (sponsor) | 9 Oct 2026 | 2-of-3 is the right setup; the demo must show a proposed action and its use → built the one-command LocalNet demo around a proposed mark |
| 2 | Grofty Labs (sponsor) | 9 Oct 2026 | Grofty can't vet third-party DARs, only token-standard operations → the wallet now authorises desk commands by a signed challenge instead of submitting Talang commands |
| 3 | NODERS (node operator) | Oct 2026 | App users can't upload packages or grant rights → packages via the console, rights requested from the operator |

### 4. Tests and results

- **What we tried:** the full flow on the NODERS DevNet participant, a 3-participant DecMan LocalNet, a local sandbox, and automated suites.
- **What happened:** 22/22 Daml tests; 33/33 MCP end-to-end checks; 29/29 Playwright desk checks; 45/45 read-only API checks; DecMan committee 8/8 steps with 2 expected refusals; node-offline run 6/6; real CBTC repo on DevNet 7/7 steps; Canton Coin cash + CBTC collateral repo on DevNet 12/12 steps.
- **What we changed:** Playwright QA found 10 bugs (a double submit on repaint, an empty haircut sent as 0%, float precision refused by the ledger, …), all fixed; a margin call can no longer give the borrower under 2 hours; default now returns excess collateral (GMRA close-out).

### 5. Product and on-ledger metrics

| Metric | How we measure it | Now | Target by submission |
| --- | --- | --- | --- |
| Users who tried the demo | Not tracked | 0 external | — |
| Users who completed the core flow | Not tracked | 0 external | — |
| Transactions on DevNet | Live `talang-repo` contracts read from the NODERS participant through the hosted API (9 October, evening) | 13 open repos, 25 lifecycle reports, 16 best-execution records, 6 margin calls, 14 loss notices; 1 CBTC-collateral repo and 1 repo with Canton Coin cash and CBTC collateral, both opened and repurchased | same |
| Active parties | Desk parties with act-as on DevNet | 7 (borrower, 2 lenders, regulator, cash issuer, bond issuer, valuation agent) | 12 once NODERS grants lender C and the committee |

### 6. Success criteria after the hackathon

| Metric | Target in 90 days |
| --- | --- |
| Repos awarded with ≥ 2 quotes | 20 (shadow book + MainNet pilot) |
| Borrowers / lenders onboarded | 1 / 2 |
| Time from request to award | under 10 minutes |

### 7. What we still don't know

- Whether borrowers value sealing enough to change dealers → shadow-book pilot.
- Whether lenders accept committee marks for margin → pilot with the BitSafe committee on DevNet.
- Legal mapping of on-ledger default to GMRA → legal review before MainNet.

---

## Demo

- **Live demo URL:** https://talang-desk.vercel.app/desk
- **Demo video link:** [upload the pitch video to YouTube (unlisted) and paste the link]
- **GitHub Repository:** https://github.com/PugarHuda/talang

## Pitch

Upload `media/talang-pitch-deck.pdf` (max 10 MB).

---

## MVP summary

- **Built and running:** Daml model (RFQ, sealed quotes, award, best execution, loss notices, margin, substitution, roll, repurchase with venue fee, default with excess returned), 22 Daml tests; desk UI per role with a side-by-side privacy view; three MCP agents; hosted desk reading live DevNet data.
- **On DevNet (NODERS):** `talang-repo` 1.0.0 vetted and seeded; a repo with both legs in real tokens — Canton Coin cash and CBTC collateral, allocated through their registries, awarded and repurchased (docs/evidence/token-repo-amulet-cbtc-devnet.json).
- **BitSafe:** valuation committee onboarded through DecMan on a 3-participant LocalNet, one command (`bash localnet/demo.sh reset`); 1-of-3 refused, 2-of-3 executed, survives one node down; the same flow in DecMan's own UI in `media/decman-demo-captioned.mp4`.
- **Wallet:** CIP-0103 wallet key authorises desk commands (signed single-use challenges); venue fee payable in USDCx/CC via Grofty.
- **Not yet:** USDCx on DevNet, a live Grofty wallet run, user validation.

---

## Pitch (30 seconds)

Repo is how bond holders raise cash. Asking for a price tells every dealer you need it. Talang is a repo desk on Canton where each lender's quote is sealed to the borrower alone — rival nodes never receive it — and the repo then lives on the ledger: margin from a BitSafe committee-signed mark, substitution, rolls, repurchase with a venue fee, default that returns the excess. It runs on the NODERS DevNet with real CBTC collateral through the DA Utility registry, and the BitSafe committee survives a node going down. The regulator sees every event and proof of best execution, and never a losing quote.
