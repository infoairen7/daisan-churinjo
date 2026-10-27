// Tiny static server for local testing (no deps).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const root = process.argv[2] || 'dist'; const port = +(process.argv[3] || 8765);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg' };
createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[\/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const f = join(root, p); await stat(f);
    res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end('nf'); }
}).listen(port, () => console.log('serving', root, port));
