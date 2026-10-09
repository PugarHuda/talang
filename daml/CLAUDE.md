# daml/

## Patterns
- Value one party commits to another is `Locked`: `Escrowed` (desk `Escrow`) or `Allocated` (CIP-0056 `Allocation`). Resolve with `deliver` (to counterparty) or `unwind` (back to owner); never exercise `Release` / `Allocation_*` directly in new code.
- The borrower is the settlement executor of every allocation, so executor, sender and receiver are all signatories of the quote or repo that settles it. `checkAllocation` enforces sender, receiver, executor, instrument, amount and `settleBefore`.
- Choices that may touch an allocation take `contexts : Contexts` (registry off-ledger context per allocation); desk-only callers pass `[]`.
- Pledges are validated once, in `pledgeQty`, wherever collateral enters (open, margin, substitution).
- Every lifecycle event calls `report` so the regulator observes it; nothing upstream of a trade is ever observed by the regulator.
- A mark is trusted only via `freshMark agent ...`; the agent can be a BitSafe decentralized party (`MarkProposal`).

## Gotchas found here
- Daml is strict: `zip xs [1 ..]` exhausts the heap; use `[1 .. n]`.
- `agreement` is a keyword; do not use it as a variable name.
- A field name exported by `Talang` shadows test helpers of the same name (`cash`, `principal`).
- Template shape changes are not SCU-compatible with `talang-desk` 0.1.0 on DevNet; that is why the package is `talang-repo`.
