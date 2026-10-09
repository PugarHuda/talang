# Research: what Talang can adopt before the deadline

Researched 9 October 2026. Every item has a source, an effort (S < 1 h, M 1-3 h,
L > 3 h) and a sketch naming Talang files. "Unverified" means no doc confirmed it.

Already in Talang (no work needed): ACT/360 interest (`interest` in
`daml/Talang.daml`), haircut per quote, substitution with lender consent, rolls,
per-trade GMRA-style close-out on `Default` (lender keeps what is owed at the call's
mark, excess home).

## Ranked

### 1. Real CBTC on DevNet through the DA Utility registry (M)

Verified values:

| | Value | Source |
|---|---|---|
| CBTC instrument admin (DevNet) | `cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff` | https://github.com/DLC-link/cbtc-lib (README, devnet block) |
| Instrument id | `CBTC` | https://github.com/DLC-link/cbtc-lib/issues/76 |
| Registry host (DevNet) | `https://api.utilities.digitalasset-dev.com` | cbtc-lib README; https://docs.digitalasset.com/registry/apis/open-api-specs/utility-token-standard/v1/allocation-instruction-v1.yaml |
| Base URL | `https://api.utilities.digitalasset-dev.com/api/token-standard/v0/registrars/<admin-party-id>` | https://docs.digitalasset.com/registry/apis/token-standard/off-ledger-api |
| AllocationFactory | `POST {base}/registry/allocation-instruction/v1/allocation-factory`, body `{ "choiceArguments": <AllocationFactory_Allocate args, extraArgs.context = {} and meta = {}>, "excludeDebugFields": true }` → `{ factoryId, choiceContext: { choiceContextData, disclosedContracts[] } }` | allocation-instruction-v1.yaml; https://docs.canton.network/reference/splice-allocation-instruction-v2-api/post-registryallocation-instructionv2allocation-factory |
| Allocation contexts | `POST {base}/registry/allocations/v1/{allocationId}/choice-contexts/execute-transfer` (also `/withdraw`, `/cancel`), body `{ "meta": {} }` | https://docs.digitalasset.com/registry/apis/open-api-specs/utility-token-standard/v1/allocation-v1.yaml |
| BitSafe API (DevNet) | `https://api.devnet.bitsafe.finance` | cbtc-lib README |

Caveats: cbtc-lib has no allocation helper (its README says allocation is the gap,
tracked in issue #81), so call the registry yourself. cbtc-lib says the DA Registry
Utility DARs must be installed on the validator; whether the NODERS participant has
them is **unverified** (check `GET /v2/packages` for `utility-registry-*`). How the
faucet at https://cbtc-faucet.bitsafe.finance works (inputs, limits) is **unverified**:
the page returned only its title.

Sketch:
- New `lib/registry.mjs` (~40 lines): `allocationFactory(admin, args)` and
  `allocationContext(admin, cid, 'execute-transfer'|'withdraw'|'cancel')`, base URL
  from `REGISTRY_URL` env.
- `scripts/token-rail.mjs`: behind `REGISTRY=live`, replace `allocateLeg` with an
  `ExerciseCommand` on the interface
  `#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory`
  choice `AllocationFactory_Allocate`, `contractId = factoryId`,
  `extraArgs.context = choiceContextData`, and pass `disclosedContracts` on the
  submit. `lib/ledger.mjs` `submit` needs an optional `disclosedContracts` field on
  `commands`.
- Feed the per-allocation contexts into the existing `Contexts` argument (the
  `NO_CONTEXTS` slot in `lib/ledger.mjs`) for `Award…`, `Default`, `Repurchase`.
- Requires `splice-api-token-allocation-instruction-v1` DAR on the client side only
  for the template id string; no Daml change.
- Evidence: write `docs/evidence/cbtc-devnet.json` with update ids.

### 2. CIP-0103 wallet: use the primary account (S)

`web/wallet.js` takes `accounts[0]`. The SDK docs pick the account with
`primary: true` or call `sdk.getPrimaryAccount()`; `prepareExecute` takes
`{ commands: Command[] }`, which matches the current call. Sources:
https://docs.canton.network/sdks-tools/sdks/dapp-sdk/guides/parties-and-transactions.md,
https://docs.canton.network/sdks-tools/sdks/dapp-sdk/reference/sdk-methods.
Sketch: `this.party = (accounts.find((a) => a.primary) ?? accounts[0]).partyId;` and
show `(await sdk.getActiveNetwork()).networkId` in the desk header so a judge sees
DevNet vs MainNet. Whether `prepareExecuteAndWait` accepts `disclosedContracts`
(needed for item 1 through the wallet) is **unverified**.

### 3. Featured-app activity marker on award and repurchase (M)

Source: https://docs.canton.network/appdev/modules/m4-featured-app-activity-marker.md,
https://docs.dev.sync.global/app_dev/api/splice-api-featured-app-v1/Splice-Api-FeaturedAppRightV1.html,
CIP-0047. Interface
`7804375f…4dda:Splice.Api.FeaturedAppRightV1:FeaturedAppRight`, choice
`FeaturedAppRight_CreateActivityMarker with beneficiaries : [AppRewardBeneficiary]`
(beneficiary + weight), controller = the right's `provider`. DevNet: self-feature via
the validator Wallet UI "Self-grant featured app rights" (needs validator-operator
login; on NODERS NaaS, **unverified** whether you have it). Note: CIP-0104
(traffic-based rewards) is replacing markers once SVs vote it in
(https://docs.canton.network/global-synchronizer/splice-fundamentals/traffic-based-app-rewards.md);
markers stay the default until then, DevNet status **unverified**.
Sketch:
- `daml.yaml`: add `dars/splice-api-featured-app-v1-1.0.0.dar` to data-dependencies
  (copy from the Splice release bundle).
- `daml/Talang.daml`: add `featured : Optional (ContractId FeaturedAppRight)` to
  `Venue`; in `Award`/`AwardWithTokenCollateral` and `Repurchase`/`SettleRepurchase`
  `forA_ venue.featured (\r -> exercise r FeaturedAppRight_CreateActivityMarker with beneficiaries = [AppRewardBeneficiary with beneficiary = operator; weight = 1.0])`.
  The operator must be a signatory/authorizer of that exercise: it already is on
  `VenueAgreement`; on desk-cash awards it is not, so either fire it only where the
  operator authorizes or have `Venue` carry it via `VenueAgreement`.
- `test/daml/DeskTest.daml`: use `Splice.Testing` featured right or a stub implementing the interface.

### 4. Minimum transfer amount and threshold on margin calls (S)

ERCC Guide to Best Practice has a section on exposure thresholds and minimum
transfer amounts agreed before trading:
https://www.icmagroup.org/assets/documents/Regulatory/Repo/ERCC-Guide-to-Best-Practice-December-17-181217.pdf.
Sketch: `Terms` gets `minTransfer : Decimal` (cash value); in `CallMargin`
(`daml/Talang.daml` ~607) add
`assertMsg "shortfall below the minimum transfer amount" (owed - lendable haircut collateralQty m.price >= terms.minTransfer)`.
Update `scripts/seed.mjs`, `scripts/governance.mjs`, `mcp/server.mjs` terms objects
(`minTransfer: '0'` keeps behaviour) and one refusal script in `test/daml/DeskTest.daml`.
`talang-repo` 1.0.0 is not on DevNet yet, so a shape change costs nothing.

### 5. Eligibility / haircut schedule by asset class (S-M)

Real desks quote against a schedule (e.g. govvies 2%, IG corporates 5%, BTC 20-50%),
not a free number. Source: ERCC guide above (margining chapter). Sketch: new
template `HaircutSchedule with lender; borrower; floors : TextMap Decimal` (instrument
→ minimum haircut), signed by lender, observer borrower. `SubmitQuote` /
`SubmitTokenQuote` take an optional schedule cid and
`assertMsg "haircut below the schedule" (haircut >= floor)`; `Swap` checks the new
instrument is in the schedule. The borrower sees why a quote is what it is; the
regulator's `BestExecution` can carry "within schedule: yes".

### 6. Cross-trade close-out netting under one master agreement (M)

GMRA close-out converts all transactions to one base currency and nets them to a
single sum: https://www.icmagroup.org/Regulatory-Policy-and-Market-Practice/repo-and-collateral-markets/frequently-asked-questions-on-repo/26-what-happens-to-repo-transactions-in-a-default/.
Talang nets per trade only. Sketch: template `MasterAgreement with borrower; lender`
(both signatories, created once); `RepoTrade` gets `master : Optional (ContractId MasterAgreement)`;
choice `CloseOut with tradeCids; markCids; contexts` on `MasterAgreement`, controller
lender, valid only if one trade is in default (`MarginCall` past `respondBy` or past
maturity): sums owed across trades, values all pledges at fresh marks, keeps
`ceil4` of total owed, returns the rest with the existing `waterfall`. One
`RepoReport` event "CLOSE_OUT".

### 7. Canton Coin as the cash leg (L, partly unverified)

CC implements CIP-0056 via Amulet; instrument admin is the DSO party, fetched from Scan
`GET /v0/dso-party-id` (https://docs.canton.network/sdks-tools/api-reference/splice-scan-cc-reference-data-api).
The registry off-ledger API for Amulet is served by Scan (validators expose a scan
proxy), but the exact path prefix is **unverified**. Sketch: same `lib/registry.mjs`
with base = Scan URL; instrument id `Amulet`. The CC implementation allows only a
10-minute window between prepare and submit (per CIP-0056 doc
https://docs.canton.network/overview/reference/cip-0056).

### 8. USDCx on DevNet (blocked)

Verified only for TestNet and MainNet: admin `decentralized-usdc-interchain-rep::122049e2…ec61`
(TestNet, utility host `api.utilities.digitalasset-staging.com`) and
`decentralized-usdc-interchain-rep::12208115…60ef` (MainNet), instrument `USDCx`
(https://docs.digitalasset.com/registry/apis/token-standard/off-ledger-api,
https://archived.docs.digitalasset.com/integrate/devnet/usdcx-support/index.html).
DevNet admin party and faucet: **unverified, not found**. Try
`GET https://api.utilities.digitalasset-dev.com/api/token-standard/v0/registrars/<candidate>/registry/metadata/v1/instruments`
or ask in HackCanton Discord. Until then keep USDCx on `MockRegistry` and say so.

## Not worth it today

- Token standard v2 (`allocation-v2`, `allocation-instruction-v2`, CIP-0112): v2
  `AllocationFactory_Allocate` takes `settlement, allocation, requestedAt,
  inputHoldingCids, extraArgs, actors` (https://docs.canton.network/sdks-tools/api-reference/splice-daml/splice-api-token-allocation-instruction-v2/splice-api-token-allocationinstructionv2.md);
  porting `Locked` and `RepurchaseNotice` is L. Whether the DA Utility registry
  serves v2 on DevNet is unverified. Mention as roadmap.
- Tri-party agent, GC baskets, open (callable) repo, floating rate: each L; a
  schedule (item 5) is the cheap stand-in for a GC basket.
