// Local desk: serves web/ and proxies the ledger with the token held here.
// The browser names a ROLE, never a party id, so it can only act as this desk's parties.
//   node server.mjs   ->  http://localhost:8090
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARTIES, acs, submit } from './lib/ledger.mjs';
import { walletConfig, walletSubmit, receiptsFor, checkWalletSignature } from './api/wallet-verify.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), 'web');
const PORT = Number(process.env.PORT ?? 8090);
// READ_ONLY=1 serves the hosted copy's behaviour locally: reads only, no submit.
const READ_ONLY = process.env.READ_ONLY === '1';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const body = (req) => new Promise((res) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch { res(null); } }); });
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  try {
    if (req.url === '/api/config') return send(res, 200, { parties: PARTIES, readOnly: READ_ONLY, ...walletConfig() });
    if (req.url === '/api/acs' && req.method === 'POST') {
      const { role } = (await body(req)) ?? {};
      if (!Object.hasOwn(PARTIES, role)) return send(res, 400, { error: 'unknown role' });
      return send(res, 200, await acs(PARTIES[role]));
    }
    if (req.url === '/api/submit' && req.method === 'POST') {
      if (READ_ONLY) return send(res, 403, { error: 'read-only desk' });
      const { role, command, walletAuth } = (await body(req)) ?? {};
      if (!Object.hasOwn(PARTIES, role)) return send(res, 400, { error: 'unknown role' });
      return send(res, ...(await walletSubmit(role, command, walletAuth, submit)));
    }
    // Wallet signatures (api/wallet-verify.mjs): stateless check, and the receipts a role may see.
    if (req.url === '/api/wallet-verify' && req.method === 'POST') return send(res, 200, await checkWalletSignature((await body(req)) ?? {}));
    if (req.url === '/api/wallet-receipts' && req.method === 'POST') {
      const { role } = (await body(req)) ?? {};
      if (!Object.hasOwn(PARTIES, role)) return send(res, 400, { error: 'unknown role' });
      return send(res, 200, receiptsFor(role, (await acs(PARTIES[role])).contracts));
    }
    const bare = req.url.split('?')[0];
    const path = bare === '/' ? '/index.html' : bare === '/desk' ? '/desk.html' : bare;
    const file = await readFile(join(WEB, path.replace(/\.\./g, '')));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(file);
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, { error: 'not found' });
    // A ledger refusal (bad argument, failed assertion) is the client's, not this server's.
    const refused = /^submit (4\d\d):/.exec(e.message);
    send(res, refused ? Number(refused[1]) : 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Talang desk on http://localhost:${PORT}`));
