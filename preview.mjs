// Local static preview only. No application backend, uploads, or external requests.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const allowed = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/model.js', ['model.js', 'text/javascript; charset=utf-8']],
  ['/effects.js', ['effects.js', 'text/javascript; charset=utf-8']],
  ['/storage.js', ['storage.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);
http.createServer(async (req, res) => {
  const asset = allowed.get(new URL(req.url, 'http://127.0.0.1').pathname);
  if (!asset || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const data = await readFile(path.join(root, asset[0]));
    res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (_) { res.writeHead(500); res.end('Preview unavailable'); }
}).listen(4317, '127.0.0.1', () => process.stdout.write('Local: http://127.0.0.1:4317\n'));
