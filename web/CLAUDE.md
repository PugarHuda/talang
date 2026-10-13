# web/

Static, no build step, vanilla JS modules. Vercel serves this folder as the site
(`vercel.json` `outputDirectory`, `/desk` rewrites to `desk.html`); locally `server.mjs`
serves it and proxies the ledger (`npm run desk`, port 8090). This file is kept out of the
deployment by `.vercelignore`.

## Files
- `index.html`, `landing.css`, `landing.js` — landing page (hero scene with SVG fallback); its numbers must match README
- `desk.html`, `app.js`, `style.css` — the desk; `?role=` picks the role, `?view=` the side-by-side privacy view
- `wallet.js` (CIP-0103 via `@canton-network/dapp-sdk`), `wallet-pay.js` (venue fee by standard token transfer), `wallet-receipts.js` (signed-command receipts)
- `og-card.png` — share card from `scripts/make-social.mjs`

## Patterns
- Every number is read from the acting role's own `/api/acs`; every action is a Daml command the contract re-checks
- Config (parties, read-only flag, wallet recipients) comes from `/api/config`
- Where the node does not vet talang-repo 1.2.0, the read (`deskAcs` in `lib/ledger.mjs`) falls back to the 1.1.0 templates
- Marks are taken only from the desk agent or committee (`trusted` in `app.js`)
- Percentages are sent as 10-place decimal strings (`toFixed(10)`)
- Hosted copy is read-only (`readOnly: true` from `/api/config`, `canAct` in `app.js`); `api/` has no submit endpoint

## Test
`npm run qa:desk` (Playwright, local sandbox), `scripts/qa-hosted.mjs` (public deployment).
