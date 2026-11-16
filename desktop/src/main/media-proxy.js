/* Proxy de mídia local do Space IPTV Desktop (`GET /media-proxy?url=`).
 *
 * Reaproveita a lógica comprovada de `web/server.js` (mesmo rewrite de playlist,
 * mesmos limites), com as diferenças que o desktop exige:
 *  - a sessão já foi validada pelo servidor interno ANTES de chamar aqui;
 *  - allowlist de hosts via callback `isHostAllowed(host)` (hosts registrados
 *    pelas listas/EPG), negando host fora dela;
 *  - NUNCA repassa Cookie/Referer/Authorization do cliente e nunca deixa
 *    `Set-Cookie`/cabeçalho de CORS do upstream chegar ao renderer;
 *  - recusa recursão (URL apontando para o próprio proxy/origem local) e
 *    protocolos que não sejam http/https;
 *  - redirecionamentos seguem com validação de host em CADA salto;
 *  - URL nunca vai para log (credenciais de Xtream ficam no caminho).
 *
 * O renderer nunca fala com o upstream: o player pede à origem loopback local,
 * o que resolve mixed content e mantém a política de sessão no main.
 *
 * Node puro (sem Electron), testável com `node --test`.
 */
'use strict';

const path = require('path');

const VERSION = '1.0.0';
const MIME_PLAYLIST = 'application/vnd.apple.mpegurl';

const DEFAULT_LIMITS = {
  maxUrl: 8192,
  playlistMaxBytes: 32 * 1024 * 1024,
  headersTimeout: 15000,
  idleTimeout: 30000,
  maxRedirects: 4
};

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
  try {
    res.writeHead(status, headers);
    res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    try { res.destroy(); } catch (e2) { /* ignore */ }
  }
}

function sendJson(res, status, obj) {
  if (!res || res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(obj) + '\n', 'utf8');
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
  } catch (e) {
    try { res.destroy(); } catch (e2) { /* ignore */ }
  }
}

function redactTarget(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol + '//' + u.host + '/...';
  } catch (e) {
    return '(url inválida)';
  }
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch (e) { return null; }
}

/** Cabeçalhos do cliente que podem ir ao upstream (nunca Cookie/Referer/Auth). */
function upstreamHeaders(req) {
  const h = { 'accept-encoding': 'identity' };
  if (!req || !req.headers) return h;
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
  const etag = response.headers.get('etag');
  if (etag) h['ETag'] = etag;
  return h;
}

/** BOM/quebra de linha antes do `#EXTM3U` não impedem a detecção. */
function bufferLooksLikePlaylist(buf) {
  if (!buf || !buf.length) return false;
  let s = buf.subarray(0, Math.min(buf.length, 64)).toString('latin1');
  s = s.replace(/^\u00EF\u00BB\u00BF/, '').replace(/^\uFEFF+/, '').replace(/^\s+/, '');
  return s.indexOf('#EXTM3U') === 0;
}

/* -------------------------------------------------------------------------- */
/* Rewrite de playlist                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Converte uma URI da playlist em URL ABSOLUTA para o proxy local.
 * O parser/player do app exige esquema na URL; por isso nunca é relativa.
 * @param {string} uri
 * @param {string} baseUrl URL final da playlist (para resolver relativas)
 * @param {string} proxyBase ex.: http://127.0.0.1:41000
 * @returns {string|null}
 */
function proxyUri(uri, baseUrl, proxyBase) {
  if (!uri || typeof uri !== 'string') return null;
  let abs;
  try { abs = new URL(uri, baseUrl); } catch (e) { return null; }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
  return (proxyBase || '') + '/media-proxy?url=' + encodeURIComponent(abs.href);
}

/**
 * Reescreve URIs de playlist (linhas de URI, `#EXT-X-KEY`, `#EXT-X-MAP`,
 * `#EXT-X-MEDIA`, `#EXT-X-SESSION-KEY`...) para o proxy local — sempre absolutas.
 * Recusa URIs remotas não http(s) mantendo a linha original.
 */
function rewritePlaylist(text, baseUrl, proxyBase) {
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');
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

/* -------------------------------------------------------------------------- */
/* Proxy                                                                      */
/* -------------------------------------------------------------------------- */

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

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Cria o handler `mediaProxy(req, res, rawTarget, ctx)` para o servidor interno.
 *
 * @param {{
 *   isHostAllowed?: (host:string)=>boolean,
 *   origin?: string,            origem loopback do app (ex.: http://127.0.0.1:41000)
 *   log?: (msg:string)=>void,
 *   limits?: object,
 *   fetchImpl?: typeof fetch
 * }} [opts]
 * @returns {(req:any, res:any, rawTarget?:string, ctx?:any)=>Promise<void>}
 */
function createMediaProxy(opts) {
  const o = opts || {};
  const limits = Object.assign({}, DEFAULT_LIMITS, o.limits || {});
  const log = typeof o.log === 'function' ? o.log : function () {};
  const allow = typeof o.isHostAllowed === 'function' ? o.isHostAllowed : null;
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : (typeof fetch === 'function' ? fetch : null);

  function hostAllowed(host) {
    if (!allow) return true;
    try { return !!allow(String(host || '').toLowerCase()); } catch (e) { return false; }
  }

  function localOrigin(req, ctx) {
    if (ctx && /^https?:\/\/[^/]+$/.test(String(ctx.origin || ''))) return String(ctx.origin);
    if (o.origin && /^https?:\/\/[^/]+$/.test(String(o.origin))) return String(o.origin);
    const hostHeader = String((req && req.headers && req.headers.host) || '').replace(/[^A-Za-z0-9.:\-\[\]]/g, '');
    return 'http://' + (hostHeader || '127.0.0.1');
  }

  function recursoLocal(target, req, ctx) {
    const own = localOrigin(req, ctx);
    if (target.origin !== own) return false;
    const p = target.pathname.toLowerCase();
    return p.indexOf('/media-proxy') === 0 || p.indexOf('/__proxy') === 0 ||
      p.indexOf('/offline/') === 0 || p.indexOf('/api/') === 0;
  }

  return async function mediaProxy(req, res, rawTarget, ctx) {
    if (!fetchImpl) return sendText(res, 501, 'Node sem fetch global (proxy exige Node 18+).');
    if (!req || req.method !== 'GET') {
      return sendText(res, 405, 'Método não permitido.', { Allow: 'GET' });
    }

    /* alvo pode vir como argumento (server.js passa o parâmetro) ou na query */
    let targetRaw = rawTarget;
    if (targetRaw == null) {
      let parsed;
      try { parsed = new URL(String(req.url || ''), 'http://localhost'); } catch (e) { return sendText(res, 400, 'Requisição inválida.'); }
      if (parsed.pathname !== '/media-proxy' && parsed.pathname !== '/__proxy') {
        return sendText(res, 404, 'Não encontrado.');
      }
      targetRaw = parsed.searchParams.get('url');
    }
    if (typeof targetRaw !== 'string' || !targetRaw) {
      return sendText(res, 400, 'Parâmetro "url" ausente.');
    }
    if (targetRaw.length > limits.maxUrl) {
      return sendText(res, 400, 'Parâmetro "url" grande demais.');
    }
    let target;
    try { target = new URL(targetRaw); } catch (e) { return sendText(res, 400, 'URL inválida.'); }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return sendText(res, 400, 'Apenas URLs http:// e https:// são permitidas.');
    }
    if (target.username || target.password) {
      return sendText(res, 400, 'URL não permitida (credenciais embutidas).');
    }
    if (recursoLocal(target, req, ctx)) {
      return sendText(res, 400, 'URL não permitida (recursão no proxy).');
    }
    if (!hostAllowed(target.hostname)) {
      return sendText(res, 403, 'Host de mídia não permitido. Adicione a lista que contém esse provedor.');
    }

    const proxyBase = localOrigin(req, ctx);
    const ac = new AbortController();
    let headersTimer = null;
    let idleTimer = null;
    let clientGone = false;
    let timedOut = false;

    function clearTimers() {
      if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }
    function abortUpstream() { try { ac.abort(); } catch (e) { /* ignore */ } }
    function touchIdle() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { timedOut = true; abortUpstream(); }, limits.idleTimeout);
    }
    function onClientClose() {
      if (res.writableEnded) return;
      clientGone = true;
      abortUpstream();
    }
    function errorOut(status, message) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { try { res.destroy(); } catch (e) { /* ignore */ } return; }
      sendText(res, status, message);
    }

    res.on('close', onClientClose);
    headersTimer = setTimeout(function () { timedOut = true; abortUpstream(); }, limits.headersTimeout);

    let response = null;
    let finalUrl = target.href;

    try {
      /* redirecionamentos: cada salto revalida protocolo/host/recursão */
      let current = target;
      for (let hop = 0; ; hop++) {
        if (hop > limits.maxRedirects) {
          clearTimers();
          return errorOut(502, 'O servidor de origem redirecionou vezes demais.');
        }
        let r;
        try {
          r = await fetchImpl(current.href, {
            method: 'GET',
            redirect: 'manual',
            signal: ac.signal,
            headers: upstreamHeaders(req)
          });
        } catch (e) {
          clearTimers();
          if (clientGone) return;
          if (timedOut) return errorOut(504, 'Tempo esgotado ao acessar o servidor de origem.');
          log('[media-proxy] falha ao acessar ' + redactTarget(current.href) + ': ' + (e && e.name ? e.name : 'erro'));
          return errorOut(502, 'Não foi possível acessar o servidor de origem.');
        }
        if (REDIRECT_STATUS.has(r.status)) {
          const location = r.headers.get('location');
          if (r.body) { try { await r.body.cancel(); } catch (e) { /* ignore */ } }
          if (!location) { response = r; finalUrl = current.href; break; }
          let next;
          try { next = new URL(location, current.href); } catch (e) {
            clearTimers();
            return errorOut(502, 'Redirecionamento inválido do servidor de origem.');
          }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            clearTimers();
            return errorOut(502, 'Redirecionamento para protocolo não permitido.');
          }
          if (next.username || next.password) {
            clearTimers();
            return errorOut(502, 'Redirecionamento com credenciais não é permitido.');
          }
          if (!hostAllowed(next.hostname)) {
            clearTimers();
            return errorOut(502, 'Redirecionamento para host não permitido.');
          }
          if (recursoLocal(next, req, ctx)) {
            clearTimers();
            return errorOut(502, 'Redirecionamento inválido.');
          }
          current = next;
          continue;
        }
        response = r;
        finalUrl = current.href;
        break;
      }
      clearTimeout(headersTimer);
      headersTimer = null;

      const status = response.status;
      if (!response.body) {
        clearTimers();
        res.writeHead(status, passThroughHeaders(response));
        res.end();
        return;
      }

      const reader = response.body.getReader();
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
      while (firstBuf.length < 16) {
        touchIdle();
        const next = await reader.read();
        if (next.done) break;
        firstBuf = Buffer.concat([firstBuf, Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)]);
      }

      /* playlists (master/variante) são reescritas para o proxy local */
      if (status === 200 && bufferLooksLikePlaylist(firstBuf)) {
        const chunks = [firstBuf];
        let size = firstBuf.length;
        if (size > limits.playlistMaxBytes) throw new Error('size-limit');
        while (true) {
          touchIdle();
          const next = await reader.read();
          if (next.done) break;
          const b = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
          size += b.length;
          if (size > limits.playlistMaxBytes) throw new Error('size-limit');
          chunks.push(b);
        }
        clearTimers();
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        const text = Buffer.concat(chunks, size).toString('utf8');
        const rewritten = Buffer.from(rewritePlaylist(text, finalUrl, proxyBase), 'utf8');
        if (res.destroyed) return;
        res.writeHead(200, {
          'Content-Type': MIME_PLAYLIST,
          'Content-Length': rewritten.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(rewritten);
        return;
      }

      /* mídia/binário: streaming contínuo, sem bufferizar o arquivo */
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
      log('[media-proxy] resposta interrompida: ' + (e && e.message ? e.message : 'erro'));
      return errorOut(502, 'A conexão com o servidor de origem foi interrompida.');
    } finally {
      clearTimers();
      try { abortUpstream(); } catch (e) { /* ignore */ }
      res.removeListener('close', onClientClose);
    }
  };
}

/* Mantém a contagem de sondagem igual à do web (`/media-proxy/ping`), útil para
 * o `App.net.init` do renderer decidir se reescreve URLs. `hosts` é informativo. */
function pingPayload(hosts) {
  return {
    ok: true,
    proxy: 'local',
    version: VERSION,
    hosts: Array.isArray(hosts) ? hosts.slice(0, 200) : []
  };
}

function isPlaylistPathname(pathname) {
  return /\.m3u8?$/i.test(String(pathname || '').split('?')[0]);
}

function looksLikePlaylistUrl(url) {
  try { return isPlaylistPathname(new URL(String(url)).pathname); } catch (e) { return false; }
}

module.exports = {
  VERSION,
  MIME_PLAYLIST,
  DEFAULT_LIMITS,
  createMediaProxy,
  rewritePlaylist,
  bufferLooksLikePlaylist,
  proxyUri,
  upstreamHeaders,
  passThroughHeaders,
  pingPayload,
  looksLikePlaylistUrl,
  redactTarget,
  safeDecode,
  sendText,
  sendJson
};
