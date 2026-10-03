// Local desk: serves web/ and proxies the ledger with the token held here.
// The browser names a ROLE, never a party id, so it can only act as this desk's parties.
//   node server.mjs   ->  http://localhost:8090
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARTIES, acs, submit } from './lib/ledger.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), 'web');
const PORT = Number(process.env.PORT ?? 8090);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const body = (req) => new Promise((res) => { let s = ''; req.on('data', (d) => (s += d)); req.on('end', () => res(s ? JSON.parse(s) : {})); });
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

createServer(async (req, res) => {
  try {
    if (req.url === '/api/config') return send(res, 200, { parties: PARTIES, readOnly: false });
    if (req.url === '/api/acs' && req.method === 'POST') {
      const { role } = await body(req);
      if (!PARTIES[role]) return send(res, 400, { error: 'unknown role' });
      return send(res, 200, await acs(PARTIES[role]));
    }
    if (req.url === '/api/submit' && req.method === 'POST') {
      const { role, command } = await body(req);
      if (!PARTIES[role]) return send(res, 400, { error: 'unknown role' });
      return send(res, 200, await submit(PARTIES[role], command));
    }
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const file = await readFile(join(WEB, path.replace(/\.\./g, '')));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(file);
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, { error: 'not found' });
    send(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Talang desk on http://localhost:${PORT}`));
