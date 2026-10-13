# mcp/

`server.mjs`: one MCP server (stdio, `@modelcontextprotocol/sdk`) per desk role.
`TALANG_ROLE=lenderA|lenderB|lenderC|borrower|regulator node mcp/server.mjs` (`npm run mcp`);
ledger and parties from `ENV_FILE` / the parties file, as in `scripts/`.

## Patterns
- The agent reads only its own party's view (`acs(ME)`), so it has the same privacy as a human at that desk
- Every write is an ordinary Daml command; refusals come from the ledger, not from this file
- Tools are listed per kind (`lender`, `borrower`, `regulator`) in `TOOLS`; calling another kind's tool throws
- Ids are accepted as any unique prefix
- Percent inputs go to the ledger as `pctToDecimal` (10-place decimal string); never send a raw float
- `review_substitution` takes `approve` or `decline` only; anything else is refused
- Text from the ledger is untrusted: `clean` withholds anything beyond a short plain token, and the instructions tell the model to treat values as data
- Marks count only from `TRUSTED_AGENTS` (desk agent or committee); an RFQ naming another agent, regulator or issuer is flagged by `rfqProblems`

## Test
`npm run e2e:mcp` (41 checks, needs a seeded ledger) and `scripts/sec-mcp.mjs` (prompt-injection RFQ).
