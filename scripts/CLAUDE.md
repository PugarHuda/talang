# scripts/

Node 20 ES modules, no framework, one file per job. Env comes from `ENV_FILE` (default
`.env.noders` = DevNet; `.env.local` = local sandbox from `npm run local`; `.env.localnet` =
DecMan LocalNet). Parties come from `parties.json` / `parties.local.json` / `parties.localnet.json`.

## By job
- Setup: `local.mjs` (sandbox parties, writes `.env.local`), `upload.mjs` (DARs; 403 on NODERS, use the console), `devnet-rights.mjs` (who may act as whom), `seed.mjs` (one repo in every state; `marks` re-publishes marks), `devnet-tidy.mjs`
- End to end: `e2e-mcp.mjs` (every MCP desk, 41 checks), `governance.mjs` (BitSafe 2-of-3 marks), `oracle.mjs` (one pricer per exchange), `token-rail.mjs` (CIP-0056 legs vs `MockRegistry`), `localnet-offline.mjs` (committee with nodes stopped)
- Real tokens on DevNet: `cbtc-rail.mjs`, `token-repo.mjs` (legs by env, see `docs/token-legs.md`), `cbtc-default.mjs` (`PHASE=open`, then `PHASE=default` after respondBy)
- DevNet runner: `devnet-ci.mjs` runs inside a Vercel build (credentials live there); `DEVNET_STEPS=rights,seed,...` picks steps; output is published under `/evidence/` and copied into `docs/evidence/`
- Checks without a ledger: `test-readonly-proxy.mjs` (`npm run test:proxy`, 45), `test-cbtc-default.mjs` (fake ledger and registry), `sec-wallet.mjs`
- Browser: `qa-desk.mjs` (Playwright through every role; needs `server.mjs` on 8092 and a read-only one on 8093), `qa-hosted.mjs` (the public deployment, read-only), `grofty-e2e.mjs` (real Grofty extension on TestNet)
- Security regressions on a local sandbox: `sec-daml.mjs`, `sec-mcp.mjs`, `sec-server.mjs`
- Media: `record-desk.mjs`, `record-decman.mjs`, `make-logo.mjs`, `make-social.mjs`

## Conventions
- Evidence files record update ids, offsets and refusals as returned by the ledger, never a credential; write them to `docs/evidence/<what>-<where>.json`
- An expected refusal is a passing step only when the ledger refuses (the reason is kept in the evidence)
- Read ids from the ledger at run time, not from an earlier evidence file
- Do not start Canton sandboxes casually on this machine (RAM); CI runs the sandbox suites on every push
