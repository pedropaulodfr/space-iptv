#!/usr/bin/env node
/* Painel local dos agentes — servidor estático + SSE. Zero dependências.
 * Uso: node tools/agents-live/server.js [--port 8096]
 * Bind fixo em 127.0.0.1 (ferramenta de desenvolvimento, sem autenticação).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const ROOT = path.resolve(APP_DIR, '..', '..');
const TV_DIR = path.join(ROOT, 'tv');
const STATE_DIR = path.join(APP_DIR, 'state');
const EVENTS_FILE = path.join(STATE_DIR, 'events.ndjson');
const INDEX_FILE = path.join(APP_DIR, 'index.html');

let PORT = 8096;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port' || a === '-p') PORT = Number(argv[++i]) || PORT;
  else if (a.startsWith('--port=')) PORT = Number(a.slice(7)) || PORT;
  else if (a === '--help' || a === '-h') {
    console.log('Uso: node tools/agents-live/server.js [--port 8096]');
    console.log('Painel: http://127.0.0.1:8096/  (SSE em /events, snapshot em /api/state)');
    process.exit(0);
  }
}
PORT = Math.max(1, Math.min(65535, PORT));

fs.mkdirSync(STATE_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8'
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function readAgents() {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(STATE_DIR).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch (e) {
    return out;
  }
  for (const name of names) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), 'utf8'));
      if (!data || typeof data !== 'object') continue;
      if (!data.agent) data.agent = name.replace(/\.json$/, '');
      if (!data.status) data.status = 'idle';
      if (typeof data.progress !== 'number' || !isFinite(data.progress)) data.progress = 0;
      data.progress = Math.max(0, Math.min(100, Math.round(data.progress)));
      if (!Array.isArray(data.files)) data.files = [];
      if (!data.role) data.role = data.agent;
      if (!data.phase) data.phase = '';
      if (!data.task) data.task = '';
      if (!data.note) data.note = '';
      if (!data.startedAt) data.startedAt = data.updatedAt || 0;
      if (!data.updatedAt) data.updatedAt = data.startedAt || 0;
      if (!data.stateSince) data.stateSince = data.updatedAt;
      out.push(data);
    } catch (e) {
      /* arquivo em escrita ou corrompido: ignora nesta leitura */
    }
  }
  out.sort((a, b) => {
    const ao = String(a.agent).toLowerCase() === 'orquestrador' ? 0 : 1;
    const bo = String(b.agent).toLowerCase() === 'orquestrador' ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return String(a.agent).localeCompare(String(b.agent));
  });
  return out;
}

function readEvents(limit) {
  try {
    const raw = fs.readFileSync(EVENTS_FILE, 'utf8').trim();
    if (!raw) return [];
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-(limit || 60));
    return lines
      .map((line) => {
        try { return JSON.parse(line); } catch (e) { return null; }
      })
      .filter(Boolean)
      .reverse();
  } catch (e) {
    return [];
  }
}

function snapshot() {
  return { agents: readAgents(), events: readEvents(60), now: Date.now() };
}

function stateFingerprint() {
  const parts = [];
  try {
    const names = fs.readdirSync(STATE_DIR).sort();
    for (const name of names) {
      if (!name.endsWith('.json') && name !== 'events.ndjson') continue;
      try {
        const st = fs.statSync(path.join(STATE_DIR, name));
        parts.push(name + ':' + st.size + ':' + st.mtimeMs);
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
  return parts.join('|');
}

/* ---------- SSE ---------- */
const clients = new Set();
let broadcastTimer = null;
let lastFp = stateFingerprint();

function sseSend(res, payload) {
  try {
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  } catch (e) {
    clients.delete(res);
  }
}

function broadcast() {
  const snap = snapshot();
  for (const res of clients) sseSend(res, snap);
}

function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(broadcast, 120);
}

try {
  fs.watch(STATE_DIR, (event, file) => {
    if (!file) return;
    if (file.endsWith('.json') || file === 'events.ndjson') scheduleBroadcast();
  });
} catch (e) {
  console.warn('[agents-live] fs.watch indisponível; usando polling de 500 ms.');
}

setInterval(() => {
  const fp = stateFingerprint();
  if (fp !== lastFp) {
    lastFp = fp;
    scheduleBroadcast();
  }
}, 500);

setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); }
  }
}, 15000).unref();

/* ---------- Arquivos estáticos ---------- */
function safeJoin(base, rel) {
  if (typeof rel !== 'string' || rel.indexOf('\0') !== -1 || rel.indexOf('..') !== -1) return null;
  const target = path.resolve(base, '.' + path.sep + rel.replace(/^[/\\]+/, ''));
  const root = path.resolve(base);
  if (target !== root && target.indexOf(root + path.sep) !== 0) return null;
  return target;
}

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    res.writeHead(200, {
      'Content-Type': mimeOf(file),
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => { try { res.destroy(); } catch (e) { /* ignore */ } });
    stream.pipe(res);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('404 — não encontrado');
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function badRequest(res, message) {
  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message || '400 — requisição inválida');
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    return res.end();
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch (e) {
    return badRequest(res, '400 — caminho inválido');
  }
  if (pathname.indexOf('\0') !== -1 || pathname.indexOf('..') !== -1) {
    return badRequest(res, '400 — caminho inválido');
  }

  if (pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 1000\n\n');
    sseSend(res, snapshot());
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (pathname === '/api/state') {
    const body = JSON.stringify(snapshot());
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end(body);
  }

  if (pathname === '/web/index.html') return redirect(res, '/');
  if (pathname === '/' || pathname === '/index.html') return sendFile(req, res, INDEX_FILE);
  if (pathname === '/app.js') return sendFile(req, res, path.join(APP_DIR, 'app.js'));
  if (pathname === '/style.css') return sendFile(req, res, path.join(APP_DIR, 'style.css'));
  if (pathname === '/favicon.ico') return sendFile(req, res, path.join(TV_DIR, 'icon.png'));

  if (pathname.indexOf('/tv/') === 0) {
    const file = safeJoin(TV_DIR, pathname.slice(4));
    return file ? sendFile(req, res, file) : badRequest(res, '400 — caminho inválido');
  }

  notFound(res);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[agents-live] porta ' + PORT + ' já está em uso. Use --port N.');
    process.exit(1);
  }
  console.error('[agents-live] erro no servidor:', err && err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[agents-live] painel em http://127.0.0.1:' + PORT + '/');
  console.log('[agents-live] state:', STATE_DIR);
});

function shutdown() {
  console.log('\n[agents-live] encerrando…');
  for (const res of clients) {
    try { res.end(); } catch (e) { /* ignore */ }
  }
  clients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
