// QA of the public, read-only deployment judges click: the landing page and /desk reading
// live DevNet data. Nothing here writes to the ledger. Checks every role pill, side by side,
// ?role= / ?view= links, the read-only banner and wallet button, numbers that render,
// privacy counts, time to first data, console errors, broken assets, OG meta, 390 / 1440 px,
// keyboard use, landing links, and the landing's numbers against README.
//   node scripts/qa-hosted.mjs                 (QA_URL=http://localhost:8093 for a READ_ONLY=1 local desk)
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BASE = (process.env.QA_URL ?? 'https://talang-desk.vercel.app').replace(/\/$/, '');
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const DAML = readFileSync(new URL('../daml/Talang.daml', import.meta.url), 'utf8');
const LENDERS = ['lenderA', 'lenderB', 'lenderC'];

const results = [], perf = [];
async function check(name, fn) {
  try { const note = await fn(); results.push([true, name]); console.log('  ok  ', name, note ? `· ${note}` : ''); }
  catch (e) { results.push([false, name, e.message]); console.log('  FAIL', name, '\n       ', e.message.split('\n')[0]); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const postJ = async (path, body) => {
  const t = Date.now();
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})), ms: Date.now() - t };
};

const CFG = await (await fetch(BASE + '/api/config')).json();
const ROLES = ['borrower', 'lenderA', 'lenderB', 'lenderC', 'regulator', 'agent', 'venue'].filter((r) => CFG.parties[r]);
console.log(`QA of ${BASE}: roles ${ROLES.join(', ')}`);

const browser = await chromium.launch();
// One context per viewport; every page logs console errors, page errors and failed or 4xx/5xx responses.
const problems = [];
async function newPage(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console ${page.url()}: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => problems.push(`failed ${r.url()}: ${r.failure()?.errorText}`));
  return page;
}
const ready = (page) => page.waitForFunction(() => /live/.test(document.querySelector('#status')?.textContent)
  && !document.querySelector('#view .skel'), null, { timeout: 30000 });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

// ---------------- API ----------------
const ACS = {};
await check('/api/acs per role: 200 and a list of contracts', async () => {
  const t = Date.now();
  const rs = await Promise.all(ROLES.map((role) => postJ('/api/acs', { role })));
  rs.forEach((r, i) => { assert.equal(r.status, 200, `${ROLES[i]}: ${JSON.stringify(r.json).slice(0, 120)}`); ACS[ROLES[i]] = r.json.contracts; perf.push([`api ${ROLES[i]}`, r.ms]); });
  perf.push(['api all roles in parallel', Date.now() - t]);
  return ROLES.map((r) => `${r} ${ACS[r].length}`).join(', ');
});
await check('privacy in the data: lenders hold only their own quotes', async () => {
  for (const l of LENDERS.filter((r) => ACS[r])) {
    const rivals = ACS[l].filter((c) => c.tpl === 'RepoQuote' && c.arg.lender !== CFG.parties[l]).length;
    assert.equal(rivals, 0, `${l} sees ${rivals} rival quotes`);
  }
});
await check('privacy in the data: regulator holds no request, quote, loss notice, holding or mark', async () => {
  const leak = ACS.regulator.filter((c) => !['RepoReport', 'BestExecution'].includes(c.tpl));
  assert.equal(leak.length, 0, leak.map((c) => c.tpl).join());
});
await check('/api/acs refuses writes and unknown roles; no /api/submit here', async () => {
  assert.equal((await fetch(BASE + '/api/acs')).status, 405);
  assert.equal((await postJ('/api/acs', { role: 'intruder' })).status, 400);
  const s = await postJ('/api/submit', { role: 'borrower', command: {} });
  assert.ok([403, 404, 405].includes(s.status), `submit answered ${s.status}`);
});
await check('/api/acs with `since` = current offset answers unchanged (no re-download)', async () => {
  const a = await postJ('/api/acs', { role: 'regulator' });
  const b = await postJ('/api/acs', { role: 'regulator', since: a.json.offset });
  assert.ok(b.json.unchanged || Array.isArray(b.json.contracts), 'bad answer');
  assert.ok(b.json.unchanged, `full payload re-sent (${JSON.stringify(b.json).length} bytes); deploy the since-aware api/acs.mjs`);
});

// ---------------- landing ----------------
const land = await newPage();
await check('landing loads; title, description, OG and twitter meta', async () => {
  const r = await land.goto(BASE + '/', { waitUntil: 'networkidle' });
  assert.equal(r.status(), 200);
  const meta = await land.evaluate(() => Object.fromEntries([...document.querySelectorAll('meta[property], meta[name]')]
    .map((m) => [m.getAttribute('property') ?? m.getAttribute('name'), m.content])));
  for (const k of ['description', 'og:title', 'og:description', 'og:image', 'twitter:card', 'twitter:image']) assert.ok(meta[k], `missing ${k}`);
  for (const k of ['og:image', 'twitter:image']) {
    const img = await fetch(meta[k]);
    assert.equal(img.status, 200, `${k} ${meta[k]} -> ${img.status}`);
    assert.match(img.headers.get('content-type') ?? '', /^image\//, `${k} is not an image`);
  }
  assert.ok(meta['og:image'].startsWith('https://'), 'og:image must be absolute');
});
await check('landing: in-page anchors all have a target', async () => {
  const dead = await land.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href'))
    .filter((h) => h.length > 1 && !document.getElementById(h.slice(1))));
  assert.deepEqual(dead, []);
});
await check('landing: every link resolves (no 4xx/5xx)', async () => {
  const hrefs = [...new Set(await land.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => !h.includes('#'))))];
  const bad = [];
  for (const h of hrefs) {
    const r = await fetch(h, { redirect: 'follow' }).catch((e) => ({ status: e.message }));
    if (!(r.status < 400)) bad.push(`${h} ${r.status}`);
  }
  assert.deepEqual(bad, []);
  return `${hrefs.length} links`;
});
await check('landing: first Tab reaches the skip link, which moves focus to main', async () => {
  await land.keyboard.press('Tab');
  assert.equal(await land.evaluate(() => document.activeElement?.className), 'skip');
  await land.keyboard.press('Enter');
  assert.equal(await land.evaluate(() => location.hash), '#main');
});
await check('landing: no horizontal scroll at 1440 and 390 px', async () => {
  assert.ok(await noHScroll(land) <= 0, '1440 overflows');
  const m = await newPage({ width: 390, height: 844 });
  await m.goto(BASE + '/', { waitUntil: 'networkidle' });
  const over = await noHScroll(m);
  await m.context().close();
  assert.ok(over <= 0, `390 overflows by ${over}px`);
});
await check('landing numbers are backed by README / code', async () => {
  const text = await land.evaluate(() => document.body.innerText);
  const issues = [];
  const stat = /(\d+) \/ (\d+)\s*Daml scripts/.exec(text);
  if (stat && !README.includes(`${stat[1]} of ${stat[2]} scripts`)) issues.push(`"${stat[0]}" but README says ${/(\d+ of \d+) scripts/.exec(README)?.[1]}`);
  if (/(\d+) \/ \1\s*Daml scripts and MCP/.test(text)) issues.push('Daml scripts and MCP checks counted as one number');
  const mcp = /(\d+) \/ \d+ MCP/.exec(text);
  if (mcp && !README.includes(`${mcp[1]} checks in \`scripts/e2e-mcp.mjs\``)) issues.push(`MCP ${mcp[1]} not in README`);
  const line = /daml\/Talang\.daml\s*L(\d+)/.exec(text)?.[1];
  const real = DAML.split('\n').findIndex((l) => l.startsWith('template RepoQuote')) + 1;
  if (line && Number(line) !== real) issues.push(`code chip says L${line}, RepoQuote is at L${real}`);
  if (/not yet run\.|written up, not yet/i.test(text) && /three-participant DecMan LocalNet/.test(README)) issues.push('landing says DecMan LocalNet not yet run; README says it ran');
  if (/Not yet run against a live registry/i.test(text) && /CBTC is run against the live registry/.test(README)) issues.push('landing says no live registry; README has CBTC on DevNet');
  if (/4,800,000[\s\S]{0,40}10 bp[\s\S]{0,40}30 \/ 360[\s\S]{0,80}400 USDC/.test(text) !== (4800000 * 0.001 * 30 / 360 === 400)) issues.push('fee example arithmetic');
  if (/50,125/.test(text) && !README.includes('50,125')) issues.push('50,125 not in README');
  assert.ok(!issues.length, issues.join('; '));
});

// ---------------- desk ----------------
async function deskChecks(page, role) {
  const data = ACS[role] ?? [];
  const view = await page.locator('#view').innerText();
  assert.ok(!/NaN|undefined|Invalid Date|\[object Object\]|null/.test(view), `bad value in view: ${/.{0,40}(NaN|undefined|Invalid Date|\[object Object\]|null).{0,40}/.exec(view)?.[0]}`);
  assert.equal(await page.locator('#readonly').isVisible(), true, 'read-only banner hidden');
  // The read-only stylesheet hides action buttons; count the ones a visitor can actually press.
  const actions = await page.locator('#view button[data-act]').evaluateAll((bs) => bs.filter((b) => b.checkVisibility()).length);
  assert.equal(actions, 0, `${actions} action buttons on a read-only page (they would fail)`);
  // A dash for a mark is only honest when this role holds no mark for the instrument.
  const marked = new Set(data.filter((c) => c.tpl === 'Mark').map((c) => c.arg.instrument));
  const dashes = await page.evaluate(() => [...document.querySelectorAll('#view .card')].filter((c) => /Mark\s*—/.test(c.innerText))
    .map((c) => c.querySelector('h3')?.innerText ?? ''));
  const wrong = dashes.filter((h) => [...marked].some((i) => h.includes(` ${i}`)));
  assert.deepEqual(wrong, [], 'mark shown as — although the role holds one');
  if (LENDERS.includes(role)) assert.match(await page.locator('#view .proof').innerText(), /Rival quotes never reached you|all of them your own|0 rival/i);
  if (role === 'regulator') assert.match(await page.locator('#view .proof').innerText(), /no request, quote/);
  if (role === 'agent') {
    const rows = await page.locator('#view table tr').count();
    // Re-read: marks may have been published since the first read.
    const now = (await postJ('/api/acs', { role })).json.contracts.filter((c) => c.tpl === 'Mark').length;
    assert.ok(Math.abs(rows - 1 - now) <= 2, `agent marks table has ${rows - 1} rows, ledger has ${now}`);
  }
}

const desk = await newPage();
for (const role of ROLES) {
  await check(`desk ?role=${role}: loads, read-only, honest numbers`, async () => {
    const t = Date.now();
    await desk.goto(`${BASE}/desk?role=${role}`);
    await ready(desk);
    perf.push([`first data ${role}`, Date.now() - t]);
    assert.equal(await desk.evaluate(() => document.body.dataset.role), role);
    assert.equal(await desk.locator(`#roles [data-role="${role}"]`).getAttribute('aria-pressed'), 'true');
    await deskChecks(desk, role);
    return `${Date.now() - t} ms`;
  });
}
await check('desk: one pill per role this ledger has, no pill for a role without a party', async () => {
  const pills = await desk.locator('#roles [data-role]').evaluateAll((bs) => bs.map((b) => b.dataset.role));
  assert.equal(pills.sort().join(), [...ROLES].sort().join());
});
await check('desk: clicking every role pill switches role and repaints', async () => {
  await desk.goto(`${BASE}/desk?role=borrower`); await ready(desk);
  for (const role of ROLES.filter((r) => r !== 'borrower')) {
    await desk.click(`#roles [data-role="${role}"]`);
    await ready(desk);
    assert.equal(await desk.evaluate(() => document.body.dataset.role), role);
    assert.match(await desk.locator('#party').innerText(), new RegExp(CFG.parties[role].split('::')[0]));
    await deskChecks(desk, role);
  }
});
await check('desk: ?role=nonsense falls back to borrower', async () => {
  await desk.goto(`${BASE}/desk?role=nonsense`); await ready(desk);
  assert.equal(await desk.evaluate(() => document.body.dataset.role), 'borrower');
});
await check('desk: side by side from the button and from ?view=side-by-side', async () => {
  await desk.goto(`${BASE}/desk`); await ready(desk);
  const t = Date.now();
  await desk.click('#side-by-side');
  await desk.waitForSelector('#sbs .card', { timeout: 30000 });
  perf.push(['side by side', Date.now() - t]);
  assert.match(desk.url(), /view=side-by-side/);
  const verdicts = await desk.locator('#sbs .card').evaluateAll((cs) => cs.map((c) => [c.dataset.role, c.querySelector('.verdict')?.innerText ?? '', !!c.querySelector('.pill.bad')]));
  assert.deepEqual(verdicts.map((v) => v[0]).sort(), [...ROLES].sort());
  assert.deepEqual(verdicts.filter((v) => v[2]).map((v) => `${v[0]}: ${v[1]}`), [], 'a column shows a leak or an error');
  const text = await desk.locator('#sbs').innerText();
  assert.ok(!/NaN|undefined/.test(text));
  await desk.goto(`${BASE}/desk?view=side-by-side`);
  await desk.waitForSelector('#sbs .card', { timeout: 30000 });
  assert.equal(await desk.locator('#side-by-side').getAttribute('aria-pressed'), 'true');
});
await check('desk: wallet button visible; without a wallet it says so, nothing breaks', async () => {
  await desk.goto(`${BASE}/desk?role=borrower`); await ready(desk);
  assert.ok(await desk.locator('#wallet').isVisible());
  // The dapp SDK either opens its own wallet picker (a popup window) or fails into a toast.
  const popup = desk.context().waitForEvent('page', { timeout: 30000 }).then((p) => 'popup ' + p.url().split(':')[0]).catch(() => null);
  await desk.click('#wallet');
  const toast = desk.waitForFunction(() => !document.querySelector('#toast').hidden, null, { timeout: 30000 })
    .then(() => desk.locator('#toast').innerText()).catch(() => null);
  const t = await Promise.race([popup, toast]).then((x) => x ?? Promise.all([popup, toast]).then((xs) => xs.find(Boolean)));
  assert.ok(t, 'clicking Connect wallet did nothing visible in 30 s');
  if (!t.startsWith('popup')) assert.match(t, /^Wallet: .{4,}/, `toast: ${t}`);
  // A failed or pending connect must not leave a half-built panel or flip the page writable.
  assert.equal(await desk.locator('#wallet-pay').count(), 0);
  assert.equal(await desk.locator('#readonly').isVisible(), true);
  return t.slice(0, 90);
});
await check('desk: keyboard reaches the role pills and Enter switches role', async () => {
  await desk.goto(`${BASE}/desk?role=borrower`); await ready(desk);
  const target = ROLES.find((r) => r !== 'borrower');
  await desk.locator(`#roles [data-role="${target}"]`).focus();
  await desk.keyboard.press('Enter');
  await ready(desk);
  assert.equal(await desk.evaluate(() => document.body.dataset.role), target);
  // Tab order starts at the brand link and reaches the side-by-side button.
  await desk.evaluate(() => document.activeElement?.blur());
  const seen = [];
  for (let i = 0; i < 15; i++) { await desk.keyboard.press('Tab'); seen.push(await desk.evaluate(() => document.activeElement?.id || document.activeElement?.dataset?.role || document.activeElement?.className)); }
  assert.ok(seen.includes('side-by-side') && seen.includes('wallet'), `tab order: ${seen.join(' > ')}`);
});
await check('desk: keyboard focus survives the 5 s poll', async () => {
  await desk.goto(`${BASE}/desk?role=borrower`); await ready(desk);
  // Focus something inside the repainted view when there is something focusable; else the footer link.
  const inView = ':is(#view a, #view button, #view [tabindex]):visible';
  const sel = (await desk.locator(inView).count()) ? inView : '#side-by-side';
  await desk.locator(sel).first().focus();
  const before = await desk.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
  await sleep(11000);
  const after = await desk.evaluate(() => document.activeElement && document.activeElement !== document.body ? document.activeElement.outerHTML.slice(0, 80) : null);
  assert.equal(after, before, 'focus lost on repaint');
});
await check('desk: no horizontal scroll at 390 px; pills and banner visible', async () => {
  const m = await newPage({ width: 390, height: 844 });
  for (const role of ['borrower', 'regulator']) {
    await m.goto(`${BASE}/desk?role=${role}`); await ready(m);
    const over = await noHScroll(m);
    assert.ok(over <= 0, `${role} overflows by ${over}px`);
    assert.ok(await m.locator('#readonly').isVisible());
  }
  await m.goto(`${BASE}/desk?view=side-by-side`); await m.waitForSelector('#sbs .card', { timeout: 30000 });
  const over = await noHScroll(m);
  await m.context().close();
  assert.ok(over <= 0, `side by side overflows by ${over}px`);
});

// Problems collected from every page. The wallet SDK fetch is a third-party load; it is kept.
await check('no console errors, page errors or failed requests', async () => {
  const uniq = [...new Set(problems)];
  assert.deepEqual(uniq, []);
});

await browser.close();
console.log('\nperformance (ms):', perf.map(([k, v]) => `${k} ${v}`).join(' · '));
const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length} / ${results.length} passed`);
for (const [, n, m] of failed) console.log(`  FAIL ${n}: ${m.split('\n')[0]}`);
process.exit(failed.length ? 1 : 0);
