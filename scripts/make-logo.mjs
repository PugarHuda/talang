// Square logo (480x480 PNG) from the desk's hexagon mark, for submission forms.
import { chromium } from 'playwright';
const html = `<!doctype html><html><head><style>
html,body{margin:0;width:480px;height:480px}
body{display:grid;place-items:center;background:radial-gradient(120% 120% at 30% 20%,#efe8ff 0%,#d9ccff 45%,#b79bff 100%);font-family:Geist,system-ui,sans-serif}
.box{display:flex;flex-direction:column;align-items:center;gap:18px}
b{font-size:64px;letter-spacing:-2px;color:#120d24;font-weight:600}
</style></head><body><div class="box">
<svg viewBox="0 0 32 32" width="230" height="230"><path d="M16 3 28 10v12L16 29 4 22V10z" fill="#120d24"/><path d="M16 3 28 10 16 17 4 10z" fill="#3a2b66"/><path d="M16 17v12L4 22V10z" fill="#1d1538"/><circle cx="16" cy="17" r="3.2" fill="#8b5cff"/></svg>
<b>talang</b></div></body></html>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 480, height: 480 } });
await p.setContent(html);
await p.screenshot({ path: 'media/talang-logo.png' });
await p.setContent(html.replace('<b>talang</b>', ''));
await p.screenshot({ path: 'media/talang-logo-mark.png' });
await b.close();
console.log('wrote media/talang-logo.png, media/talang-logo-mark.png');
