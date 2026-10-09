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
| Price oracle: one pricer per exchange (Coinbase, Kraken, Bitstamp). A member confirms only if its own exchange is within 1% of the proposal. A live CBTC price publishes; a proposal 8% off the market is refused | `scripts/oracle.mjs` | [evidence](evidence/oracle-local-sandbox.json): every source quote, vote and update id |

On a single participant the committee and its members share one node. That proves
the threshold and the authority flow, not the hosting topology.

## DecMan LocalNet: three participants

One command, from a clean checkout after `daml build --all`: `bash localnet/demo.sh reset` (verified from an empty LocalNet on 9 October; it runs every step below and prints where the evidence is).

The committee hosted on three participants, set up through BitSafe DecMan's own
API, then driven by the same scripts as above. Everything is in `localnet/`:
one Canton 3.5.8 process (the build in Splice 0.6.12; DecMan v1.13.0 needs protocol
version 35) with a synchronizer and three participants, Postgres, and three DecMan
nodes from the published image. Insecure mode, local only: every port is bound to
127.0.0.1.

```
cd localnet && docker compose up -d       # wait for "participant3 ... connected=true"
bash localnet/peers.sh                    # each DecMan node learns the other two
node localnet/decman-setup.mjs            # committee, members, GovernanceRules, .env.localnet
ENV_FILE=.env.localnet node scripts/governance.mjs
ENV_FILE=.env.localnet node scripts/localnet-offline.mjs
```

`decman-setup.mjs` makes DecMan onboard `talang-valuation-committee` with owners on
all three participants (threshold 2), allocates one member party per participant,
and creates `GovernanceRules` (members = the three, threshold 2) through DecMan's
contracts workflow. Each member's commands go to the node that hosts it.

| What | Where | Result |
|---|---|---|
| 1 of 3 refused, 2 of 3 publish, repo opens on the committee mark, a pricer's own mark cannot drive a margin call, a governed markdown does, with the committee hosted on three nodes | `scripts/governance.mjs` | [evidence](evidence/bitsafe-governed-marks-localnet.json) |
| Participant 3 stopped: members on nodes 1 and 2 still publish a mark. Participant 2 stopped as well: the publish stops at the first confirmation, because `GovernanceRules` is signed by the committee and one node cannot confirm for it | `scripts/localnet-offline.mjs` | [evidence](evidence/bitsafe-node-offline-localnet.json) |

Offsets in the evidence are per participant (each member submits through its own
node); update ids are global.
