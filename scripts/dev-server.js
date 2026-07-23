// Minimal local dev server that mimics Vercel's runtime: serves /public
// statically and routes /api/* to the serverless handlers with Vercel-style
// req.body parsing and res.status().json() helpers. Not used in production.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Load .env (KEY=VALUE lines) without a dependency.
try {
  const env = await readFile(path.join(root, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — rely on real env vars */ }

const routes = {
  '/api/tenders': (await import('../api/tenders.js')).default,
  '/api/rules': (await import('../api/rules.js')).default,
  '/api/sanitize-push': (await import('../api/sanitize-push.js')).default,
};

function vercelify(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); return res; };
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[url.pathname];

  if (handler) {
    let body = '';
    for await (const chunk of req) body += chunk;
    try { req.body = body ? JSON.parse(body) : undefined; } catch { req.body = undefined; }
    try {
      await handler(req, vercelify(res));
    } catch (err) {
      vercelify(res).status(500).json({ error: err.message });
    }
    return;
  }

  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const data = await readFile(path.join(root, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, '')));
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});

const port = process.env.PORT ?? 3456;
server.listen(port, () => console.log(`RunBookCase dev server → http://localhost:${port}`));
