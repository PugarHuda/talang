#!/usr/bin/env bash
# The whole BitSafe DecMan demo in one command, from a clean checkout:
#   bash localnet/demo.sh            start (or reuse) the LocalNet and run the demo
#   bash localnet/demo.sh reset      wipe the LocalNet first (volumes, DecMan keys, node state)
#   bash localnet/demo.sh down       stop it
# Needs Docker (about 6 GB free for it), Node 20 and `daml build --all` done once
# (bootstrap.canton uploads .daml/dist/talang-repo-1.1.0.dar to every participant).
#
# What it shows: a valuation committee that is one decentralized party hosted on
# three participants. A proposed mark is refused with one confirmation and executed
# with two; the repo desk opens a trade and issues a margin call on the committee's
# mark only; with one node stopped the committee still publishes, with two it cannot.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)

case "${1:-}" in
  down) docker compose down; exit 0 ;;
  reset) docker compose down -v; rm -rf decman ctl committee.json "$ROOT/.env.localnet" "$ROOT/parties.localnet.json" ;;
esac

[ -f "$ROOT/.daml/dist/talang-repo-1.1.0.dar" ] || { echo "run 'daml build --all' first"; exit 1; }

echo "== 1. Canton (synchronizer + 3 participants), Postgres, 3 DecMan nodes"
docker compose up -d
# The bootstrap script prints one line per participant once it is on the synchronizer.
until [ "$(docker compose logs canton 2>&1 | grep -c 'connected=true')" -ge 3 ]; do sleep 5; done
for p in 8081 8082 8083; do until curl -sf "localhost:$p/keys/status" > /dev/null; do sleep 2; done; done

echo "== 2. DecMan nodes learn each other"
if [ "$(curl -s localhost:8081/participants-status | grep -o '"Connected"' | wc -l)" -lt 2 ]; then bash peers.sh; fi

echo "== 3. Committee onboarded through DecMan: owners on all 3 participants, threshold 2"
(cd "$ROOT" && node localnet/decman-setup.mjs)

echo "== 4. Proposed marks, 1-of-3 refused, 2-of-3 executed, repo and margin call on the committee mark"
(cd "$ROOT" && ENV_FILE=.env.localnet node scripts/governance.mjs)

echo "== 5. One node down: still publishes. Two down: cannot"
(cd "$ROOT" && ENV_FILE=.env.localnet node scripts/localnet-offline.mjs)

cat <<EOF

Done. Evidence: docs/evidence/bitsafe-governed-marks-localnet.json, docs/evidence/bitsafe-node-offline-localnet.json
DecMan UIs: http://localhost:8081  http://localhost:8082  http://localhost:8083
  (the committee party, its GovernanceRules and the executed actions in the audit trail)
Stop with: bash localnet/demo.sh down
EOF
