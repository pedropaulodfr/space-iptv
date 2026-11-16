/* Reverse proxy `/api/*` do servidor interno para o backend (`config.apiOrigin`).
 *
 * Regras do contrato §2.2:
 *   - método, status, corpo e cabeçalhos repassados;
 *   - `Origin`/`Referer`/`Host` reescritos e `Sec-Fetch-Site: same-origin`
 *     (o middleware do backend exige mesma origem nas escritas);
 *   - `Cookie` repassado sem alteração;
 *   - `Set-Cookie` repassado removendo `Domain` e `Secure` (loopback é HTTP),
 *     preservando `HttpOnly`, `SameSite`, `Path`, `Max-Age`/`Expires`;
 *   - timeout de 30 s; corpo em streaming;
 *   - sem CORS aberto, sem log de URL/cookie/token;
 *   - 502 amigável quando o upstream está inacessível.
 *
 * Módulo puro (sem `electron`), testável com Node.
 */
'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
];

const UPSTREAM_DOWN = {
  error: 'upstream_error',
  message: 'Sem conexão com o servidor. Verifique sua internet.'
};
const UPSTREAM_TIMEOUT = {
  error: 'upstream_timeout',
  message: 'O servidor demorou demais para responder. Tente de novo.'
};
const UPSTREAM_BAD = {
  error: 'upstream_error',
  message: 'Não foi possível concluir a requisição agora. Tente de novo.'
};

/* Remove somente os atributos que quebram o cookie no loopback HTTP.
   `Secure` = cookie nunca seria gravado em http://127.0.0.1; `Domain` = o navegador
   recusaria porque 127.0.0.1 não é subdomínio do backend. */
function sanitizeSetCookie(value) {
  if (typeof value !== 'string' || !value) return '';
  const parts = value.split(';');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    const name = (eq >= 0 ? part.slice(0, eq) : part).trim().toLowerCase();
    if (i > 0 && (name === 'domain' || name === 'secure')) continue;
    out.push(part);
  }
  return out.join('; ');
}

function filterValueHeaders(headers) {
  const out = {};
  for (const name in headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.indexOf(lower) >= 0) continue;
    if (lower.indexOf('access-control-') === 0) continue; /* nada de CORS aberto */
    out[name] = headers[name];
  }
  return out;
}

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * @param {object} opts
 * @param {function():string} opts.getApiOrigin  origem do backend (http/https)
 * @param {number} [opts.timeoutMs]
 * @param {function(string):void} [opts.onUpstreamResult] diagnóstico opcional (status)
 * @returns {{handle: function(import('http').IncomingMessage, import('http').ServerResponse):void}}
 */
function createProxy(opts) {
  opts = opts || {};
  const getApiOrigin = typeof opts.getApiOrigin === 'function' ? opts.getApiOrigin : function () { return ''; };
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const onUpstreamResult = typeof opts.onUpstreamResult === 'function' ? opts.onUpstreamResult : null;

  function handle(req, res) {
    let origin = '';
    try { origin = String(getApiOrigin() || '').trim(); } catch (e) { origin = ''; }
    let target = null;
    try {
      target = new URL(origin);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') target = null;
      if (!target || !target.hostname) target = null;
    } catch (e) {
      target = null;
    }
    if (!target) {
      sendJson(res, 502, UPSTREAM_DOWN);
      return;
    }

    /* `req.url` já vem como caminho+query (`/api/...`). Nunca aceita host absoluto vindo
       do cliente (anti request-smuggling): só o caminho é usado. */
    const rawPath = String(req.url || '/');
    const pathAndQuery = rawPath.charAt(0) === '/' ? rawPath : '/' + rawPath.replace(/^[a-z]+:\/\/[^/]*/i, '');
    let upstreamUrl;
    try {
      upstreamUrl = new URL(pathAndQuery, target.origin);
    } catch (e) {
      sendJson(res, 400, { error: 'bad_request', message: 'Requisição inválida.' });
      return;
    }
    if (upstreamUrl.origin !== target.origin) {
      sendJson(res, 400, { error: 'bad_request', message: 'Requisição inválida.' });
      return;
    }

    const lib = upstreamUrl.protocol === 'https:' ? https : http;
    const method = String(req.method || 'GET').toUpperCase();

    const headers = filterValueHeaders(req.headers);
    delete headers['accept-encoding'];       /* resposta em texto puro: streaming simples e fiel */
    delete headers['content-length'];        /* pode mudar com reescrita de cabeçalhos */
    headers['host'] = upstreamUrl.host;
    headers['origin'] = target.origin;
    headers['referer'] = target.origin + '/';
    headers['sec-fetch-site'] = 'same-origin';
    /* Cookies são repassados como vieram do renderer (já na jar do loopback). */
    if (req.headers.cookie) headers['cookie'] = req.headers.cookie;

    /* Cabeçalhos extras explícitos do cliente que o Node normaliza em minúsculas. */
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (req.headers['content-length'] && !req.headers['transfer-encoding']) {
      headers['content-length'] = req.headers['content-length'];
    }

    let finished = false;
    let upstream = null;

    function fail(payload, status) {
      if (finished) return;
      finished = true;
      sendJson(res, status || 502, payload);
    }

    try {
      upstream = lib.request({
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: method,
        headers: headers,
        timeout: timeoutMs
      });
    } catch (e) {
      fail(UPSTREAM_BAD, 502);
      return;
    }

    let bytesIn = 0;
    req.on('data', function (chunk) {
      bytesIn += chunk.length;
      if (bytesIn > MAX_REQUEST_BYTES) {
        try { upstream.destroy(); } catch (e) { /* ignore */ }
        fail({ error: 'payload_too_large', message: 'Requisição grande demais.' }, 413);
      }
    });
    req.on('error', function () {
      try { upstream.destroy(); } catch (e) { /* ignore */ }
    });
    req.on('aborted', function () {
      try { upstream.destroy(); } catch (e) { /* ignore */ }
    });

    upstream.setTimeout(timeoutMs, function () {
      const timeoutError = new Error('timeout');
      timeoutError.code = 'ETIMEDOUT';
      try { upstream.destroy(timeoutError); } catch (e) { /* ignore */ }
    });

    upstream.on('error', function (err) {
      if (res.headersSent) {
        /* já começou a responder: só corta a resposta (erro de rede no meio do stream) */
        try { res.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      const code = err && err.code;
      if (code === 'ETIMEDOUT' || (err && err.message === 'timeout')) fail(UPSTREAM_TIMEOUT, 504);
      else fail(UPSTREAM_DOWN, 502);
    });

    upstream.on('response', function (up) {
      if (finished) { try { up.destroy(); } catch (e) { /* ignore */ } return; }
      finished = true;
      const status = up.statusCode || 502;
      const outHeaders = filterValueHeaders(up.headers || {});

      const setCookies = up.headers && up.headers['set-cookie'];
      if (setCookies) {
        const cleaned = (Array.isArray(setCookies) ? setCookies : [setCookies])
          .map(sanitizeSetCookie)
          .filter(Boolean);
        if (cleaned.length) outHeaders['set-cookie'] = cleaned;
        else delete outHeaders['set-cookie'];
      }
      outHeaders['cache-control'] = 'no-store';
      outHeaders['x-content-type-options'] = 'nosniff';

      try { res.writeHead(status, outHeaders); } catch (e) {
        try { res.destroy(); } catch (e2) { /* ignore */ }
        return;
      }

      if (onUpstreamResult) {
        try { onUpstreamResult(status); } catch (e) { /* ignore */ }
      }

      up.on('error', function () {
        try { res.destroy(); } catch (e) { /* ignore */ }
      });
      res.on('close', function () {
        if (!res.writableEnded) { try { up.destroy(); } catch (e) { /* ignore */ } }
      });
      up.pipe(res);
    });

    if (method === 'GET' || method === 'HEAD' || method === 'DELETE' || method === 'OPTIONS') {
      upstream.end();
    } else {
      req.pipe(upstream);
    }
  }

  return { handle: handle, timeoutMs: timeoutMs };
}

module.exports = {
  createProxy: createProxy,
  sanitizeSetCookie: sanitizeSetCookie,
  UPSTREAM_DOWN: UPSTREAM_DOWN,
  UPSTREAM_TIMEOUT: UPSTREAM_TIMEOUT,
  UPSTREAM_BAD: UPSTREAM_BAD,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS
};
