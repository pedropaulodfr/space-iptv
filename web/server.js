#!/usr/bin/env node
/* Space IPTV - servidor estatico da versao web (zero dependencias).
 *
 * Uso:
 *   node web/server.js                        -> http://127.0.0.1:8095/ (proxy desligado)
 *   node web/server.js --proxy                -> liga /__proxy (opt-in)
 *   PORT=8099 node web/server.js --proxy      -> outra porta
 *   node web/server.js --host 0.0.0.0         -> expoe na LAN (aviso no console)
 *
 * Rotas:
 *   GET  /                  -> web/index.html
 *   GET  /web/...           -> web/...
 *   GET  /tv/...            -> tv/...
 *   GET  /web/index.html    -> 302 /
 *   GET  /__proxy/ping      -> JSON 200 {ok:true|false} (sempre; false = proxy desligado)
 *   GET  /__proxy?url=...   -> repetidor HTTP(S), com rewrite de playlists (somente com --proxy)
 *
 * Sem listagem de diretorio, sem cache (Cache-Control: no-store) e sem dependencias.
 * O proxy nao repassa cookies, nao registra URL/query completa e tem timeout/limite de tamanho.
 * Ele e opt-in e escuta so loopback por padrao; --host 0.0.0.0 vira um proxy aberto na rede.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const TV_DIR = path.join(ROOT, 'tv');
const REAL_ROOT = (function () {
  try { return fs.realpathSync(ROOT); } catch (e) { return ROOT; }
})();

const DEFAULT_PORT = 8095;
const DEFAULT_HOST = '127.0.0.1';
const VERSION = '1.0.0';

/* Limites do proxy (bytes/ms). Ajustaveis por env para testes/diagnostico. */
const PROXY_PLAYLIST_MAX = envInt('PROXY_PLAYLIST_MAX', 32 * 1024 * 1024, 1024);
const PROXY_HEADERS_TIMEOUT = envInt('PROXY_HEADERS_TIMEOUT', 15000, 100);
const PROXY_IDLE_TIMEOUT = envInt('PROXY_IDLE_TIMEOUT', 30000, 100);
const PROXY_MAX_URL = 8192;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.m3u': 'audio/x-mpegurl; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

/* -------------------------------------------------------------------------- */
/* CLI / configuracao                                                          */
/* -------------------------------------------------------------------------- */

function envInt(name, fallback, min) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    console.warn('[config] ' + name + ' invalido; usando ' + fallback + '.');
    return fallback;
  }
  return Math.floor(n);
}

function parseConfig(argv) {
  const cfg = {
    port: envInt('PORT', DEFAULT_PORT, 1),
    host: process.env.HOST || DEFAULT_HOST,
    proxy: /^(1|true|yes|on)$/i.test(String(process.env.PROXY || '')),
    help: false,
    error: ''
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      cfg.help = true;
    } else if (arg === '--proxy') {
      cfg.proxy = true;
    } else if (arg === '--no-proxy') {
      cfg.proxy = false;
    } else if (arg === '--port') {
      cfg.port = Number(argv[++i]);
    } else if (arg.indexOf('--port=') === 0) {
      cfg.port = Number(arg.slice(7));
    } else if (arg === '--host') {
      cfg.host = argv[++i] || '';
    } else if (arg.indexOf('--host=') === 0) {
      cfg.host = arg.slice(7);
    } else {
      cfg.error = 'Argumento desconhecido: ' + arg;
    }
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    cfg.error = 'Porta invalida: ' + cfg.port + ' (use 1-65535).';
  }
  if (!cfg.host) cfg.error = 'Host invalido.';
  return cfg;
}

function usage() {
  return [
    'Space IPTV - servidor web (zero dependencias)',
    '',
    'Uso: node web/server.js [--proxy] [--port N] [--host H]',
    '',
    '  --proxy        liga GET /__proxy?url=... (opt-in; sem autenticacao)',
    '  --no-proxy     desliga mesmo com PROXY=1 no ambiente',
    '  --port N       porta (padrao 8095; env PORT)',
    '  --host H       bind (padrao 127.0.0.1; env HOST; 0.0.0.0 = rede local)',
    '  --help, -h     esta ajuda',
    '',
    'Env opcionais do proxy:',
    '  PROXY=1                    liga o proxy',
    '  PROXY_PLAYLIST_MAX=bytes   limite de playlist reescrita (padrao 32 MiB)',
    '  PROXY_HEADERS_TIMEOUT=ms   timeout de cabecalhos (padrao 15000)',
    '  PROXY_IDLE_TIMEOUT=ms      timeout sem dados no streaming (padrao 30000)'
  ].join('\n');
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
}

/* -------------------------------------------------------------------------- */
/* Helpers HTTP                                                               */
/* -------------------------------------------------------------------------- */

function sendText(res, status, text, extra) {
  if (!res || res.destroyed || res.writableEnded) return;
  const body = Buffer.from(String(text == null ? '' : text) + '\n', 'utf8');
  const headers = Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extra || {});
  res.writeHead(status, headers);
  const req = res.req;
  res.end(req && req.method === 'HEAD' ? undefined : body);
}

function sendRedirect(res, location) {
  if (!res || res.destroyed || res.writableEnded) return;
  res.writeHead(302, {
    Location: location,
    'Content-Length': 0,
    'Cache-Control': 'no-store'
  });
  res.end();
}

function sendJson(res, status, obj) {
  if (!res || res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(obj) + '\n', 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  const req = res.req;
  res.end(req && req.method === 'HEAD' ? undefined : body);
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function isInside(base, target) {
  const rel = path.relative(base, target);
  return !!rel && !path.isAbsolute(rel) && rel !== '..' && rel.indexOf('..' + path.sep) !== 0;
}

/* -------------------------------------------------------------------------- */
/* Sanitize de caminho                                                        */
/* -------------------------------------------------------------------------- */

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch (e) { return null; }
}

/* Rejeita dot segments, separadores Windows e percent-encoding malformado. */
function hasDotSegment(decoded) {
  const parts = String(decoded).split(/[\\/]+/);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg) continue;
    if (seg === '.' || seg === '..') return true;
    if (seg.indexOf(':') >= 0) return true; /* drive letter / ADS no Windows */
    const trimmed = seg.replace(/[ .]+$/, '');
    if (trimmed === '' || trimmed === '.' || trimmed === '..') return true;
  }
  return false;
}

function hasTraversal(rawPath) {
  if (!rawPath) return false;
  if (rawPath.indexOf('\0') >= 0 || /%00/i.test(rawPath)) return true;
  const once = safeDecode(rawPath);
  if (once == null) return true;
  if (once.indexOf('\0') >= 0 || hasDotSegment(once)) return true;
  /* defesa extra contra duplo-encoding (%252e%252e) */
  const twice = safeDecode(once);
  if (twice != null && twice !== once && (twice.indexOf('\0') >= 0 || hasDotSegment(twice))) return true;
  return false;
}

function rawPathname(reqUrl) {
  let s = String(reqUrl == null ? '/' : reqUrl);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { return new URL(s).pathname; } catch (e) { return s; }
  }
  const q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  return s;
}

/* Mapeia a rota publica para um arquivo dentro de web/ ou tv/. */
function mapStatic(pathname) {
  if (pathname === '/') return { status: 200, file: path.join(WEB_DIR, 'index.html') };
  if (pathname === '/web/index.html') return { redirect: '/' };

  let base, rel;
  if (pathname.indexOf('/web/') === 0) {
    base = WEB_DIR;
    rel = pathname.slice('/web/'.length);
  } else if (pathname.indexOf('/tv/') === 0) {
    base = TV_DIR;
    rel = pathname.slice('/tv/'.length);
  } else {
    return { status: 404 };
  }
  if (!rel) return { status: 404 };

  const decoded = safeDecode(rel);
  if (decoded == null) return { status: 400 };
  if (!decoded || decoded.indexOf('\0') >= 0) return { status: 400 };
  if (decoded.charAt(0) === '/' || decoded.charAt(0) === '\\') return { status: 400 };
  if (path.posix.isAbsolute(decoded) || path.win32.isAbsolute(decoded)) return { status: 400 };

  const parts = decoded.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return { status: 404 };
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '.' || seg === '..') return { status: 400 };
    if (seg.indexOf(':') >= 0) return { status: 400 };
  }

  const target = path.resolve(base, parts.join(path.sep));
  if (!isInside(base, target)) return { status: 400 };
  return { status: 200, file: target };
}

/* -------------------------------------------------------------------------- */
/* Estatico                                                                   */
/* -------------------------------------------------------------------------- */

async function serveFile(req, res, file) {
  let stat;
  try { stat = await fs.promises.stat(file); } catch (e) { return sendText(res, 404, 'Não encontrado.'); }
  if (!stat.isFile()) return sendText(res, 404, 'Não encontrado.');

  /* defesa extra: symlink/junction nao pode escapar da raiz do repositorio */
  try {
    const real = await fs.promises.realpath(file);
    if (!isInside(REAL_ROOT, real)) return sendText(res, 404, 'Não encontrado.');
  } catch (e) {
    return sendText(res, 404, 'Não encontrado.');
  }

  const headers = {
    'Content-Type': mimeOf(file),
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(file);
  stream.on('error', function () {
    if (!res.headersSent) sendText(res, 404, 'Não encontrado.');
    else res.destroy();
  });
  res.on('close', function () {
    if (!res.writableEnded) stream.destroy();
  });
  stream.pipe(res);
}

/* -------------------------------------------------------------------------- */
/* Proxy local (opt-in)                                                       */
/* -------------------------------------------------------------------------- */

function redactTarget(raw) {
  try {
    const u = new URL(raw);
    return u.protocol + '//' + u.host + '/...';
  } catch (e) {
    return '(url invalida)';
  }
}

/* Copia apenas headers seguros do cliente. Sem Cookie/Referer/Authorization. */
function upstreamHeaders(req) {
  const h = { 'accept-encoding': 'identity' };
  if (req.headers.accept) h.accept = req.headers.accept;
  if (req.headers.range) h.range = req.headers.range;
  if (req.headers['if-range']) h['if-range'] = req.headers['if-range'];
  if (req.headers['user-agent']) h['user-agent'] = req.headers['user-agent'];
  return h;
}

function passThroughHeaders(response) {
  const h = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  const ct = response.headers.get('content-type');
  h['Content-Type'] = ct || 'application/octet-stream';
  const encoding = response.headers.get('content-encoding');
  const length = response.headers.get('content-length');
  if (!encoding && length && /^\d+$/.test(length)) h['Content-Length'] = length;
  const cr = response.headers.get('content-range');
  if (cr) h['Content-Range'] = cr;
  const ar = response.headers.get('accept-ranges');
  if (ar) h['Accept-Ranges'] = ar;
  const lm = response.headers.get('last-modified');
  if (lm) h['Last-Modified'] = lm;
  return h;
}

function bufferLooksLikePlaylist(buf) {
  if (!buf || !buf.length) return false;
  let s = buf.subarray(0, Math.min(buf.length, 64)).toString('latin1');
  s = s.replace(/^\u00EF\u00BB\u00BF/, '').replace(/^\uFEFF+/, '').replace(/^\s+/, '');
  return s.indexOf('#EXTM3U') === 0;
}

function proxyUri(uri, baseUrl, proxyBase) {
  if (!uri) return null;
  let abs;
  try { abs = new URL(uri, baseUrl); } catch (e) { return null; }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
  return (proxyBase || '') + '/__proxy?url=' + encodeURIComponent(abs.href);
}

/* Reescreve URIs de playlist (linhas de URI, #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA...).
   proxyBase e a origem absoluta do app (http://host:porta): o parser M3U do app so
   aceita URLs com esquema, entao o rewrite do proxy precisa ser absoluto. */
function rewritePlaylist(text, baseUrl, proxyBase) {
  const src = String(text).replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    let next = line;
    if (trimmed && trimmed.charAt(0) !== '#') {
      const proxied = proxyUri(trimmed, baseUrl, proxyBase);
      if (proxied) next = proxied;
    } else if (trimmed.indexOf('#EXT') === 0) {
      next = line.replace(/URI=("([^"]*)"|'([^']*)')/g, function (match, quoted, dq, sq) {
        const proxied = proxyUri(dq != null ? dq : sq, baseUrl, proxyBase);
        return proxied ? 'URI="' + proxied + '"' : match;
      });
    }
    out.push(next);
  }
  return out.join('\n');
}

function writeChunk(res, buf) {
  if (res.destroyed) return Promise.reject(new Error('cliente desconectado'));
  if (res.write(buf)) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    function cleanup() {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
    }
    function onDrain() { cleanup(); resolve(); }
    function onClose() { cleanup(); reject(new Error('cliente desconectado')); }
    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}

async function handleProxy(req, res, u) {
  if (!CONFIG.proxy) return sendText(res, 404, 'Não encontrado.');
  if (req.method !== 'GET') return sendText(res, 405, 'Método não permitido.', { Allow: 'GET' });
  if (typeof fetch !== 'function') {
    return sendText(res, 501, 'Este Node não tem fetch global (proxy exige Node 18+).');
  }

  const rawTarget = u.searchParams.get('url');
  if (!rawTarget || rawTarget.length > PROXY_MAX_URL) {
    return sendText(res, 400, 'Parâmetro "url" ausente ou grande demais.');
  }
  let target;
  try { target = new URL(rawTarget); } catch (e) { return sendText(res, 400, 'URL inválida.'); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return sendText(res, 400, 'Apenas URLs http:// e https:// são permitidas.');
  }
  if (target.pathname.indexOf('/__proxy') === 0) {
    return sendText(res, 400, 'URL não permitida (recursão no proxy).');
  }

  const ac = new AbortController();
  /* origem do proxy para URLs absolutas no texto reescrito (o parser M3U exige esquema) */
  const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = fwdProto === 'https' ? 'https' : 'http';
  const hostHeader = String(req.headers.host || ('127.0.0.1:' + CONFIG.port)).replace(/[^A-Za-z0-9.:\-\[\]]/g, '');
  const proxyBase = proto + '://' + hostHeader;
  let headersTimer = null;
  let idleTimer = null;
  let reader = null;
  let clientGone = false;
  let timedOut = false;

  function clearTimers() {
    if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
  function abortUpstream() {
    try { ac.abort(); } catch (e) { /* ignore */ }
  }
  function touchIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { timedOut = true; abortUpstream(); }, PROXY_IDLE_TIMEOUT);
  }
  function onClientClose() {
    if (res.writableEnded) return;
    clientGone = true;
    abortUpstream();
  }
  function errorOut(status, message) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    sendText(res, status, message);
  }

  res.on('close', onClientClose);
  headersTimer = setTimeout(function () { timedOut = true; abortUpstream(); }, PROXY_HEADERS_TIMEOUT);

  let response;
  try {
    response = await fetch(target.href, {
      method: 'GET',
      redirect: 'follow',
      signal: ac.signal,
      headers: upstreamHeaders(req)
    });
  } catch (e) {
    clearTimers();
    if (clientGone) return;
    if (timedOut) return errorOut(504, 'Tempo esgotado ao acessar o servidor de origem.');
    console.warn('[proxy] falha ao acessar ' + redactTarget(target.href) + ': ' + (e && e.name ? e.name : 'erro'));
    return errorOut(502, 'Não foi possível acessar o servidor de origem.');
  }
  clearTimeout(headersTimer);
  headersTimer = null;

  try {
    const status = response.status;
    const finalUrl = response.url || target.href;

    if (!response.body) {
      clearTimers();
      res.writeHead(status, passThroughHeaders(response));
      res.end();
      return;
    }

    reader = response.body.getReader();
    touchIdle();
    const first = await reader.read();
    if (first.done) {
      clearTimers();
      if (res.destroyed) return;
      res.writeHead(status, passThroughHeaders(response));
      res.end();
      return;
    }

    let firstBuf = Buffer.from(first.value.buffer, first.value.byteOffset, first.value.byteLength);
    /* prefixo pequeno suficiente para detectar BOM + #EXTM3U mesmo em chunks curtos */
    while (firstBuf.length < 16) {
      touchIdle();
      const next = await reader.read();
      if (next.done) break;
      const b = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      firstBuf = Buffer.concat([firstBuf, b]);
    }

    if (status === 200 && bufferLooksLikePlaylist(firstBuf)) {
      const chunks = [firstBuf];
      let size = firstBuf.length;
      if (size > PROXY_PLAYLIST_MAX) throw new Error('size-limit');
      while (true) {
        touchIdle();
        const next = await reader.read();
        if (next.done) break;
        const b = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        size += b.length;
        if (size > PROXY_PLAYLIST_MAX) throw new Error('size-limit');
        chunks.push(b);
      }
      clearTimers();
      const text = Buffer.concat(chunks, size).toString('utf8');
      const rewritten = Buffer.from(rewritePlaylist(text, finalUrl, proxyBase), 'utf8');
      if (res.destroyed) return;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': rewritten.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(rewritten);
      return;
    }

    /* midia/binario: streaming sem bufferizar o arquivo inteiro */
    res.writeHead(status, passThroughHeaders(response));
    if (res.destroyed) return;
    await writeChunk(res, firstBuf);
    while (true) {
      touchIdle();
      const next = await reader.read();
      if (next.done) break;
      await writeChunk(res, Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength));
    }
    clearTimers();
    res.end();
  } catch (e) {
    clearTimers();
    if (clientGone) return;
    if (e && e.message === 'size-limit') {
      return errorOut(502, 'A resposta é grande demais para ser reescrita pelo proxy.');
    }
    if (timedOut) return errorOut(504, 'Tempo esgotado ao ler a resposta do servidor de origem.');
    console.warn('[proxy] resposta interrompida: ' + (e && e.message ? e.message : 'erro'));
    return errorOut(502, 'A conexão com o servidor de origem foi interrompida.');
  } finally {
    clearTimers();
    if (reader) {
      try { await reader.cancel(); } catch (e) { /* ignore */ }
    }
    abortUpstream();
    res.removeListener('close', onClientClose);
  }
}

function handlePing(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Método não permitido.', { Allow: 'GET, HEAD' });
  }
  /* Sempre 200 JSON: com o proxy desligado, o navegador nao registra 404 no console.
     net.js considera ativo apenas ok === true. */
  if (!CONFIG.proxy) {
    return sendJson(res, 200, { ok: false, proxy: 'disabled', version: VERSION });
  }
  return sendJson(res, 200, {
    ok: true,
    proxy: 'local',
    version: VERSION,
    playlistMaxBytes: PROXY_PLAYLIST_MAX
  });
}

/* -------------------------------------------------------------------------- */
/* Roteamento                                                                 */
/* -------------------------------------------------------------------------- */

async function handleRequest(req, res) {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (e) {
    return sendText(res, 400, 'Requisição inválida.');
  }

  const raw = rawPathname(req.url);
  if (hasTraversal(raw)) return sendText(res, 400, 'Caminho inválido.');

  if (u.pathname === '/__proxy/ping') return handlePing(req, res);
  if (u.pathname === '/__proxy') return handleProxy(req, res, u);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'Método não permitido.', { Allow: 'GET, HEAD' });
  }

  const info = mapStatic(u.pathname);
  if (info.redirect) return sendRedirect(res, info.redirect);
  if (info.status !== 200) {
    return sendText(res, info.status, info.status === 400 ? 'Caminho inválido.' : 'Não encontrado.');
  }
  return serveFile(req, res, info.file);
}

/* -------------------------------------------------------------------------- */
/* Servidor                                                                   */
/* -------------------------------------------------------------------------- */

function createServer() {
  const server = http.createServer(function (req, res) {
    handleRequest(req, res).catch(function (err) {
      console.error('[servidor] erro: ' + (err && err.message ? err.message : 'desconhecido'));
      try {
        if (!res.headersSent) sendText(res, 500, 'Erro interno.');
        else res.destroy();
      } catch (e) { /* ignore */ }
    });
  });
  server.on('clientError', function (err, socket) {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}

function start(config) {
  const server = createServer();
  let shuttingDown = false;

  server.on('error', function (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('A porta ' + config.port + ' ja esta em uso. Use --port <outra>.');
    } else {
      console.error('Falha ao iniciar: ' + (err && err.message ? err.message : 'erro desconhecido'));
    }
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, function () {
    const shownHost = isLoopback(config.host) ? config.host : '127.0.0.1';
    console.log('Space IPTV web em http://' + shownHost + ':' + config.port + '/');
    console.log('  raiz: ' + ROOT);
    console.log('  proxy local: ' + (config.proxy ? 'ATIVO em /__proxy (opt-in)' : 'desativado (use --proxy)'));
    console.warn('  AVISO: este servidor serve SÓ os assets. Ele não roda as Pages Functions, então');
    console.warn('  AVISO: não existe login aqui. Para o app completo use:');
    console.warn('  AVISO:   node web/build.js && node tools/pages-runner.js   (local, com o banco do Neon)');
    console.warn('  AVISO:   npx wrangler pages dev                            (local, com o runtime do Cloudflare)');
    if (!isLoopback(config.host)) {
      console.warn('');
      console.warn('  AVISO: escutando em ' + config.host + ' (visivel para outras maquinas).');
      console.warn('  AVISO: o proxy /__proxy nao tem autenticacao. Qualquer um na rede pode usar');
      console.warn('  este computador para acessar URLs. Use so em rede confiavel e nunca na internet.');
      console.warn('');
    }
    if (config.proxy && typeof fetch !== 'function') {
      console.warn('  AVISO: Node sem fetch global; /__proxy respondera 501 (use Node 18+).');
    }
  });

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Encerrando (' + signal + ')...');
    server.close(function () { process.exit(0); });
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(function () { process.exit(0); }, 3000).unref();
  }
  process.on('SIGINT', function () { shutdown('SIGINT'); });
  process.on('SIGTERM', function () { shutdown('SIGTERM'); });

  return server;
}

const CONFIG = parseConfig(process.argv);

if (require.main === module) {
  if (CONFIG.help) {
    console.log(usage());
  } else if (CONFIG.error) {
    console.error(CONFIG.error);
    console.error('');
    console.error(usage());
    process.exitCode = 2;
  } else {
    start(CONFIG);
  }
}

module.exports = {
  createServer: createServer,
  mapStatic: mapStatic,
  rewritePlaylist: rewritePlaylist,
  hasTraversal: hasTraversal,
  MIME: MIME
};
