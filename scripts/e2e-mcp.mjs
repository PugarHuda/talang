// End-to-end: drive the MCP server as an MCP client would, against live DevNet.
//   node scripts/e2e-mcp.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PARTIES as p, submit, create } from '../lib/ledger.mjs';

let failed = 0;
const check = (ok, label) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failed++; };

async function agent(role) {
  const c = new Client({ name: 'e2e', version: '0' });
  await c.connect(new StdioClientTransport({ command: 'node', args: ['mcp/server.mjs'], env: { ...process.env, TALANG_ROLE: role } }));
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { error: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  return { c, call };
}

const A = await agent('lenderA'), B = await agent('lenderB');

const tools = (await A.c.listTools()).tools.map((t) => t.name);
check(['portfolio', 'open_requests', 'quote', 'call_margin', 'review_substitution', 'privacy_check'].every((t) => tools.includes(t)), `6 tools listed (${tools.join(', ')})`);

for (const [label, ag] of [['A', A], ['B', B]]) {
  const priv = (await ag.call('privacy_check')).data;
  check(priv.rivalQuotesVisible === 0, `lender ${label} sees ${priv.quotesVisible} quotes, 0 from rivals`);
  check(priv.reposNotMine === 0, `lender ${label} sees no repo it did not fund`);
}

const reqs = (await A.call('open_requests')).data;
check(Array.isArray(reqs), `open_requests returns ${reqs.length} request(s)`);

const book = (await B.call('portfolio')).data;
check(book.length > 0 && book.every((t) => typeof t.coverage === 'number'), `portfolio for B: ${book.length} repo(s) with coverage`);

// The ledger, not the tool, refuses a call the mark does not justify.
const covered = book.find((t) => t.coverage >= 1 && t.markFresh);
if (covered) {
  const r = await B.call('call_margin', { repo: covered.repo });
  check(r.error && /still covers/.test(r.error), `call on a covered repo refused by the ledger (${covered.collateral}, ${(covered.coverage * 100).toFixed(1)}%)`);

  // Mark the collateral down 6%, and the same call goes through.
  const [qty, instrument] = covered.collateral.split(' ');
  await submit(p.agent, create('Mark', { agent: p.agent, instrument, price: String(Math.round(covered.mark * 0.94)),
    asOf: new Date().toISOString(), audience: [p.borrower, p.lenderA, p.lenderB, p.lenderC] }));
  const after = (await B.call('portfolio')).data.find((t) => t.repo === covered.repo);
  check(after.coverage < 1, `after a 6% markdown coverage is ${(after.coverage * 100).toFixed(1)}%, short ${after.unitsShort} ${instrument}`);
  const ok = await B.call('call_margin', { repo: covered.repo, hoursToRespond: 48 });
  check(ok.data?.called === true, `margin call issued by the agent (${ok.error ?? ok.data.marginCall})`);
  const again = (await B.call('portfolio')).data.find((t) => t.repo === covered.repo);
  check(again.marginCall?.unitsDue > 0, `portfolio now shows the call: ${again.marginCall?.unitsDue} ${instrument} due by ${again.marginCall?.respondBy}`);
} else {
  console.log('· no covered repo with a fresh mark for B: run `npm run marks` and retry for the write checks');
}

await A.c.close(); await B.c.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
