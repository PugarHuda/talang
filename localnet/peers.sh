#!/usr/bin/env bash
# Tells each DecMan node about the other two (participant id, Noise address and
# public key), then restarts them: DecMan builds its peer key map at startup.
set -euo pipefail
cd "$(dirname "$0")"
peer() { # n http noise
  local key pid
  key=$(curl -s "localhost:$2/keys/status" | node -pe 'JSON.parse(require("fs").readFileSync(0)).public_key')
  pid=$(curl -s "localhost:$2/node-config" | node -pe 'JSON.parse(require("fs").readFileSync(0)).node.participant_id')
  echo "{\"participant_id\":\"$pid\",\"name\":\"Participant $1\",\"address\":\"participant-$1\",\"port\":$3,\"public_key\":\"$key\",\"party\":null}"
}
PEERS="[$(peer 1 8081 9001),$(peer 2 8082 9002),$(peer 3 8083 9003)]"
for p in 8081 8082 8083; do
  curl -sf -X POST "localhost:$p/network-config" -H 'content-type: application/json' -d "$PEERS" > /dev/null
done
docker compose restart participant-1 participant-2 participant-3
for p in 8081 8082 8083; do until curl -sf "localhost:$p/keys/status" > /dev/null; do sleep 1; done; done
sleep 5
curl -s localhost:8081/participants-status; echo
