# Token legs: any CIP-0056 instrument as cash, collateral, or both

`scripts/token-repo.mjs` runs one repo (RFQ, sealed quote, award, repurchase) where
each leg is either a CIP-0056 instrument or the desk's own escrowed `Holding`. Which
one is chosen by env only; no Daml change. The Daml side is `Locked = Escrowed | Allocated`
in `daml/Talang.daml`: `SubmitTokenQuote` takes the lender's cash allocation,
`AwardWithTokenCollateral` takes the borrower's collateral allocation.

## Env

| Var | Meaning |
|---|---|
| `CASH_ADMIN`, `CASH_ID` | Cash instrument (admin party, instrument id). Unset: desk USDC. |
| `COLLATERAL_ADMIN`, `COLLATERAL_ID` | Collateral instrument. Unset: desk UST. |
| `CASH_REGISTRY_URL`, `COLLATERAL_REGISTRY_URL` | Registry base, the part before `/registry/...`. Default: DA Utility DevNet, `https://api.utilities.digitalasset-dev.com/api/token-standard/v0/registrars/<admin>` |
| `PRINCIPAL` (50), `COLLATERAL_QTY` (1), `MARK` (100) | Size. The contract refuses unless `QTY × MARK × 0.9 ≥ PRINCIPAL`. |
| `CC_TAP` | DevNet only: mint this much Canton Coin to a party holding less than half of it. |
| `PRESET` | Comma-separated named settings below; explicit env wins. |
| `DRY_RUN=1` | No ledger: checks each registry's admin, instrument and allocation factory. |

## What each choice needs from the registry

| Step | Talang choice | Registry call | Context |
|---|---|---|---|
| Accept a faucet's transfer offer | `TransferInstruction_Accept` | `transfer-instruction/v1/{id}/choice-contexts/accept` | per offer |
| Lender funds the quote | `AllocationFactory_Allocate`, then `SubmitTokenQuote` | `allocation-instruction/v1/allocation-factory` | none on the quote |
| Borrower pledges | `AllocationFactory_Allocate`, then `AwardWithTokenCollateral` | same | cash allocation: `execute-transfer` (Open delivers it); collateral is only fetched |
| Repurchase, token cash | `NoticeRepurchase` → borrower allocates `due` → `SettleRepurchase` | factory, then `allocations/v1/{id}/choice-contexts/execute-transfer` for the payment, `cancel` for the collateral | both in one `contexts` list, disclosed contracts merged |
| Repurchase, desk cash | `Repurchase` | `cancel` for the collateral allocation | |

Every allocation has the borrower as settlement executor, the leg sender/receiver as
the parties, and `settleBefore` past what Talang checks (RFQ deadline for cash,
maturity + 3-day claim window for collateral).

## Presets and verified values

All checked live on 9 October 2026 with `DRY_RUN=1` (metadata info, instrument, factory).

| Preset | Instrument | Admin | Registry base | Status |
|---|---|---|---|---|
| `cbtc-collateral` | CBTC (DevNet) | `cbtc-network::12202a83c6f4082217c175e29bc53da5f2703ba2675778ab99217a5a881a949203ff` | DA Utility DevNet | Registry live; collateral allocate + cancel already run on DevNet by `scripts/cbtc-rail.mjs` ([evidence](evidence/cbtc-rail-devnet.json)). CBTC from the BitSafe faucet. |
| `cc-cash`, `cc-collateral` | Canton Coin, id `Amulet` (DevNet) | `DSO::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a` | `https://scan.sv-1.dev.global.canton.network.sync.global` (Scan serves `/registry/...` publicly; `/api/scan/...` is IP-allowlisted) | Registry and factory answer. CC comes from `CC_TAP` (`AmuletRules_DevNet_Tap`, with AmuletRules and OpenMiningRound taken from the registry's disclosed contracts), or the validator wallet's tap. Run on DevNet with `cbtc-collateral` on 9 October: tap, quote funded by an Amulet allocation, repurchase allocation executed, 12 of 12 steps ([evidence](evidence/token-repo-amulet-cbtc-devnet.json)). |
| `usdcx-testnet-cash` | USDCx (TestNet) | `decentralized-usdc-interchain-rep::122049e2af8a725bd19759320fc83c638e7718973eac189d8f201309c512d1ffec61` | `https://api.utilities.digitalasset-staging.com/api/token-standard/v0/registrars/<admin>` | Registry answers. Needs a TestNet participant and USDCx minted via the xReserve Sepolia bridge (https://digital-asset.github.io/xreserve-deposits/). Not run. |
| (env only) | USDCx (MainNet) | `decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef` | `https://api.utilities.digitalasset.com/api/token-standard/v0/registrars/<admin>` | Registry answers. Not run. |
| (env only) | Canton Coin (TestNet) | `DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337` | `https://scan.sv-1.test.global.canton.network.sync.global` | Registry info answers. No tap on TestNet. Not run. |

USDCx on DevNet: no admin party is published. The DA docs list TestNet and MainNet
only (https://docs.digitalasset.com/registry/apis/token-standard/off-ledger-api,
https://archived.docs.digitalasset.com/integrate/devnet/usdcx-support/index.html), the
xReserve deposit app bridges Ethereum Mainnet → CN MainNet and Sepolia → CN TestNet
only, and the DevNet Utility host answers `Registrar ... not found` for the TestNet admin.
A DevNet forum post says Utility assets "including USDCx" have pre-approvals on DevNet
(https://forum.canton.network/t/pre-approvals-for-direct-transfers-now-enabled-for-the-da-registry-utility-on-devnet/8388)
but names no admin. Once someone has one: `CASH_ADMIN=<admin> CASH_ID=USDCx`.

## Run

```
PRESET=cc-cash DRY_RUN=1 node scripts/token-repo.mjs                  # registry checks, no ledger
PRESET=cc-cash node scripts/token-repo.mjs                             # CC cash, desk UST collateral
PRESET=cc-cash,cbtc-collateral node scripts/token-repo.mjs             # both legs real tokens
CASH_ADMIN=... CASH_ID=USDCx CASH_REGISTRY_URL=... node scripts/token-repo.mjs
```

On DevNet through the Vercel build: `--build-env TALANG_DEVNET_CI=1 --build-env DEVNET_STEPS=rights,token-repo --build-env PRESET=cc-cash,cbtc-collateral`.
Evidence: `docs/evidence/token-repo-<cash>-<collateral>-<devnet|local-sandbox>.json`.

Run on DevNet (`PRESET=cc-cash,cbtc-collateral`, [evidence](evidence/token-repo-amulet-cbtc-devnet.json)): the tap works on the
NODERS participant, Amulet allocations execute through the Scan registry, and the CBTC
allocation is cancelled through the DA Utility registry. Still unverified: whether a DA
Utility allocation executes (`execute-transfer`) as cleanly as it cancels (CBTC as cash,
or a CBTC default); only cancel has been run on that registry.
