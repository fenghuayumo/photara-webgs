import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function serve(port = Number(process.env.PORT || 4173)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wgsl': 'text/plain', '.ply': 'application/octet-stream' };
  return createServer(async (req, res) => {
    try {
      let path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
      if (path !== resolve(root) && !path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Invalid path');
      if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
      res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(path));
    } catch { res.writeHead(404); res.end('Not found'); }
  }).listen(port, '127.0.0.1', () => console.log(`Photara WebGS: http://localhost:${port}`));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) serve();
