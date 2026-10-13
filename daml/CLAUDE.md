# daml/

## Patterns
- Value one party commits to another is `Locked`: `Escrowed` (desk `Escrow`) or `Allocated` (CIP-0056 `Allocation`). Resolve with `deliver` (to counterparty) or `unwind` (back to owner); never exercise `Release` / `Allocation_*` directly in new code.
- The borrower is the settlement executor of every allocation, so executor, sender and receiver are all signatories of the quote or repo that settles it. `checkAllocation` enforces sender, receiver, executor, instrument, amount and `settleBefore`.
- Choices that may touch an allocation take `contexts : Contexts` (registry off-ledger context per allocation); desk-only callers pass `[]`.
- Pledges are validated once, in `pledgeQty`, wherever collateral enters (open, margin, substitution). 1.2.1: a desk escrow enters a repo only with purpose `offeredPledge` and is re-locked by `enterRepo` (no escrow backs two repos); `TopUp`/`Swap` refuse a pledge already in the repo; `Roll` re-checks allocation expiry; `CloseOut` honours `defaultWindow`.
- Known open gap: one CIP-0056 allocation can still back two repos with the same lender (needs a `settlementRef` binding, i.e. tooling change).
- Every lifecycle event calls `report` so the regulator observes it; nothing upstream of a trade is ever observed by the regulator.
- A mark is trusted only via `freshMark agent ...`; the agent can be a BitSafe decentralized party (`MarkProposal`).
- Upgrades are SCU (1.0.0 -> 1.1.0 -> 1.2.0 vetted on the NODERS DevNet participant; 1.2.1 built, not yet uploaded): never change an existing template's shape or remove a choice; add optional fields, new choices, or new templates in `TalangAgreements.daml`. Check with `daml build --upgrades devnet/talang-repo-1.1.0.dar` and `-1.2.0.dar`.
- 1.2.0 awards go through the nonconsuming `AwardSealed` / `AwardSealedWithTokenCollateral` (losing lenders are not informees); the consuming `Award` is kept for the upgrade and refuses.
- Time limits are named constants: `markMaxAge` (24 h), `marginMarkMaxAge` (1 h, 1.2.0), `marginResponseMin` (2 h), `defaultWindow` (1 day after respondBy, 1.2.0).

## Gotchas found here
- Daml is strict: `zip xs [1 ..]` exhausts the heap; use `[1 .. n]`.
- `agreement` is a keyword; do not use it as a variable name.
- A field name exported by `Talang` shadows test helpers of the same name (`cash`, `principal`).
- Template shape changes are not SCU-compatible with `talang-desk` 0.1.0 on DevNet; that is why the package is `talang-repo`.
