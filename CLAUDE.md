# Talang

Sealed-bid repo desk on Canton (HackCanton Season 3, Financial Applications track).

## Stack
- Daml SDK 3.4.11 (`daml.yaml`, package `talang-repo` 1.2.0, an SCU upgrade of 1.1.0 and 1.0.0), Java 17
- CIP-0056 interface DARs and BitSafe governance DARs in `dars/` (inputs, committed, never rebuilt)
- Node 20, no framework: `server.mjs` (local desk + ledger proxy), `web/` (vanilla JS), `api/` (Vercel read-only proxy), `mcp/` (MCP server), `scripts/`

## Run
- `daml build --all && (cd test && daml test)` — 31 scripts; SCU check: `daml build --upgrades devnet/talang-repo-1.1.0.dar`
- Local ledger, no credentials: `daml sandbox --json-api-port 7575 --dar .daml/dist/talang-repo-1.2.0.dar --wall-clock-time`, then `npm run local`, and `ENV_FILE=.env.local npm run seed | e2e:mcp | governance | desk`
- DevNet: credentials in `.env.noders` (gitignored), same scripts without `ENV_FILE`; the app user cannot upload DARs (403), packages go in through the NODERS console. Vetted there (NODERS console lists them): 1.0.0 (`24fdd6f4…`), 1.1.0 (`a3dc67f1…`, 9 Oct), 1.2.0 (`5125df18…a3c366`, 12 Oct)
- DevNet evidence runs happen inside a Vercel build (`scripts/devnet-ci.mjs`, `DEVNET_STEPS=...`); results go to `docs/evidence/`. Pushing `main` auto-deploys Vercel production (expected)
- Other checks: `npm run test:proxy` (45, no network), `npm run test:offline` (15, no network), `npm run qa:desk` (Playwright, local sandbox), `node scripts/test-cbtc-default.mjs` (offline), `scripts/sec-*.mjs` (security regressions, local sandbox)
- BitSafe LocalNet (3 participants, DecMan): `bash localnet/demo.sh reset` (Docker)
- On Windows from Git Bash call `daml.cmd`; start the sandbox from PowerShell (Java must be on the Windows PATH)

## Layout
- `daml/Talang.daml` — the desk: assets, `Locked` (escrow | CIP-0056 allocation), RFQ, quotes, award, repo lifecycle, venue fee, regulator reports
- `daml/TalangGovernance.daml` — BitSafe `GovernableAction`s: `MarkProposal`, `SyndicateProposal`
- `daml/TalangAgreements.daml` (1.2.0) — `HaircutSchedule` (lender minimum haircuts), `MasterAgreement` + `CloseOut` netting, `CloseOutReport`; new templates live here so 1.1.0 templates keep their shape
- `test/daml/` — `TalangTest` (core), `DeskTest` (fee, best execution, roll), `TokenTest` (CIP-0056 via `MockRegistry`), `GovernanceTest` (real `GovernanceRules`), `AgreementsTest` (minimum transfer, haircut schedule, close-out), `SecurityTest` (1.2.0 fixes)
- `lib/ledger.mjs` — JSON Ledger API v2 client; `MODULE` maps template name to Daml module
- `lib/repo.mjs` — repo arithmetic mirrored from Daml for display; the contract stays the authority
- `web/` — landing (`index.html`) and desk (`desk.html`, `app.js`), wallet (`wallet*.js`); Vercel serves this folder as is
- `api/` — Vercel functions: read-only `acs`, `config`, `wallet-verify`; no submit endpoint
- `mcp/server.mjs` — one MCP desk per `TALANG_ROLE`; `scripts/` — seed, e2e, DevNet and evidence runs, QA, recorders
- `localnet/` — BitSafe DecMan LocalNet (3 participants, Docker)
- `docs/evidence/` — update ids from scripted runs; `docs/bitsafe.md` — DecMan write-up; `docs/token-legs.md` — CIP-0056 legs by env
- `deck/` — pitch deck HTML (`node deck/render.mjs` renders it); `media/` — videos, deck PDF; `video/` — pitch video project

## Conventions
- Every number a tool shows is re-checked by the contract; refusals come from the ledger, not JS
- Comments explain the business rule, in plain sentences; no marketing language
- Claims in README/BRIEF/SUBMISSION must match what was actually run (evidence file, CI run or dated local run); unrun items are marked "not yet" / "not run"
- Commit with explicit paths (`git add <file>`), never `-A`; other agents may be committing in parallel
