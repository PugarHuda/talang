// Record the valuation committee in BitSafe's own Decentralization Manager UI on
// DecMan LocalNet: three DecMan nodes, the committee hosted on three participants
// (2 of 3), a mark proposed, confirmed on node 1 (not enough), confirmed on node 2
// in its own UI, executed on node 1, the on-chain audit trail on node 3, then the
// lender's margin call on the committee's mark. Same recorder as record-desk.mjs.
//
//   cd localnet && docker compose up -d && bash localnet/peers.sh && node localnet/decman-setup.mjs
//   node scripts/record-decman.mjs
// Writes media/decman-demo.mp4, media/decman-demo.marks.json, media/decman-demo.srt
// and media/decman-demo-captioned.mp4 (bottom caption bar).
//
// Driven from the UI: Confirm (node 1), Confirm (node 2), Execute (node 1), the
// audit trail. Not from the UI: the proposal itself (DecMan's New Proposal form only
// offers its built-in action types, so the node 1 member creates the MarkProposal
// through its participant's JSON Ledger API, as Talang's oracle does) and the
// margin call (a Talang choice; shown as ledger output with its update id).
//
// One patch in the browser: DecMan's Approvals list keeps only parties whose auth
// status is "authenticated". LocalNet runs DecMan in insecure mode, where the status
// is "mock" (the UI shows its test-mode flask), so the list would stay empty. The
// recorder lets "mock" through that one filter; every request the UI sends to
// DecMan, and every ledger command DecMan submits, is unchanged.
process.env.ENV_FILE ??= '.env.localnet';
const { chromium } = await import('playwright');
const { readdir, rm, mkdir, writeFile, rename } = await import('node:fs/promises');
const { execFileSync } = await import('node:child_process');
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { PARTIES: P, acs, submit, create, exercise, created } = await import('../lib/ledger.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = join(ROOT, 'media');
const RAW = join(MEDIA, '.capture-decman');
const OUT = join(MEDIA, 'decman-demo.mp4');
const NODE = (n) => `http://localhost:808${n}`;
const COMMITTEE = process.env.COMMITTEE_PARTY;
const [P1] = process.env.COMMITTEE_MEMBERS.split(',');
const PRICE = 92000;
// This run's proposal, told apart from any other pending one by its source.
const SOURCE = `the node 1 pricer, ${new Date().toISOString().slice(11, 16)} UTC`;
const DESC = `UST10Y @ ${PRICE}.0 from ${SOURCE}`;

// Preconditions: an open repo for the margin call (other pending proposals only add
// cards). DecMan's governance caches are warmed first: slow after a node restart.
const q = `party_id=${encodeURIComponent(COMMITTEE)}`;
await Promise.all([1, 2, 3].flatMap((n) => [`/governance/state?${q}`, `/governance/chain-audit?${q}&limit=25&scope=governance&refresh=true`]
  .map((path) => fetch(NODE(n) + path).then((r) => r.text()))));
const pending = await (await fetch(`${NODE(1)}/governance/confirmations?party_id=${encodeURIComponent(COMMITTEE)}`)).json();
if (pending.domain_actions?.length) console.warn(`note: ${pending.domain_actions.length} other committee proposal(s) pending; they will show in Approvals`);
const trade = (await acs(P.lenderA)).contracts.find((c) => c.tpl === 'RepoTrade');
if (!trade) throw new Error('no open RepoTrade for lenderA: run ENV_FILE=.env.localnet node scripts/governance.mjs first');

await rm(RAW, { recursive: true, force: true });
await mkdir(RAW, { recursive: true });
const marks = [];
let t0 = Date.now();
const mark = (label) => { marks.push({ at: Number(((Date.now() - t0) / 1000).toFixed(2)), label }); console.log('·', label); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir: RAW, size: { width: 1600, height: 900 } } });
await ctx.route(/\/assets\/index-[^/]*\.js$/, async (route) => {
  const res = await route.fetch();
  const from = 't.status.status!==`authenticated`||!t.rights?.dec_party_act_as';
  const body = await res.text();
  if (!body.includes(from)) throw new Error('DecMan bundle changed: Approvals filter not found');
  await route.fulfill({ response: res, body: body.replace(from, '!/^(authenticated|mock)$/.test(t.status.status)||!t.rights?.dec_party_act_as') });
});
const vStart = Date.now(); // the capture starts with the page; the pre-roll before t0 is cut below
const p = await ctx.newPage();
await p.addInitScript(() => {
  const put = () => {
    if (document.getElementById('rec-cursor')) return;
    const c = document.createElement('div');
    c.id = 'rec-cursor';
    c.style.cssText = 'position:fixed;z-index:99999;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;'
      + 'background:rgba(255,94,26,.25);border:2px solid #ff5e1a;pointer-events:none;transition:transform .18s ease-out;left:0;top:0';
    document.body.appendChild(c);
  };
  document.addEventListener('DOMContentLoaded', put);
});

const beat = (ms = 1200) => p.waitForTimeout(ms);
const loc = (sel) => (typeof sel === 'string' ? p.locator(sel) : sel).first();
const point = async (sel) => {
  const el = loc(sel);
  await el.waitFor({ timeout: 30000 });
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  if (!b) return el;
  const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
  await p.evaluate(([x, y]) => { const c = document.getElementById('rec-cursor'); if (c) c.style.transform = `translate(${x}px,${y}px)`; }, [x, y]);
  await p.mouse.move(x, y, { steps: 18 });
  await beat(420);
  return el;
};
const click = async (sel) => { await (await point(sel)).click(); await beat(900); };
const nav = (text) => click(p.getByText(text, { exact: true }));
// A proposal card: the smallest element holding its label and its Review button. The
// description is only in the DOM once Review is open, so open cards until it is ours.
const cards = () => p.locator('div', { has: p.getByText('talang:PublishMark', { exact: true }) })
  .filter({ has: p.getByRole('button', { name: 'Review' }) });
const card = () => cards().filter({ hasText: DESC }).last();
const review = async () => {
  await cards().first().waitFor({ timeout: 30000 });
  if (await p.getByText(DESC).isVisible()) return;
  const all = await cards().all();
  for (const c of all.reverse()) { // innermost first
    await click(c.getByRole('button', { name: 'Review' }));
    if (await p.getByText(DESC).isVisible()) return;
  }
  throw new Error("this run's proposal is not in Approvals");
};
const open = async (n) => { await p.goto(NODE(n), { waitUntil: 'load' }); await p.getByText('Approvals', { exact: true }).first().waitFor(); await beat(500); };

// 1. Three nodes.
await open(1);
await nav('Configuration');
await p.getByText('Participant 3', { exact: false }).first().waitFor();
t0 = Date.now();
mark('Three BitSafe Decentralization Manager nodes, one per Canton participant, connected as peers');
await point(p.getByText('Participant 2', { exact: false }));
await beat(1000);
await point(p.getByText('Participant 3', { exact: false }));
await beat(1400);

// 2. The committee: one decentralized party on three participants, 2 of 3.
mark("Talang's valuation committee: one decentralized party, hosted on all three participants. 2 of 3 must confirm");
await nav('Parties');
await click(p.getByText('talang-valuation-committee', { exact: true }));
await point(p.getByText('2 of 3 members must confirm'));
await beat(1200);
await point(p.getByText(/^participants$/i));
await p.mouse.wheel(0, 260);
await beat(1600);

// 3. A member on node 1 proposes a markdown (a Talang MarkProposal, a BitSafe GovernableAction).
await nav('Approvals');
mark('A pricer on node 1 proposes a markdown: UST10Y to 92,000. The MarkProposal is a BitSafe GovernableAction');
const audience = [P.borrower, P.lenderA, P.lenderB, P.lenderC].filter(Boolean);
const propTx = await submit(P1, create('MarkProposal', { committee: COMMITTEE, proposer: P1, instrument: 'UST10Y', price: String(PRICE),
  asOf: new Date().toISOString(), audience, source: SOURCE }));
// The proposal is a ledger command, not a DecMan form: show it as it lands.
await p.evaluate((text) => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:9999;max-width:760px;padding:14px 18px;border-radius:10px;'
    + 'background:#171513;border:1px solid #ff5e1a;color:#e8e2da;font:15px/1.6 ui-monospace,Consolas,monospace;white-space:pre';
  d.textContent = text;
  document.body.appendChild(d);
}, `participant1 · member-p1 · JSON Ledger API\ncreate MarkProposal  UST10Y 92,000  for talang-valuation-committee\nupdate ${propTx.transaction.updateId.slice(0, 40)}…`);
await beat(2600);
await p.reload({ waitUntil: 'load' });

await review();
await point(p.getByText(DESC));
await beat(1800);

// 4. One confirmation is not enough.
mark('Node 1 confirms. 1 of 2: not enough, nothing is published');
await click(card().getByRole('button', { name: 'Confirm', exact: true }));
await p.getByText('Confirmation submitted').first().waitFor({ timeout: 30000 });
await review();
await card().getByText('1 of 2 confirmed').first().waitFor({ timeout: 30000 });
await point(card().getByText('1 of 2 confirmed'));
await beat(2200);

// 5. Node 2, in its own DecMan.
mark('Node 2, in its own DecMan, sees the same proposal and confirms');
await open(2);
await nav('Approvals');
await review();
await point(p.getByText(DESC));
await beat(1000);
await click(card().getByRole('button', { name: 'Confirm', exact: true }));
await p.getByText('Confirmation submitted').first().waitFor({ timeout: 30000 });
await review();
await card().getByText('2 of 2 confirmed').first().waitFor({ timeout: 30000 });
mark('2 of 2: the threshold is met');
await point(card().getByText('2 of 2 confirmed'));
await beat(2200);

// 6. Node 1 executes.
mark("Back on node 1: Execute. BitSafe's GovernanceRules publishes the mark as the committee");
await open(1);
await nav('Approvals');
await review();
await click(card().getByRole('button', { name: 'Execute', exact: true }));
await p.getByText('Proposal executed').first().waitFor({ timeout: 30000 });
await point(p.getByText('Proposal executed'));
await beat(2200);

// 7. The audit trail, on the node that did not vote.
mark('Node 3 did not vote. Its audit trail shows every step on-chain: propose, two confirmations, execute');
await open(3);
await nav('Parties');
await click(p.getByText('talang-valuation-committee', { exact: true }));
const trail = p.getByText(/^audit trail$/i).first();
await click(trail);                                            // expand
await click(trail.locator('xpath=../..').getByRole('button')); // refresh from the ledger
const row = p.locator('tr', { hasText: 'execute_result' }).first();
await click(row.getByLabel('Show details'));
await row.evaluate((e) => e.scrollIntoView({ block: 'start' }));
await p.mouse.wheel(0, -120);
await beat(600);
await point(p.getByText(DESC));
await beat(1400);
await point(p.getByText('confirmers', { exact: false }));
await beat(2000);

// 8. Talang: the lender calls margin on the committee's mark.
const { contracts } = await acs(P.lenderA);
const governed = contracts.filter((c) => c.tpl === 'Mark' && c.arg.agent === COMMITTEE && Number(c.arg.price) === PRICE)
  .sort((a, b) => b.arg.asOf.localeCompare(a.arg.asOf))[0];
const callTx = await submit(P.lenderA, exercise('RepoTrade', trade.cid, 'CallMargin',
  { markCid: governed.cid, respondBy: new Date(Date.now() + 864e5).toISOString() }));
const call = callTx.transaction.events.map((e) => e.CreatedEvent).find((e) => e?.templateId.endsWith(':MarginCall'));
const short = (s) => `${s.slice(0, 18)}…${s.slice(-8)}`;
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
const lines = [
  ['$', `lender A calls margin on repo ${short(trade.cid)} with the committee's mark`],
  ['', ''],
  ['mark', `UST10Y ${fmt(governed.arg.price)}   agent ${COMMITTEE.split('::')[0]} (2 of 3)`],
  ['repo', `${fmt(trade.arg.collateralQty)} UST10Y against ${fmt(trade.arg.terms.principal)} USDC, haircut ${Number(trade.arg.haircut) * 100}%`],
  ['', ''],
  ['✓', `MarginCall ${short(created(callTx, 'MarginCall'))}`],
  ['', `units due  ${fmt(call.createArgument.unitsDue)} UST10Y   owed ${fmt(call.createArgument.owed)} USDC`],
  ['', `update id  ${callTx.transaction.updateId}`],
];
await p.setContent(`<!doctype html><html><body style="margin:0;background:#0f0e0d;color:#e8e2da;font:20px/1.7 ui-monospace,Consolas,monospace;display:flex;align-items:center;justify-content:center;height:100vh">
  <div style="width:1360px;border:1px solid #2a2622;border-radius:12px;background:#171513;overflow:hidden">
    <div style="padding:12px 20px;border-bottom:1px solid #2a2622;color:#8a827a;font-size:15px">participant1 · JSON Ledger API · talang-repo</div>
    <pre id="out" style="margin:0;padding:24px 28px;white-space:pre-wrap;word-break:break-all;min-height:420px"></pre></div></body></html>`);
mark("Talang: the lender calls margin on an open repo with the committee's mark. No single pricer could move it");
for (const [tag, text] of lines) {
  await p.evaluate(([tag, text]) => {
    const col = { '$': '#ff5e1a', '✓': '#3ddc97', mark: '#8a827a', repo: '#8a827a' }[tag] ?? '#8a827a';
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:80px 1fr;min-height:1.7em';
    const a = document.createElement('span'); a.style.color = col; a.textContent = tag;
    const b = document.createElement('span'); b.textContent = text;
    row.append(a, b);
    document.getElementById('out').append(row);
  }, [tag, text]);
  await beat(text ? 650 : 150);
}
await beat(5000);
mark('end');
await ctx.close();
await browser.close();

const webm = (await readdir(RAW)).find((f) => f.endsWith('.webm'));
if (!webm) throw new Error('no capture was written');
try {
  execFileSync('ffmpeg', ['-y', '-ss', ((t0 - vStart) / 1000).toFixed(2), '-i', join(RAW, webm), '-c:v', 'libx264', '-crf', '20', '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['ignore', 'ignore', 'pipe'] });
  await rm(RAW, { recursive: true, force: true });
} catch {
  await rename(join(RAW, webm), OUT.replace(/\.mp4$/, '.webm'));
  console.log('ffmpeg failed; kept the webm');
  process.exit(1);
}
await writeFile(OUT.replace(/\.mp4$/, '.marks.json'), JSON.stringify(marks, null, 2) + '\n');

// Captioned copy: the desk video's bottom bar (pad to 980 high, subtitles from the marks).
const ts = (s) => new Date(s * 1000).toISOString().slice(11, 23).replace('.', ',');
const srt = marks.slice(0, -1).map((m, i) => `${i + 1}\n${ts(m.at)} --> ${ts(marks[i + 1].at)}\n${m.label}\n`).join('\n');
await writeFile(join(MEDIA, 'decman-demo.srt'), srt);
execFileSync('ffmpeg', ['-y', '-i', 'decman-demo.mp4', '-vf',
  "pad=1600:980:0:0:color=0x15121c,subtitles=decman-demo.srt:force_style='FontSize=9,MarginV=6'",
  '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'decman-demo-captioned.mp4'],
  { cwd: MEDIA, stdio: ['ignore', 'ignore', 'pipe'] });
console.log('wrote', OUT, 'and media/decman-demo-captioned.mp4', `(${marks.at(-1).at}s)`);
