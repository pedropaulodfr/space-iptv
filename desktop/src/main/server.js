/* Servidor HTTP interno do Space IPTV Desktop.
 *
 * Escuta SOMENTE 127.0.0.1 e serve o renderer (`dist/renderer`) por HTTP — nunca
 * `file://` — para que cookies HttpOnly, fetch same-origin, IndexedDB e localStorage
 * tenham uma origem estável. Também faz o papel de proxy para o backend e para
 * os módulos locais (mídia/downloads/EPG).
 *
 * Rotas (contrato §2.2):
 *   GET  /                      -> dist/renderer/index.html
 *   GET  /login.html            -> dist/renderer/login.html
 *   GET  /<tv|web|css|js|img>/… -> estático dentro de dist/renderer (anti-traversal)
 *   ALL  /api/*                 -> api-proxy.js (403 imediato em /api/admin/*)
 *   GET  /media-proxy/ping      -> {ok:true,proxy:'local',version,hosts} se autenticado
 *   GET  /media-proxy?url=      -> módulo de mídia (downloads) se existir, senão 501
 *   GET  /_epg/source?url=      -> streaming XMLTV (sessão + allowlist de hosts)
 *   GET  /offline/<id>/<rel>    -> módulo de downloads se existir, senão 404
 *   outro                       -> 404
 *
 * Este módulo NÃO depende de `electron` (testável em Node puro).
 * Integração com o agente `downloads` (combinada com o lead):
 *   - require('./downloads') → createHandlers({config, emit, isHostAllowed})
 *     com `handlers.mediaProxy(req,res,urlParam)` e `handlers.offline(req,res,{pathname})`;
 *   - `emit('downloads', payload)` repassa eventos ao renderer;
 *   - allowlist de hosts fica AQUI (fonte única) e é entregue via `isHostAllowed`;
 *     se o módulo também expuser `registerMediaHosts`, repassamos (defensivo).
 */
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const apiProxy = require('./api-proxy');

const STATIC_PREFIXES = ['/tv/', '/web/', '/css/', '/js/', '/img/'];
const ROOT_FILES = { '/': 'index.html', '/index.html': 'index.html', '/login.html': 'login.html' };
const EPG_TIMEOUT_MS = 30000;
const EPG_MAX_REDIRECTS = 3;
const HOSTS_BODY_LIMIT = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.wasm': 'application/wasm'
};

/* CSP por HEADER (fonte da verdade; `frame-ancestors` só funciona em header).
   Mesma política de `functions/_lib/http.js`, usada pelo renderer e pelo login. */
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self'",
  "connect-src 'self' blob: data: https: http:",
  "media-src 'self' blob: data: https: http:",
  "worker-src 'self' blob:"
].join('; ');

const NOT_FOUND = { error: 'not_found', message: 'Não encontrado.' };

function isObject(v) { return !!v && typeof v === 'object'; }

function sendJson(res, status, payload, extraHeaders) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload == null ? {} : payload);
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body)
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(body);
}

function contentTypeOf(file) {
  return MIME[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

/* Header Host aceito: apenas loopback na porta em que estamos escutando.
   Protege contra DNS rebinding (um site na web não fala com este servidor). */
function parseHostHeader(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  if (s.charAt(0) === '[') {
    const m = /^(\[[0-9a-f:.]+\])(?::(\d+))?$/.exec(s);
    if (!m) return null;
    return { hostname: m[1], port: m[2] ? Number(m[2]) : null };
  }
  const m = /^([a-z0-9.-]+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  return { hostname: m[1], port: m[2] ? Number(m[2]) : null };
}

function isLoopbackName(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' ||
    /^127\./.test(h) || h === '0.0.0.0' || h === '[::]' || h === '::';
}

function normalizeHost(input) {
  let s = String(input == null ? '' : input).trim().toLowerCase();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { s = new URL(s).hostname.toLowerCase(); } catch (e) { return ''; }
  }
  s = s.split('/')[0].split('?')[0].split('#')[0];
  if (s.charAt(0) === '[') {
    const m = /^(\[[0-9a-f:.]+\])(?::\d+)?$/.exec(s);
    s = m ? m[1] : '';
  } else {
    const m = /^([a-z0-9._-]+)(?::\d+)?$/.exec(s);
    s = m ? m[1] : '';
  }
  s = s.replace(/\.+$/, '');
  if (!s || s.length > 255) return '';
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)$/.test(s)) return '';
  return s;
}

function readBody(req, limit) {
  return new Promise(function (resolve) {
    let size = 0;
    const chunks = [];
    let done = false;
    function finish(result) {
      if (done) return;
      done = true;
      resolve(result);
    }
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, code: 'payload_too_large' });
        try { req.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (!chunks.length) return finish({ ok: true, text: '' });
      finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', function () { finish({ ok: false, code: 'invalid_input' }); });
    req.on('aborted', function () { finish({ ok: false, code: 'invalid_input' }); });
  });
}

/**
 * @param {object} opts
 * @param {object} opts.config            store de config.js (apiOrigin/internalPort)
 * @param {function():string} opts.getRendererDir  pasta do renderer montado
 * @param {function(boolean):void} [opts.onAuthChange]
 * @param {function(string,*}):void} [opts.emit]   eventos p/ renderer: emit(canal, payload)
 * @param {string} [opts.version]
 * @param {object} [opts.env]
 * @param {object} [opts.downloadsModule]  módulo `downloads` injetado (testes)
 * @param {object} [opts.mediaProxyModule] módulo `media-proxy` injetado (testes)
 * @param {function(string):void} [opts.log] log seguro (sem URL/cookie)
 */
function createServer(opts) {
  opts = opts || {};
  const config = opts.config || {};
  const getRendererDir = typeof opts.getRendererDir === 'function'
    ? opts.getRendererDir
    : function () { return ''; };
  const onAuthChange = typeof opts.onAuthChange === 'function' ? opts.onAuthChange : null;
  const emitFn = typeof opts.emit === 'function' ? opts.emit : null;
  const version = String(opts.version || '1.0.0');
  const env = opts.env || process.env;
  const log = typeof opts.log === 'function' ? opts.log : null;

  const state = {
    server: null,
    port: 0,
    url: '',
    started: false,
    authenticated: false,
    sockets: new Set()
  };

  const mediaHosts = new Set();
  let dlResolved = false;
  let dlHandlers = null;
  let dlModule = null;
  let mpResolved = false;
  let mpHandlers = null;

  /* Injeções exclusivas de teste (o main nunca passa): permitem mock em loopback
     e timeout curto sem enfraquecer o comportamento de produção. */
  const hostCheckOverride = typeof opts.isHostAllowed === 'function' ? opts.isHostAllowed : null;
  const apiTimeoutMs = Number(opts.apiTimeoutMs) > 0 ? Number(opts.apiTimeoutMs) : undefined;

  const proxy = apiProxy.createProxy({
    getApiOrigin: function () { return apiOrigin(); },
    timeoutMs: apiTimeoutMs
  });

  function logSafe(message) {
    if (log) { try { log(String(message)); } catch (e) { /* ignore */ } }
  }

  function apiOrigin() {
    try {
      if (typeof config.effectiveApiOrigin === 'function') return String(config.effectiveApiOrigin() || '');
      if (typeof config.apiOrigin === 'string') return config.apiOrigin;
    } catch (e) { /* ignore */ }
    return '';
  }

  function configuredPort() {
    try {
      const raw = config.internalPort;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n <= 65535) return Math.floor(n);
    } catch (e) { /* ignore */ }
    return 0;
  }

  function apiHostname() {
    try { return normalizeHost(new URL(apiOrigin()).hostname); } catch (e) { return ''; }
  }

  function mediaProxySuffixes() {
    const raw = String(env.MEDIA_PROXY_HOSTS || '').trim();
    if (!raw) return [];
    return raw.split(',').map(normalizeHost).filter(Boolean);
  }

  /* Allowlist: registrados pelo renderer + host da API + MEDIA_PROXY_HOSTS.
     Loopback do próprio app é sempre negado (nada de recursão no servidor interno). */
  function isMediaHostAllowed(input) {
    const host = normalizeHost(input);
    if (!host) return false;
    if (hostCheckOverride) { try { return hostCheckOverride(host) === true; } catch (e) { return false; } }
    if (isLoopbackName(host)) return false;
    if (mediaHosts.has(host)) return true;
    if (apiHostname() && host === apiHostname()) return true;
    const suffixes = mediaProxySuffixes();
    for (let i = 0; i < suffixes.length; i++) {
      if (host === suffixes[i] || host.slice(-(suffixes[i].length + 1)) === '.' + suffixes[i]) return true;
    }
    return false;
  }

  function normalizeHostList(list) {
    const raw = Array.isArray(list) ? list : (list == null ? [] : [list]);
    const out = [];
    const seen = new Set();
    for (let i = 0; i < raw.length && out.length < 200; i++) {
      const host = normalizeHost(raw[i]);
      if (!host || isLoopbackName(host) || seen.has(host)) continue;
      seen.add(host);
      out.push(host);
    }
    return out;
  }

  function registerMediaHosts(list) {
    const clean = normalizeHostList(list);
    for (let i = 0; i < clean.length; i++) mediaHosts.add(clean[i]);
    /* Defensivo: se o módulo de downloads mantiver a própria allowlist, avisa. */
    try {
      const handlers = resolveDownloadsHandlers();
      if (handlers && typeof handlers.registerMediaHosts === 'function') handlers.registerMediaHosts(clean);
      else if (dlModule && typeof dlModule.registerMediaHosts === 'function') dlModule.registerMediaHosts(clean);
    } catch (e) { /* nunca falha o IPC por causa disso */ }
    return Array.from(mediaHosts);
  }

  function emit(channel, payload) {
    if (!emitFn) return;
    try { emitFn(String(channel), payload); } catch (e) { logSafe('emit falhou: ' + (e && e.code || 'erro')); }
  }

  /* ---------- módulos opcionais (downloads / media-proxy) ---------- */

  function safeRequire(rel) {
    const file = './' + rel;
    try {
      return require(file);
    } catch (e) {
      if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message || '').indexOf("'" + file + "'") >= 0) return null;
      logSafe('módulo ' + rel + ' falhou ao carregar: ' + (e && e.code || e && e.message || 'erro'));
      return null;
    }
  }

  function resolveDownloadsHandlers() {
    if (dlResolved) return dlHandlers;
    dlResolved = true;
    /* `downloadsModule` injetado (inclusive null p/ testes determinísticos) vence o require. */
    dlModule = Object.prototype.hasOwnProperty.call(opts, 'downloadsModule')
      ? (opts.downloadsModule || null)
      : safeRequire('downloads');
    if (!dlModule) return null;
    try {
      if (typeof dlModule.createHandlers === 'function') {
        dlHandlers = dlModule.createHandlers({
          config: config,
          emit: emit,
          isHostAllowed: isMediaHostAllowed,
          origin: state.url || undefined,
          log: function (message) { logSafe('downloads: ' + message); }
        });
      } else if (typeof dlModule === 'function') {
        dlHandlers = dlModule({ config: config, emit: emit, isHostAllowed: isMediaHostAllowed });
      } else {
        dlHandlers = dlModule;
      }
    } catch (e) {
      logSafe('downloads.createHandlers falhou: ' + (e && e.code || e && e.message || 'erro'));
      dlHandlers = null;
    }
    return dlHandlers;
  }

  function resolveMediaProxyHandlers() {
    if (mpResolved) return mpHandlers;
    mpResolved = true;
    const mod = Object.prototype.hasOwnProperty.call(opts, 'mediaProxyModule')
      ? (opts.mediaProxyModule || null)
      : safeRequire('media-proxy');
    if (!mod) return null;
    try {
      if (typeof mod.createMediaProxy === 'function') {
        /* interface entregue pelo agente downloads em src/main/media-proxy.js */
        mpHandlers = mod.createMediaProxy({
          isHostAllowed: isMediaHostAllowed,
          origin: state.url || undefined,
          log: function (message) { logSafe('media-proxy: ' + message); }
        });
      } else if (typeof mod.createHandlers === 'function') {
        mpHandlers = mod.createHandlers({ config: config, emit: emit, isHostAllowed: isMediaHostAllowed });
      } else if (typeof mod === 'function') {
        mpHandlers = mod({ config: config, emit: emit, isHostAllowed: isMediaHostAllowed });
      } else {
        mpHandlers = mod;
      }
    } catch (e) {
      logSafe('media-proxy.createHandlers falhou: ' + (e && e.code || e && e.message || 'erro'));
      mpHandlers = null;
    }
    return mpHandlers;
  }

  function callHandler(handlers, names, args, res) {
    if (!handlers) return false;
    for (let i = 0; i < names.length; i++) {
      const fn = handlers[names[i]];
      if (typeof fn === 'function') {
        try {
          const p = fn.apply(handlers, args);
          if (p && typeof p.catch === 'function') {
            p.catch(function (e) {
              if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: 'Falha ao processar a mídia.' });
              else { try { res.destroy(); } catch (e2) { /* ignore */ } }
              logSafe('handler de mídia falhou: ' + (e && e.code || e && e.message || 'erro'));
            });
          }
        } catch (e) {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: 'Falha ao processar a mídia.' });
          logSafe('handler de mídia falhou: ' + (e && e.code || e && e.message || 'erro'));
        }
        return true;
      }
    }
    if (typeof handlers === 'function') {
      try { handlers.apply(null, args); return true; } catch (e) { /* cai no 404/501 */ }
    }
    return false;
  }

  /* ---------- sessão em memória ---------- */

  function setAuthenticated(value, reason) {
    const next = value === true;
    if (next === state.authenticated) return;
    state.authenticated = next;
    if (onAuthChange) { try { onAuthChange(next, reason || ''); } catch (e) { /* ignore */ } }
  }

  function trackApiResult(pathname, status) {
    const p = pathname;
    if (status >= 200 && status < 300) {
      if (p === '/api/auth/login' || p === '/api/auth/session') setAuthenticated(true, 'login');
      if (p === '/api/auth/logout') setAuthenticated(false, 'logout');
      return;
    }
    if (status === 401 || status === 403) {
      /* Credencial errada no login não derruba uma sessão existente. */
      if (p !== '/api/auth/login' && p !== '/api/auth/forgot') setAuthenticated(false, 'unauthorized');
    }
  }

  /* ---------- estático ---------- */

  function safeDecodePath(rawPathname) {
    let decoded;
    try { decoded = decodeURIComponent(String(rawPathname || '/')); } catch (e) { return null; }
    if (!decoded) return null;
    if (decoded.indexOf('\u0000') >= 0) return null;
    if (decoded.indexOf('\\') >= 0) return null;
    const normalized = path.posix.normalize(decoded);
    if (normalized !== '/' && normalized.charAt(0) !== '/') return null;
    const parts = normalized.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '..') return null;
      if (parts[i].charAt(0) === '.' && parts[i].length > 1) return null; /* dotfiles */
    }
    return normalized;
  }

  function rendererRoot() {
    const dir = String(getRendererDir() || '');
    return dir ? path.resolve(dir) : '';
  }

  function serveStatic(req, res, method, decodedPath) {
    const root = rendererRoot();
    if (!root) {
      sendJson(res, 500, { error: 'not_configured', message: 'Renderer não encontrado. Reinstale o aplicativo.' });
      return;
    }
    let rel = null;
    if (ROOT_FILES[decodedPath]) rel = ROOT_FILES[decodedPath];
    else {
      for (let i = 0; i < STATIC_PREFIXES.length; i++) {
        if (decodedPath.indexOf(STATIC_PREFIXES[i]) === 0 && decodedPath.length > STATIC_PREFIXES[i].length) {
          rel = decodedPath.slice(1);
          break;
        }
      }
    }
    if (!rel) { sendJson(res, 404, NOT_FOUND); return; }

    const abs = path.resolve(root, rel);
    if (abs !== root && abs.indexOf(root + path.sep) !== 0) {
      sendJson(res, 400, { error: 'bad_request', message: 'Caminho inválido.' });
      return;
    }

    fs.stat(abs, function (err, stat) {
      if (err || !stat || !stat.isFile()) { sendJson(res, 404, NOT_FOUND); return; }
      const type = contentTypeOf(abs);
      const headers = {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
      };
      /* CSP só faz sentido em documento HTML (e `frame-ancestors` exige header). */
      if (type.indexOf('text/html') === 0) headers['Content-Security-Policy'] = CSP;
      res.writeHead(200, headers);
      if (method === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(abs);
      stream.on('error', function () {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: 'Erro ao ler o arquivo.' });
        else { try { res.destroy(); } catch (e) { /* ignore */ } }
      });
      res.on('close', function () {
        if (!res.writableEnded) { try { stream.destroy(); } catch (e) { /* ignore */ } }
      });
      stream.pipe(res);
    });
  }

  /* ---------- EPG (streaming do XMLTV) ---------- */

  function epgRequest(urlObj, res, req, redirectsLeft) {
    let target;
    try {
      target = new URL(String(urlObj.searchParams.get('url') || ''));
    } catch (e) {
      sendJson(res, 400, { error: 'invalid_input', message: 'Endereço do guia inválido.' });
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      sendJson(res, 400, { error: 'invalid_input', message: 'O guia precisa ser http:// ou https://.' });
      return;
    }
    if (target.username || target.password) {
      sendJson(res, 400, { error: 'invalid_input', message: 'Endereço do guia inválido.' });
      return;
    }
    if (!isMediaHostAllowed(target.hostname)) {
      sendJson(res, 403, { error: 'forbidden', message: 'Fonte de guia não permitida neste aplicativo.' });
      return;
    }

    const lib = target.protocol === 'https:' ? https : http;
    let upstream;
    try {
      upstream = lib.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        headers: {
          'user-agent': 'SpaceIPTV-Desktop/' + version,
          'accept': 'application/xml,text/xml,*/*',
          'accept-encoding': 'gzip, deflate'
        },
        timeout: EPG_TIMEOUT_MS
      });
    } catch (e) {
      sendJson(res, 502, { error: 'upstream_error', message: 'Não foi possível baixar o guia agora.' });
      return;
    }

    function bad() {
      if (!res.headersSent) sendJson(res, 502, { error: 'upstream_error', message: 'Não foi possível baixar o guia agora.' });
      else { try { res.destroy(); } catch (e) { /* ignore */ } }
    }

    upstream.setTimeout(EPG_TIMEOUT_MS, function () {
      try { upstream.destroy(new Error('timeout')); } catch (e) { /* ignore */ }
    });
    upstream.on('error', bad);
    upstream.on('response', function (up) {
      const status = up.statusCode || 502;
      if (status >= 300 && status < 400) {
        const location = up.headers && up.headers.location;
        try { up.destroy(); } catch (e) { /* ignore */ }
        if (location && redirectsLeft > 0) {
          let next = null;
          try { next = new URL(location, target); } catch (e) { next = null; }
          if (next && (next.protocol === 'http:' || next.protocol === 'https:') && isMediaHostAllowed(next.hostname)) {
            epgRequest({ searchParams: new URLSearchParams('url=' + encodeURIComponent(next.toString())) }, res, req, redirectsLeft - 1);
            return;
          }
        }
        bad();
        return;
      }
      if (status >= 400) {
        try { up.destroy(); } catch (e) { /* ignore */ }
        bad();
        return;
      }
      const out = {
        'Content-Type': String((up.headers && up.headers['content-type']) || 'application/xml; charset=utf-8'),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      };
      if (up.headers && up.headers['content-encoding']) out['Content-Encoding'] = String(up.headers['content-encoding']);
      if (up.headers && up.headers['content-length']) out['Content-Length'] = String(up.headers['content-length']);
      res.writeHead(200, out);
      req.on('close', function () {
        if (!res.writableEnded) { try { up.destroy(); } catch (e) { /* ignore */ } }
      });
      up.on('error', function () { try { res.destroy(); } catch (e) { /* ignore */ } });
      up.pipe(res);
    });
    upstream.end();
  }

  /* ---------- roteamento ---------- */

  function handle(req, res) {
    res.on('error', function () { /* nunca deixa erro de socket derrubar o processo */ });

    /* 1. Host: só loopback na porta real (anti DNS rebinding). */
    const hostHeader = parseHostHeader(req.headers && req.headers.host);
    const allowedHosts = ['127.0.0.1', 'localhost', '[::1]', '::1'];
    const hostOk = !!(hostHeader && allowedHosts.indexOf(hostHeader.hostname) >= 0 &&
      (hostHeader.port === state.port || (!hostHeader.port && state.port === 80)));
    if (!hostOk) {
      sendJson(res, 400, { error: 'bad_host', message: 'Requisição não permitida para este servidor.' });
      return;
    }

    /* 2. URL: caminho + query. Percent-encoding inválido é recusado. */
    let urlObj;
    try {
      urlObj = new URL(String(req.url || '/'), 'http://127.0.0.1');
    } catch (e) {
      sendJson(res, 400, { error: 'bad_request', message: 'Requisição inválida.' });
      return;
    }
    const decodedPath = safeDecodePath(urlObj.pathname);
    if (!decodedPath) {
      sendJson(res, 400, { error: 'bad_request', message: 'Caminho inválido.' });
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();

    /* 3. API: admin é proibido ANTES de qualquer proxy. */
    if (decodedPath === '/api' || decodedPath.indexOf('/api/') === 0) {
      if (decodedPath === '/api/admin' || decodedPath.indexOf('/api/admin/') === 0) {
        sendJson(res, 403, { error: 'forbidden', message: 'Operação não disponível no aplicativo desktop.' });
        return;
      }
      const originalWrite = res.writeHead;
      res.writeHead = function (status) {
        try { trackApiResult(decodedPath, status); } catch (e) { /* ignore */ }
        return originalWrite.apply(res, arguments);
      };
      proxy.handle(req, res);
      return;
    }

    /* 4. Ping do proxy de mídia (usado por web/js/net.js). */
    if (decodedPath === '/media-proxy/ping') {
      if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { error: 'method_not_allowed', message: 'Método não permitido.' }); return; }
      if (!state.authenticated) {
        sendJson(res, 200, { ok: false, proxy: 'local', version: version, hosts: [] });
        return;
      }
      sendJson(res, 200, { ok: true, proxy: 'local', version: version, hosts: Array.from(mediaHosts) });
      return;
    }

    /* 5. Proxy de mídia (downloads). */
    if (decodedPath === '/media-proxy') {
      if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { error: 'method_not_allowed', message: 'Método não permitido.' }); return; }
      if (!state.authenticated) { sendJson(res, 401, { error: 'unauthorized', message: 'Entre na sua conta para reproduzir.' }); return; }
      const urlParam = urlObj.searchParams.get('url') || '';
      if (!urlParam) { sendJson(res, 400, { error: 'invalid_input', message: 'Informe a URL da mídia.' }); return; }
      const handlers = resolveDownloadsHandlers();
      if (handlers && callHandler(handlers, ['mediaProxy', 'handleMediaProxy', 'media'], [req, res, urlParam, { origin: state.url }], res)) return;
      const mp = resolveMediaProxyHandlers();
      if (mp && callHandler(mp, ['mediaProxy', 'handleMediaProxy', 'proxy', 'handle', 'handleRequest'], [req, res, urlParam, { origin: state.url }], res)) return;
      sendJson(res, 501, { error: 'not_available', message: 'O proxy de mídia ainda não está disponível nesta versão.' });
      return;
    }

    /* 6. EPG: streaming XMLTV com sessão + allowlist. */
    if (decodedPath === '/_epg/source') {
      if (method !== 'GET') { sendJson(res, 405, { error: 'method_not_allowed', message: 'Método não permitido.' }); return; }
      if (!state.authenticated) { sendJson(res, 401, { error: 'unauthorized', message: 'Entre na sua conta para carregar o guia.' }); return; }
      epgRequest(urlObj, res, req, EPG_MAX_REDIRECTS);
      return;
    }

    /* 7. Registro de hosts de mídia (via fetch same-origin; o app usa IPC também). */
    if (decodedPath === '/_hosts') {
      if (method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed', message: 'Método não permitido.' }); return; }
      if (!state.authenticated) { sendJson(res, 401, { error: 'unauthorized', message: ' Entre na sua conta.' }); return; }
      readBody(req, HOSTS_BODY_LIMIT).then(function (body) {
        if (!body.ok) { sendJson(res, 413, { error: 'payload_too_large', message: 'Requisição grande demais.' }); return; }
        let parsed = null;
        try { parsed = JSON.parse(body.text || '{}'); } catch (e) { parsed = null; }
        if (!isObject(parsed) || !Array.isArray(parsed.hosts)) {
          sendJson(res, 400, { error: 'invalid_input', message: 'Lista de hosts inválida.' });
          return;
        }
        const hosts = registerMediaHosts(parsed.hosts);
        sendJson(res, 200, { ok: true, hosts: hosts });
      });
      return;
    }

    /* 8. Arquivos offline (downloads). */
    if (decodedPath.indexOf('/offline/') === 0) {
      if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { error: 'method_not_allowed', message: 'Método não permitido.' }); return; }
      const handlers = resolveDownloadsHandlers();
      if (handlers && callHandler(handlers, ['offline', 'serveOffline', 'handleOffline'], [req, res, { pathname: decodedPath }], res)) return;
      if (dlModule && typeof dlModule.handleOffline === 'function') {
        if (callHandler(dlModule, ['handleOffline', 'offline'], [req, res, { pathname: decodedPath }], res)) return;
      }
      sendJson(res, 404, NOT_FOUND);
      return;
    }

    /* 9. Estático do renderer. */
    if (method === 'GET' || method === 'HEAD') {
      serveStatic(req, res, method, decodedPath);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed', message: 'Método não permitido.' });
  }

  /* ---------- ciclo de vida ---------- */

  function attach(server) {
    server.on('connection', function (socket) {
      state.sockets.add(socket);
      socket.on('close', function () { state.sockets.delete(socket); });
      socket.setNoDelay(true);
    });
    server.on('clientError', function (err, socket) {
      if (socket && !socket.destroyed) {
        try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (e) { /* ignore */ }
      }
    });
  }

  function listen(port) {
    return new Promise(function (resolve, reject) {
      const server = http.createServer(function (req, res) {
        try { handle(req, res); } catch (e) {
          logSafe('erro no handler: ' + (e && e.code || e && e.message || 'erro'));
          if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: 'Erro inesperado.' });
        }
      });
      attach(server);
      function onError(err) {
        server.removeListener('listening', onListening);
        try { server.close(); } catch (e) { /* ignore */ }
        reject(err);
      }
      function onListening() {
        server.removeListener('error', onError);
        server.on('error', function (err) { logSafe('servidor interno: ' + (err && err.code || 'erro')); });
        resolve(server);
      }
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  async function start() {
    if (state.started && state.server) return { port: state.port, url: state.url, fallback: false };
    let fallback = false;
    let server = null;
    const wanted = configuredPort();
    if (wanted > 0) {
      try {
        server = await listen(wanted);
      } catch (err) {
        const code = err && err.code;
        if (code === 'EADDRINUSE' || code === 'EACCES') {
          fallback = true;
          logSafe('porta ' + wanted + ' ocupada; usando porta efêmera');
          server = await listen(0);
        } else {
          throw err;
        }
      }
    } else {
      server = await listen(0);
    }
    state.server = server;
    state.port = server.address().port;
    state.url = 'http://127.0.0.1:' + state.port;
    state.started = true;
    if (fallback && opts.onPortFallback) {
      try { opts.onPortFallback({ wanted: wanted, port: state.port, url: state.url }); } catch (e) { /* ignore */ }
    }
    return { port: state.port, url: state.url, fallback: fallback };
  }

  function stop() {
    return new Promise(function (resolve) {
      const server = state.server;
      state.server = null;
      state.started = false;
      state.authenticated = false;
      if (!server) return resolve();
      for (const socket of state.sockets) {
        try { socket.destroy(); } catch (e) { /* ignore */ }
      }
      state.sockets.clear();
      let done = false;
      const finish = function () { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, 1200);
      timer.unref && timer.unref();
      try {
        server.close(function () { clearTimeout(timer); finish(); });
      } catch (e) {
        clearTimeout(timer);
        finish();
      }
    });
  }

  return {
    start: start,
    stop: stop,
    registerMediaHosts: registerMediaHosts,
    isAuthenticated: function () { return state.authenticated === true; },
    /* extras usados pelo main/telas, sem ampliar o contrato essencial */
    get port() { return state.port; },
    get url() { return state.url; },
    isMediaHostAllowed: isMediaHostAllowed,
    getMediaHosts: function () { return Array.from(mediaHosts); },
    _handle: handle
  };
}

module.exports = { createServer: createServer, normalizeHost: normalizeHost, isLoopbackName: isLoopbackName, MIME: MIME, CSP: CSP };
