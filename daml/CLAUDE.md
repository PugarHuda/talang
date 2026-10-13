# daml/

## Patterns
- Value one party commits to another is `Locked`: `Escrowed` (desk `Escrow`) or `Allocated` (CIP-0056 `Allocation`). Resolve with `deliver` (to counterparty) or `unwind` (back to owner); never exercise `Release` / `Allocation_*` directly in new code.
- The borrower is the settlement executor of every allocation, so executor, sender and receiver are all signatories of the quote or repo that settles it. `checkAllocation` enforces sender, receiver, executor, instrument, amount and `settleBefore`.
- Choices that may touch an allocation take `contexts : Contexts` (registry off-ledger context per allocation); desk-only callers pass `[]`.
- Pledges are validated once, in `pledgeQty`, wherever collateral enters (open, margin, substitution). 1.2.1: a desk escrow enters a repo only with purpose `offeredPledge` and is re-locked by `enterRepo` (no escrow backs two repos); `TopUp`/`Swap` refuse a pledge already in the repo; `Roll` re-checks allocation expiry; `CloseOut` honours `defaultWindow`.
- 1.2.2: a CIP-0056 collateral allocation must name its settlement in `settlementRef.cid` (`boundTo`): the RFQ for the opening pledge (`Open`), the `MarginCall` for `PostTokenMargin`, the `RepoTrade` for `ProposeTokenSubstitution`. Each of those is consumed by the step that takes the pledge, so one allocation backs one repo. Wallet tooling must set `cid` (the scripts do; `cid: null` is refused). Cash allocations (quotes, repurchase, fee) are not bound.
- 1.2.2: `Open` archives its RFQ (the awards no longer do), so one RFQ opens one repo; a borrower calling `Open` directly closes the request and gets no `BestExecution` row.
- Not fixable on-ledger without leaking: `BestExecution` and `LossNotice` are borrower-signed and can be created standalone. Their content (quotes weighed, rank, band) is the borrower's own statement anyway, since only the borrower sees every quote; a co-signature by the winning lender would show it the field size and its rank. The regulator should read a `BestExecution` together with the co-signed OPEN `RepoReport` of the same transaction; an OPEN with none means the auction was skipped.
- `ClaimAfterMaturity` (1.2.2) takes `markCid : Optional (ContractId Mark)`; `None` is refused. It nets like `Default` / `CloseOut` (`waterfall`), excess home; without a fresh mark from the repo's agent the lender cannot claim (a stalled agent can let a token pledge lapse at the claim window's end).
- Every lifecycle event calls `report` so the regulator observes it; nothing upstream of a trade is ever observed by the regulator.
- A mark is trusted only via `freshMark agent ...`; the agent can be a BitSafe decentralized party (`MarkProposal`).
- Upgrades are SCU (1.0.0 -> 1.1.0 -> 1.2.0 -> 1.2.1 -> 1.2.2, all vetted on the NODERS DevNet participant): never change an existing template's shape or remove a choice; add trailing optional fields (templates, choice arguments: 1.2.2 `ClaimAfterMaturity.markCid`, `VenueAgreement.feeInstrument`), new variant constructors at the end (`ClaimAtMarkMove`), new choices, or new templates in `TalangAgreements.daml`. Check with `daml build --upgrades devnet/talang-repo-1.1.0.dar`, `-1.2.0.dar` and `-1.2.1.dar`; an `ensure` change is a warning only (1.2.2 `Mark`).
- 1.2.0 awards go through the nonconsuming `AwardSealed` / `AwardSealedWithTokenCollateral` (losing lenders are not informees); the consuming `Award` is kept for the upgrade and refuses.
- Time limits are named constants: `markMaxAge` (24 h), `marginMarkMaxAge` (1 h, 1.2.0), `marginResponseMin` (2 h), `defaultWindow` (1 day after respondBy, 1.2.0).

## Gotchas found here
- `AnyContractId` exists in both `Daml.Script` and `Splice.Api.Token.MetadataV1`; qualify it in tests.
- `payOut` refuses (1.2.2) when a holding is used up before every leg is paid; callers still check the total first.
- Daml is strict: `zip xs [1 ..]` exhausts the heap; use `[1 .. n]`.
- `agreement` is a keyword; do not use it as a variable name.
- A field name exported by `Talang` shadows test helpers of the same name (`cash`, `principal`).
- Template shape changes are not SCU-compatible with `talang-desk` 0.1.0 on DevNet; that is why the package is `talang-repo`.
