/* Testes de integração do servidor interno (`src/main/server.js`) + proxy `/api`
 * (`src/main/api-proxy.js`) contra o mock provider local.
 *
 * Cobre contrato §2.2: Host loopback obrigatório, `/api/admin/*` 403 antes do
 * proxy, reescrita de Origin/Referer, passagem de Cookie, remoção de Domain/Secure
 * do Set-Cookie, 502 sem upstream, traversal/estático, sessão em memória,
 * allowlist de hosts, `/_hosts` e `/_epg/source` (sem rede externa).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const util = require('../helpers/util');
const { startMockProvider } = require('../helpers/mock-provider');
const serverMod = require(util.desktopPath('src', 'main', 'server.js'));
const { createServer, normalizeHost, isLoopbackName } = serverMod;

/** Monta um renderer mínimo em pasta temporária. */
function makeRenderer(t) {
  const dir = util.makeTmp(t, 'renderer-int');
  fs.mkdirSync(path.join(dir, 'tv', 'css'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'web', 'js'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Space IPTV</title><p>shell</p>');
  fs.writeFileSync(path.join(dir, 'login.html'), '<!doctype html><title>Entrar</title>');
  fs.writeFileSync(path.join(dir, 'tv', 'css', 'design-system.css'), ':root{--electricBlue:#00b3ff}');
  fs.writeFileSync(path.join(dir, 'web', 'js', 'shell.js'), 'window.App=window.App||{};');
  fs.writeFileSync(path.join(dir, 'segredo.txt'), 'NUNCA SERVIR ESTE ARQUIVO');
  return dir;
}

/**
 * Sobe o servidor interno apontando para o mock.
 * `opts.apiOrigin` permite apontar para uma porta fechada (teste de 502).
 */
async function startDesktop(t, opts) {
  const o = opts || {};
  const mock = o.mock || await startMockProvider({ api: true });
  let closeMock = !o.mock;
  if (closeMock) t.after(() => mock.close());
  const renderer = o.renderer || makeRenderer(t);
  const apiOrigin = o.apiOrigin || mock.baseUrl;
  const authChanges = [];
  let started = null;
  const internals = {};

  const cfg = {
    effectiveApiOrigin: () => apiOrigin,
    get internalPort() { return o.internalPort || 0; }
  };

  const mediaProxyModule = {
    createHandlers: ({ isHostAllowed }) => ({
      mediaProxy: internals.createMediaProxy({
        origin: started ? started.url : '',
        isHostAllowed
      })
    })
  };

  const server = createServer({
    config: cfg,
    getRendererDir: () => renderer,
    version: '1.0.0-test',
    env: {},
    /* explicitamente null: não deixa o require('./downloads') interferir no teste */
    downloadsModule: null,
    mediaProxyModule: mediaProxyModule,
    onAuthChange: (value, reason) => authChanges.push({ value, reason }),
    log: () => {}
  });
  internals.createMediaProxy = require(util.desktopPath('src', 'main', 'media-proxy.js')).createMediaProxy;

  started = await server.start();
  t.after(() => server.stop());
  return {
    mock: mock,
    renderer: renderer,
    server: server,
    url: started.url,
    port: started.port,
    fallback: started.fallback,
    authChanges: authChanges
  };
}

function get(h, pathname, headers) {
  return util.request(h.url + pathname, { headers: headers });
}

/* -------------------------------------------------------------------------- */
/* Ciclo de vida / Host                                                       */
/* -------------------------------------------------------------------------- */

test('sobe em 127.0.0.1 com porta efêmera e estado limpo', async (t) => {
  const h = await startDesktop(t);
  assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(h.port, Number(new URL(h.url).port));
  assert.equal(h.server.isAuthenticated(), false);
  assert.equal(h.fallback, false);
});

test('Host header não-loopback ou porta errada => 400 sem servir nada', async (t) => {
  const h = await startDesktop(t);
  const evil = await get(h, '/', { host: 'evil.example.com:' + h.port });
  assert.equal(evil.status, 400);
  assert.equal(evil.json().error, 'bad_host');

  const wrongPort = await get(h, '/', { host: '127.0.0.1:1' });
  assert.equal(wrongPort.status, 400);

  const rebind = await get(h, '/', { host: 'localhost.localdomain:' + h.port });
  assert.equal(rebind.status, 400);

  assert.equal((await get(h, '/', { host: '127.0.0.1:' + h.port })).status, 200);
  assert.equal((await get(h, '/', { host: 'localhost:' + h.port })).status, 200);
});

/* -------------------------------------------------------------------------- */
/* Proxy /api                                                                 */
/* -------------------------------------------------------------------------- */

test('/api/admin/* => 403 imediato, sem tocar no backend', async (t) => {
  const h = await startDesktop(t);
  for (const p of ['/api/admin', '/api/admin/users', '/api/admin/users/1?x=1']) {
    const res = await get(h, p);
    assert.equal(res.status, 403, p);
    assert.equal(res.json().error, 'forbidden');
  }
  assert.equal(h.mock.requestsFor('/api/admin/users').length, 0, 'upstream não recebeu nada');
});

test('proxy reescreve Origin/Referer/Host, passa Cookie e marca same-origin', async (t) => {
  const h = await startDesktop(t);
  const res = await get(h, '/api/echo?x=1', {
    origin: 'http://site-malicioso.example',
    referer: 'http://site-malicioso.example/pagina',
    cookie: 'space_session=abc123',
    'sec-fetch-site': 'cross-site'
  });
  assert.equal(res.status, 200);
  const echo = res.json();
  assert.equal(echo.pathname, '/api/echo');
  assert.equal(echo.query.x, '1');
  assert.equal(echo.headers.host, '127.0.0.1:' + h.mock.port);
  assert.equal(echo.headers.origin, h.mock.baseUrl, 'Origin reescrito para o backend');
  assert.equal(echo.headers.referer, h.mock.baseUrl + '/');
  assert.equal(echo.headers['sec-fetch-site'], 'same-origin');
  assert.equal(echo.headers.cookie, 'space_session=abc123', 'Cookie do app é repassado');

  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('Set-Cookie do backend: remove Domain e Secure, preserva HttpOnly/SameSite', async (t) => {
  const h = await startDesktop(t);
  const res = await get(h, '/api/auth/session');
  assert.equal(res.status, 200);
  const cookies = res.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length >= 1);
  for (const cookie of cookies) {
    assert.doesNotMatch(cookie, /domain=/i, 'Domain removido (loopback HTTP): ' + cookie);
    assert.doesNotMatch(cookie, /;\s*secure\b/i, 'Secure removido: ' + cookie);
  }
  const session = cookies.find((c) => c.indexOf('space_session=') === 0);
  assert.ok(session);
  assert.match(session, /HttpOnly/i);
  assert.match(session, /SameSite=Lax/i);
});

test('sessão em memória: login liga, logout desliga, 401 desliga', async (t) => {
  const h = await startDesktop(t);

  let ping = await get(h, '/media-proxy/ping');
  assert.equal(ping.status, 200);
  assert.equal(ping.json().ok, false, 'sem sessão o proxy não está disponível');
  assert.equal(h.server.isAuthenticated(), false);

  const login = await util.request(h.url + '/api/auth/login', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(login.status, 200);
  assert.equal(h.server.isAuthenticated(), true);

  ping = await get(h, '/media-proxy/ping');
  assert.equal(ping.json().ok, true);
  assert.equal(ping.json().proxy, 'local');
  assert.deepEqual(ping.json().hosts, []);

  await get(h, '/api/auth/logout');
  assert.equal(h.server.isAuthenticated(), false, 'logout desliga');

  // login de novo e 401 da API derruba a sessão
  await util.request(h.url + '/api/auth/login', { method: 'POST', body: '{}' });
  assert.equal(h.server.isAuthenticated(), true);
  const protectedRes = await get(h, '/api/protected');
  assert.equal(protectedRes.status, 401);
  assert.equal(h.server.isAuthenticated(), false, '401 derruba a sessão');
});

test('sem upstream disponível => 502 claro', async (t) => {
  const closed = await util.freePort();
  const h = await startDesktop(t, { apiOrigin: 'http://127.0.0.1:' + closed });
  const res = await get(h, '/api/echo');
  assert.equal(res.status, 502);
  const body = res.json();
  assert.ok(body.error, 'payload de erro');
  assert.match(JSON.stringify(body), /upstream|indispon|conex/i);
});

test('/api/status 500 do upstream é repassado sem quebrar', async (t) => {
  const h = await startDesktop(t);
  const res = await get(h, '/api/error');
  assert.equal(res.status, 500);
  assert.equal(res.json().error, 'mock_error');
});

/* -------------------------------------------------------------------------- */
/* Estático / traversal                                                       */
/* -------------------------------------------------------------------------- */

test('estático: index, css, js e cabeçalhos de segurança', async (t) => {
  const h = await startDesktop(t);
  const index = await get(h, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.equal(index.headers['cache-control'], 'no-store');
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['x-frame-options'], 'DENY');
  assert.match(index.text, /Space IPTV/);

  const css = await get(h, '/tv/css/design-system.css');
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);

  const js = await get(h, '/web/js/shell.js');
  assert.equal(js.status, 200);
  assert.match(js.headers['content-type'], /javascript/);

  const login = await get(h, '/login.html');
  assert.equal(login.status, 200);

  const head = await util.request(h.url + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

test('traversal/dotfiles/arquivos fora da whitelist não são servidos', async (t) => {
  const h = await startDesktop(t);
  for (const p of [
    '/%2e%2e/package.json',
    '/%2e%2e/%2e%2e/package.json',
    '/js/../../package.json',
    '/js/..%2f..%2fpackage.json',
    '/../package.json',
    '/segredo.txt',
    '/package.json',
    '/js/.oculto.js',
    '/js/'
  ]) {
    const res = await get(h, p);
    assert.ok(res.status === 404 || res.status === 400, p + ' -> ' + res.status);
    assert.ok(res.text.indexOf('NUNCA SERVIR') < 0, 'não vazou conteúdo: ' + p);
    assert.ok(res.text.indexOf('"name": "space-iptv-desktop"') < 0, 'não vazou package.json: ' + p);
  }
});

/* -------------------------------------------------------------------------- */
/* Allowlist de hosts e /_hosts                                              */
/* -------------------------------------------------------------------------- */

test('registerMediaHosts: dedupe, rejeita loopback e host inválido', async (t) => {
  const h = await startDesktop(t);
  const hosts = h.server.registerMediaHosts([
    'cdn.example.com', 'CDN.example.com', 'localhost', '127.0.0.1', '10.0.0.5',
    'http://midia.example.com:8080/x', '', null, 'a b'
  ]);
  /* Nota (risco documentado no TEST-REPORT): IP privado/LAN (10.0.0.5) é aceito
     pela allowlist atual — só loopback é negado. Ver "Riscos conhecidos". */
  assert.deepEqual(hosts, ['cdn.example.com', '10.0.0.5', 'midia.example.com']);
  assert.equal(h.server.isMediaHostAllowed('cdn.example.com'), true);
  assert.equal(h.server.isMediaHostAllowed('sub.cdn.example.com'), false, 'subdomínio não é automático');
  assert.equal(h.server.isMediaHostAllowed('127.0.0.1'), false, 'loopback nunca permitido');
  assert.equal(h.server.isMediaHostAllowed('localhost'), false);
});

test('/_hosts exige sessão e POST, valida o corpo e registra', async (t) => {
  const h = await startDesktop(t);
  const unauth = await util.request(h.url + '/_hosts', { method: 'POST', body: '{"hosts":["cdn.example.com"]}' });
  assert.equal(unauth.status, 401);

  await util.request(h.url + '/api/auth/login', { method: 'POST', body: '{}' });

  const badMethod = await util.request(h.url + '/_hosts', { method: 'GET' });
  assert.equal(badMethod.status, 405);

  const badBody = await util.request(h.url + '/_hosts', { method: 'POST', body: 'não é json' });
  assert.equal(badBody.status, 400);

  const ok = await util.request(h.url + '/_hosts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hosts: ['cdn.example.com', 'localhost', 'cdn.example.com'] })
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json().hosts, ['cdn.example.com']);
});

test('normalizeHost/isLoopbackName exportados e usados pela allowlist', () => {
  assert.equal(normalizeHost('https://cdn.example.com:8443/a/b'), 'cdn.example.com');
  assert.equal(normalizeHost('CDN.Example.COM'), 'cdn.example.com');
  assert.equal(normalizeHost('não é host'), '');
  assert.equal(isLoopbackName('localhost'), true);
  assert.equal(isLoopbackName('127.0.0.1'), true);
  assert.equal(isLoopbackName('127.5.6.7'), true);
  assert.equal(isLoopbackName('cdn.example.com'), false);
});

/* -------------------------------------------------------------------------- */
/* Proxy de mídia / EPG (sessão + allowlist)                                  */
/* -------------------------------------------------------------------------- */

test('/media-proxy: 401 sem sessão, 405 em método errado, 400/403 com URL inválida', async (t) => {
  const h = await startDesktop(t);
  const target = encodeURIComponent(h.mock.baseUrl + '/movie.mp4');

  assert.equal((await get(h, '/media-proxy?url=' + target)).status, 401);

  await util.request(h.url + '/api/auth/login', { method: 'POST', body: '{}' });

  assert.equal((await util.request(h.url + '/media-proxy?url=' + target, { method: 'POST' })).status, 405);
  assert.equal((await get(h, '/media-proxy')).status, 400, 'url obrigatória');
  assert.equal((await get(h, '/media-proxy?url=' + encodeURIComponent('file:///C:/Windows/win.ini'))).status, 400);
  const loopback = await get(h, '/media-proxy?url=' + target);
  assert.equal(loopback.status, 403, 'loopback do próprio app é negado pela allowlist');
});

test('/_epg/source: 401 sem sessão, valida URL e nega host fora da allowlist', async (t) => {
  const h = await startDesktop(t);
  const target = encodeURIComponent(h.mock.baseUrl + '/xmltv.xml');
  assert.equal((await get(h, '/_epg/source?url=' + target)).status, 401);

  await util.request(h.url + '/api/auth/login', { method: 'POST', body: '{}' });

  assert.equal((await get(h, '/_epg/source')).status, 400);
  assert.equal((await get(h, '/_epg/source?url=' + encodeURIComponent('ftp://x/y'))).status, 400);
  assert.equal((await get(h, '/_epg/source?url=' + encodeURIComponent('http://user:senha@x/y'))).status, 400);
  const loopback = await get(h, '/_epg/source?url=' + target);
  assert.equal(loopback.status, 403, 'host loopback negado');
});

/* -------------------------------------------------------------------------- */
/* Porta ocupada                                                              */
/* -------------------------------------------------------------------------- */

test('porta configurada ocupada => fallback para porta efêmera e aviso', async (t) => {
  const blocker = await util.listen((req, res) => res.end('ocupado'));
  t.after(() => blocker.close());
  const h = await startDesktop(t, { internalPort: blocker.port });
  assert.equal(h.fallback, true);
  assert.notEqual(h.port, blocker.port);
  assert.match(h.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await get(h, '/')).status, 200, 'servidor segue funcional no fallback');
});

test('stop() fecha o servidor (conexão recusada depois)', async (t) => {
  const mock = await startMockProvider({ api: true });
  t.after(() => mock.close());
  const renderer = makeRenderer(t);
  const server = createServer({
    config: { effectiveApiOrigin: () => mock.baseUrl, get internalPort() { return 0; } },
    getRendererDir: () => renderer,
    version: '1.0.0-test',
    env: {},
    downloadsModule: null
  });
  const started = await server.start();
  assert.equal((await util.request(started.url + '/')).status, 200);
  await server.stop();
  await assert.rejects(util.request(started.url + '/'), /ECONNREFUSED|ECONNRESET|socket hang up/);
});
