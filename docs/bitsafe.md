# Talang on BitSafe's Decentralization Manager

## The risk it removes

A repo has two parties that should not be one key on one node.

- **The price source.** Every margin call, substitution and roll is computed from a
  `Mark`. If one operator signs marks, one compromised key can mark collateral
  down and let a lender seize it, or mark it up and hide a shortfall.
- **The lender.** A lender is often a desk inside a bank, or a pool of liquidity
  providers. Quoting, calling margin and declaring a default are decisions that
  should take more than one person.

## What Talang does

Both can be BitSafe decentralized parties. Each action is a `GovernableAction`
(BitSafe `governance-action-v1`): one member proposes it, other members confirm
through BitSafe's `GovernanceRules` (`governance-core-v1`), and `GovernanceRules`
executes it with the decentralized party's authority. Below the threshold the
ledger refuses and nothing moves.

| Template | Decentralized party | Actions |
|---|---|---|
| `MarkProposal` | valuation committee | publish a `Mark` signed by the committee |
| `SyndicateProposal` | lender syndicate | quote (desk cash or a CIP-0056 allocation), call margin, approve or decline a substitution, declare default, claim after maturity, offer a roll |

No repo code changes for either. `RepoRFQ.agent` is set to the committee, and
`freshMark` already requires `mark.agent == agent`, so every choice that reads a
mark accepts only committee marks. A syndicate is just a lender party.

The DARs in `dars/` are BitSafe's releases, unmodified:
`governance-action-v1-0.1.0.dar` and `governance-core-v1-0.1.0.dar` from
[DLC-link/decentralization-manager](https://github.com/DLC-link/decentralization-manager/tree/main/releases/v1).

## Evidence

| What | Where | Result |
|---|---|---|
| 1 of 3 confirmations refused; 2 of 3 publish; repo opens on the committee mark; one pricer's own mark cannot drive a margin call; a governed markdown can | `test/daml/GovernanceTest.daml` `valuationCommittee` | passes |
| Syndicate quote refused with 1 of 3, executed with 2 of 3; rival lender sees nothing; margin call refused with 1, issued with 2 | `test/daml/GovernanceTest.daml` `lenderSyndicate` | passes |
| The committee flow above on a running Canton 3.4.11 participant through the JSON Ledger API, BitSafe's DAR uploaded as released | `scripts/governance.mjs` | [evidence](evidence/bitsafe-governed-marks-local-sandbox.json): refusal reason is BitSafe's own *"The requirement 'Enough confirmations to execute action' was not met"* |

On a single participant the committee and its members share one node. That proves
the threshold and the authority flow, not the hosting topology.

## DecMan LocalNet: three participants (not yet run)

This is the run the BitSafe Contribution Pool asks for. It needs Docker, which the
machine this was built on does not have yet.

1. Bring up the Splice LocalNet and DecMan's three participant instances as in the
   DecMan README (`docker compose up` in the DecMan repo starts DecMan on 8081,
   8082 and 8083 against Canton participants on `5001/5002`, `5011/5012`,
   `5021/5022`).
2. Upload `talang-repo-1.0.0.dar`, `governance-action-v1-0.1.0.dar` and
   `governance-core-v1-0.1.0.dar` to all three participants.
3. In DecMan, create the valuation committee: one owner party per participant,
   hosting threshold 2, governance threshold 2. Note the committee party, the three
   owner parties and the `GovernanceRules` contract id.
4. Point `.env.localnet` at participant 1's JSON Ledger API and run:

   ```
   ENV_FILE=.env.localnet COMMITTEE_PARTY=... COMMITTEE_MEMBERS=a,b,c COMMITTEE_RULES=... \
     node scripts/governance.mjs
   ```

5. Stop one participant and run it again: with two of three nodes up the committee
   still publishes; with one, confirmations cannot reach the threshold.

Each run writes its update ids and offsets to `docs/evidence/`.
