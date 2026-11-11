// Static server for a built dist/, shaped like the production host: SPA
// fallback, brotli/gzip on text, ETag revalidation (Vercel's default for
// static files is `max-age=0, must-revalidate`).
//   node scripts/perf/serve.mjs <distDir> [port]
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [dir, port = '4173'] = process.argv.slice(2);
const root = path.resolve(dir);
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.icc': 'application/vnd.iccprofile',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.wasm', '.bcmap']);
const cache = new Map();

const load = (file, enc) => {
    const key = `${file}|${enc}`;
    let hit = cache.get(key);
    if (!hit) {
        const raw = readFileSync(file);
        const body =
            enc === 'br'
                ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } })
                : enc === 'gzip'
                  ? zlib.gzipSync(raw, { level: 9 })
                  : raw;
        hit = { body, etag: `"${createHash('sha1').update(raw).digest('hex').slice(0, 16)}"` };
        cache.set(key, hit);
    }
    return hit;
};

createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
        file = path.join(root, 'index.html');
    }
    const ext = path.extname(file);
    const accept = req.headers['accept-encoding'] ?? '';
    const enc = COMPRESSIBLE.has(ext) ? (accept.includes('br') ? 'br' : accept.includes('gzip') ? 'gzip' : null) : null;
    const { body, etag } = load(file, enc);
    const headers = {
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        ETag: etag,
        Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return;
    }
    if (enc) headers['Content-Encoding'] = enc;
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers).end(body);
}).listen(Number(port), '127.0.0.1', () => console.log(`serving ${root} on :${port}`));
