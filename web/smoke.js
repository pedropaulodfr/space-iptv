/* web/smoke.js — teste de fumaça do servidor web do Space IPTV (F5).
 *
 * ZERO dependências: usa só módulos nativos do Node (http, net, fs, path, child_process).
 * Não edita o produto, não instala nada e NÃO deixa servidor rodando: se precisar subir um
 * servidor próprio, ele é morto no fim (inclusive em Ctrl+C/erro).
 *
 * O que verifica:
 *   - GET / (200, HTML com o palco), HEAD / (sem corpo, Content-Length correto);
 *   - 302 de /web/index.html -> /; 404 de rota/arquivo inexistente; 405 de método não permitido;
 *   - MIME de .css/.js/.woff2/.m3u8/.html + cabeçalhos nosniff/no-store;
 *   - traversal (../, %2e%2e, duplo-encoding, backslash, %00, dot segment) nunca vaza arquivo
 *     de fora de web/ ou tv/ — tem que responder 400;
 *   - /__proxy/ping sempre 200 JSON: {ok:false} sem --proxy, {ok:true} com --proxy;
 *   - /__proxy?url=... desligado -> 404; ligado -> repassa a origem (opcional, com --proxy-url);
 *   - raiz que não é imagem (ex.: /package.json) -> 404.
 *
 * Uso:
 *   node web/smoke.js
 *       Testa http://127.0.0.1:8095 (servidor que já está no ar). Se ninguém responder,
 *       sobe um servidor próprio em porta livre e o encerra no fim.
 *   node web/smoke.js --url http://127.0.0.1:8095
 *   node web/smoke.js --proxy-url http://127.0.0.1:8094
 *       Testa também o modo --proxy: ping ok:true e repasse real via /__proxy?url=...
 *       (se 8094 não estiver no ar, esses casos aparecem como SKIP; nada falha).
 *   node web/smoke.js --spawn
 *       Força usar um servidor temporário próprio (proxy desligado) em porta livre.
 *   node web/smoke.js --json
 *       Imprime o resultado em JSON no fim (útil para CI/relatório).
 *
 * Saída: lista PASS/FAIL/SKIP e resumo. Código de saída 1 se algum caso falhar.
 * Os casos marcados SKIP nunca foram executados — o relatório não deve contá-los como prova.
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flags = { json: false, spawn: false, url: '', proxyUrl: '', staticOnly: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') flags.json = true;
  else if (a === '--spawn') flags.spawn = true;
  else if (a === '--static') flags.staticOnly = true;
  else if (a === '--url') flags.url = argv[++i] || '';
  else if (a === '--proxy-url') flags.proxyUrl = argv[++i] || '';
  else if (a === '--help' || a === '-h') {
    console.log('Uso: node web/smoke.js [--url URL] [--static] [--spawn] [--json] [--proxy-url URL]');
    console.log('');
    console.log('  (padrão)   testa o contrato com login: / sem cookie = 302, /login.html = 200,');
    console.log('             /api/* sem cookie = 401. Sobe as Pages Functions reais + o Postgres do Neon.');
    console.log('  --url URL  testa esse servidor (precisa ter as Functions)');
    console.log('  --static   testa só o servidor estático de assets (node web/server.js),');
    console.log('             com MIME, traversal e /__proxy — sem login');
    process.exit(0);
  } else {
    console.error('Argumento desconhecido: ' + a);
    process.exit(2);
  }
}

const results = [];
let currentGroup = '';

function group(name) { currentGroup = name; }
function pass(name, detail) { results.push({ group: currentGroup, name, status: 'pass', detail: detail || '' }); }
function fail(name, detail) { results.push({ group: currentGroup, name, status: 'fail', detail: detail || '' }); }
function skip(name, detail) { results.push({ group: currentGroup, name, status: 'skip', detail: detail || '' }); }

function fmt(r) {
  const tag = r.status === 'pass' ? 'PASS' : (r.status === 'fail' ? 'FAIL' : 'SKIP');
  return tag + '  ' + r.name + (r.detail ? '  [' + r.detail + ']' : '');
}

/* ------------------------------------------------------------------ */
/* HTTP client (path enviado cru, sem normalização do cliente)         */
/* ------------------------------------------------------------------ */

function request(base, rawPath, opts) {
  opts = opts || {};
  const u = new URL(base);
  return new Promise(function (resolve, reject) {
    const req = http.request({
      host: u.hostname,
      port: Number(u.port || 80),
      method: opts.method || 'GET',
      path: rawPath,                 /* cru: o teste de traversal depende disso */
      headers: Object.assign({ Host: u.host }, opts.headers || {}),
      timeout: opts.timeout || 6000
    }, function (res) {
      const chunks = [];
      let size = 0;
      res.on('data', function (c) { chunks.push(c); size += c.length; });
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          bytes: size
        });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/* GET em socket cru: garante que `../` chegue literal no servidor mesmo se algum
   cliente/cliente HTTP normalizar. Usado só nos casos de traversal. */
function rawGet(base, rawPath, timeoutMs) {
  const u = new URL(base);
  return new Promise(function (resolve, reject) {
    const sock = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    let buf = '';
    let done = false;
    const timer = setTimeout(function () { finish(new Error('timeout')); }, timeoutMs || 6000);
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (e) { /* ignore */ }
      if (err) return reject(err);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      resolve({ status: m ? Number(m[1]) : 0, raw: buf });
    }
    sock.setEncoding('utf8');
    sock.on('connect', function () {
      sock.write('GET ' + rawPath + ' HTTP/1.1\r\nHost: ' + u.host + '\r\nConnection: close\r\n\r\n');
    });
    sock.on('data', function (c) { buf += c; if (buf.length > 65536) finish(); });
    sock.on('end', function () { finish(); });
    sock.on('error', function (e) { finish(e); });
  });
}

async function alive(base) {
  try {
    const r = await request(base, '/__proxy/ping', { timeout: 900 });
    return r.status === 200;
  } catch (e) {
    return false;
  }
}

function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', function () {
      const p = s.address().port;
      s.close(function () { resolve(p); });
    });
    s.on('error', reject);
  });
}

const servers = [];
async function spawnServer(extraArgs) {
  const port = await freePort();
  const args = [path.join(ROOT, 'web', 'server.js'), '--port', String(port)].concat(extraArgs || []);
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  servers.push(child);
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 80; i++) {
    if (await alive(base)) return { base, child };
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  throw new Error('servidor temporário não respondeu na porta ' + port);
}

function stopServers() {
  while (servers.length) {
    const c = servers.pop();
    try { c.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Casos                                                               */
/* ------------------------------------------------------------------ */

function header(r, name) { return r.headers[String(name || '').toLowerCase()] || ''; }

async function testStatic(base) {
  group('estático');

  const home = await request(base, '/');
  if (home.status === 200) pass('GET / responde 200'); else fail('GET / responde 200', 'veio ' + home.status);
  if (/text\/html/.test(header(home, 'content-type'))) pass('GET / é text/html', header(home, 'content-type'));
  else fail('GET / é text/html', header(home, 'content-type') || 'sem content-type');
  if (/\bcharset=utf-8\b/i.test(header(home, 'content-type'))) pass('HTML declara charset=utf-8');
  else fail('HTML declara charset=utf-8', header(home, 'content-type'));
  if (header(home, 'x-content-type-options') === 'nosniff') pass('HTML tem X-Content-Type-Options: nosniff');
  else fail('HTML tem X-Content-Type-Options: nosniff', header(home, 'x-content-type-options') || 'ausente');
  if (/no-store/.test(header(home, 'cache-control'))) pass('HTML é Cache-Control: no-store');
  else fail('HTML é Cache-Control: no-store', header(home, 'cache-control') || 'ausente');
  if (home.body.indexOf('id="stage"') >= 0) pass('HTML contém o palco (#stage)');
  else fail('HTML contém o palco (#stage)');
  if (home.body.indexOf('web/js/shell.js') >= 0 && home.body.indexOf('web/js/player.js') >= 0) {
    pass('HTML carrega shell.js e player.js');
  } else {
    fail('HTML carrega shell.js e player.js');
  }

  const head = await request(base, '/', { method: 'HEAD' });
  if (head.status === 200 && head.bytes === 0) pass('HEAD / responde 200 sem corpo');
  else fail('HEAD / responde 200 sem corpo', 'status ' + head.status + ', bytes ' + head.bytes);
  const len = Number(header(head, 'content-length'));
  if (len > 0) pass('HEAD / informa Content-Length (' + len + ' B)');
  else fail('HEAD / informa Content-Length', header(head, 'content-length') || 'ausente');

  const redirect = await request(base, '/web/index.html');
  if (redirect.status === 302) pass('/web/index.html responde 302');
  else fail('/web/index.html responde 302', 'veio ' + redirect.status);
  if (header(redirect, 'location') === '/') pass('/web/index.html redireciona para /');
  else fail('/web/index.html redireciona para /', header(redirect, 'location') || 'sem Location');

  const css = await request(base, '/web/css/web.css');
  if (css.status === 200 && /text\/css/.test(header(css, 'content-type'))) pass('CSS tem MIME text/css', header(css, 'content-type'));
  else fail('CSS tem MIME text/css', css.status + ' ' + header(css, 'content-type'));
  if (css.body.indexOf('prefers-reduced-motion') >= 0) pass('CSS servido contém prefers-reduced-motion');
  else fail('CSS servido contém prefers-reduced-motion');

  const js = await request(base, '/tv/js/core/util.js');
  if (js.status === 200 && /javascript/.test(header(js, 'content-type'))) pass('JS tem MIME text/javascript', header(js, 'content-type'));
  else fail('JS tem MIME text/javascript', js.status + ' ' + header(js, 'content-type'));
  if (js.body.indexOf('function') >= 0) pass('JS servido tem conteúdo de script');
  else fail('JS servido tem conteúdo de script');

  const vendor = await request(base, '/web/vendor/hls.min.js');
  if (vendor.status === 200 && /javascript/.test(header(vendor, 'content-type'))) {
    pass('vendor hls.min.js servido como JavaScript');
  } else {
    fail('vendor hls.min.js servido como JavaScript', vendor.status + ' ' + header(vendor, 'content-type'));
  }

  const font = await request(base, '/tv/fonts/orbitron-latin-600-normal.woff2');
  if (font.status === 200 && header(font, 'content-type') === 'font/woff2') pass('Fonte .woff2 tem MIME font/woff2');
  else fail('Fonte .woff2 tem MIME font/woff2', font.status + ' ' + header(font, 'content-type'));

  const notFound = await request(base, '/web/nao-existe-' + Date.now() + '.js');
  if (notFound.status === 404) pass('Arquivo inexistente responde 404');
  else fail('Arquivo inexistente responde 404', 'veio ' + notFound.status);
  if (notFound.body.indexOf('Não encontrado') >= 0) pass('404 tem corpo "Não encontrado."');
  else fail('404 tem corpo "Não encontrado."', JSON.stringify(notFound.body.slice(0, 60)));

  const rootFile = await request(base, '/package.json');
  if (rootFile.status === 404) pass('Raiz fora de /web e /tv responde 404');
  else fail('Raiz fora de /web e /tv responde 404', 'veio ' + rootFile.status);

  const post = await request(base, '/', { method: 'POST', body: 'x' });
  if (post.status === 405) pass('POST / responde 405');
  else fail('POST / responde 405', 'veio ' + post.status);
}

async function testTraversal(base) {
  group('traversal');
  const cases = [
    '/web/../package.json',
    '/web/../../package.json',
    '/web/%2e%2e/package.json',
    '/web/%2e%2e%2fpackage.json',
    '/web/%252e%252e%252fpackage.json',
    '/web/..%5cpackage.json',
    '/tv/%2e%2e/web/server.js',
    '/tv/..%2fweb%2fserver.js',
    '/web/css/%00.css',
    '/%2e%2e/%2e%2e/windows/win.ini',
    '/web/assets/./../../package.json'
  ];
  for (const p of cases) {
    try {
      const r = await rawGet(base, p);
      if (r.status === 400 || r.status === 404) {
        pass('bloqueado: ' + p, 'status ' + r.status);
      } else if (r.status === 200 && /"name"|"version"|require\(/.test(r.raw)) {
        fail('VAZOU arquivo via ' + p, 'status 200');
      } else {
        fail('traversal com status inesperado: ' + p, 'status ' + r.status);
      }
    } catch (e) {
      fail('traversal sem resposta: ' + p, e.message);
    }
  }
}

async function testPing(base, expectProxy) {
  group(expectProxy ? 'proxy (ligado)' : 'proxy (desligado)');
  const r = await request(base, '/__proxy/ping');
  if (r.status === 200) pass('/__proxy/ping responde 200'); else fail('/__proxy/ping responde 200', 'veio ' + r.status);
  if (/application\/json/.test(header(r, 'content-type'))) pass('/__proxy/ping é JSON', header(r, 'content-type'));
  else fail('/__proxy/ping é JSON', header(r, 'content-type') || 'sem content-type');
  let data = null;
  try { data = JSON.parse(r.body); } catch (e) { data = null; }
  if (data && typeof data.ok === 'boolean') pass('/__proxy/ping devolve {ok:boolean}');
  else fail('/__proxy/ping devolve {ok:boolean}', JSON.stringify(r.body.slice(0, 80)));
  if (expectProxy) {
    if (data && data.ok === true) pass('ping com --proxy devolve ok:true');
    else fail('ping com --proxy devolve ok:true', JSON.stringify(data));
  } else {
    if (data && data.ok === false) pass('ping sem proxy devolve ok:false');
    else fail('ping sem proxy devolve ok:false', JSON.stringify(data));
    if (data && data.proxy === 'disabled') pass('ping sem proxy informa proxy=disabled');
    else fail('ping sem proxy informa proxy=disabled', JSON.stringify(data));
  }

  const post = await request(base, '/__proxy/ping', { method: 'POST', body: 'x' });
  if (post.status === 405) pass('POST /__proxy/ping responde 405');
  else fail('POST /__proxy/ping responde 405', 'veio ' + post.status);
}

async function testProxyOff(base) {
  group('proxy (desligado)');
  const r = await request(base, '/__proxy?url=' + encodeURIComponent('http://127.0.0.1:8090/lista.m3u'));
  if (r.status === 404) pass('/__proxy sem --proxy responde 404');
  else fail('/__proxy sem --proxy responde 404', 'veio ' + r.status);
}

async function testProxyOn(base) {
  group('proxy (ligado)');
  const noUrl = await request(base, '/__proxy');
  if (noUrl.status === 400) pass('/__proxy sem url responde 400');
  else fail('/__proxy sem url responde 400', 'veio ' + noUrl.status);

  const ftp = await request(base, '/__proxy?url=' + encodeURIComponent('ftp://127.0.0.1/x'));
  if (ftp.status === 400) pass('/__proxy recusa esquema ftp (400)');
  else fail('/__proxy recusa esquema ftp (400)', 'veio ' + ftp.status);

  const m3u = await request(base, '/__proxy?url=' + encodeURIComponent('http://127.0.0.1:8090/lista.m3u'), { timeout: 12000 });
  if (m3u.status === 200) pass('/__proxy repassa lista.m3u (200)'); else fail('/__proxy repassa lista.m3u', 'veio ' + m3u.status);
  if (m3u.body.indexOf('#EXTM3U') >= 0) pass('/__proxy devolve o conteúdo da origem');
  else fail('/__proxy devolve o conteúdo da origem', JSON.stringify(m3u.body.slice(0, 80)));

  const rec = await request(base, '/__proxy?url=' + encodeURIComponent(base + '/__proxy?url=' + encodeURIComponent('http://127.0.0.1:8090/lista.m3u')));
  if (rec.status === 400) pass('/__proxy recusa recursão (400)');
  else fail('/__proxy recusa recursão (400)', 'veio ' + rec.status);
}

/* ------------------------------------------------------------------ */
/* Gate de login (o contrato novo do app)                              */
/* ------------------------------------------------------------------ */

let fixtures = null;
let runner = null;

async function startGateServer() {
  fixtures = require('../tools/db-fixtures.js');
  const { createPagesServer } = require('../tools/pages-runner.js');
  const env = fixtures.loadEnv({ AUTH_RECOVERY_ENABLED: 'false' });
  await fixtures.cleanup(env);
  await fixtures.seedUser(env, { email: 'smoke@e2e.local', password: 'senha-de-teste', name: 'Smoke', role: 'admin' });
  runner = createPagesServer({ dir: 'dist/web', env: env });
  smokeEnv = env;
  return runner.listen(0);
}

async function stopGateServer() {
  if (runner) { await runner.close(); runner = null; }
  if (fixtures && smokeEnv) {
    try { await fixtures.cleanup(smokeEnv); } catch (e) { /* ignore */ }
  }
  fixtures = null;
}

let smokeEnv = null;

/* Contrato da versão com login: / sem cookie é 302, /login.html é 200,
   assets continuam 200 e a API responde 401 em JSON. */
async function testGate(base) {
  group('gate de login');

  const home = await request(base, '/');
  if (home.status === 302) pass('/ sem cookie responde 302'); else fail('/ sem cookie responde 302', 'veio ' + home.status);
  if (header(home, 'location') === '/login.html?next=%2F') pass('Location = /login.html?next=%2F');
  else fail('Location = /login.html?next=%2F', header(home, 'location') || 'sem Location');
  if (/no-store/.test(header(home, 'cache-control'))) pass('302 tem Cache-Control: no-store');
  else fail('302 tem Cache-Control: no-store', header(home, 'cache-control') || 'ausente');

  const login = await request(base, '/login.html');
  if (login.status === 200 && /text\/html/.test(header(login, 'content-type'))) pass('/login.html é 200 text/html');
  else fail('/login.html é 200 text/html', login.status + ' ' + header(login, 'content-type'));
  if (login.body.indexOf('id="login-form"') >= 0) pass('/login.html tem o formulário');
  else fail('/login.html tem o formulário');
  if (String(header(login, 'content-security-policy')).indexOf("frame-ancestors 'none'") >= 0) {
    pass('/login.html tem CSP anti-clickjacking');
  } else {
    fail('/login.html tem CSP anti-clickjacking', header(login, 'content-security-policy') || 'ausente');
  }

  const api = await request(base, '/api/sync/pull');
  if (api.status === 401) pass('/api/sync/pull sem cookie responde 401'); else fail('/api/sync/pull sem cookie responde 401', 'veio ' + api.status);
  let apiJson = null;
  try { apiJson = JSON.parse(api.body); } catch (e) { apiJson = null; }
  if (apiJson && apiJson.error === 'unauthorized') pass('401 usa {error:"unauthorized"}');
  else fail('401 usa {error:"unauthorized"}', JSON.stringify(apiJson));

  const asset = await request(base, '/web/js/shell.js');
  if (asset.status === 200) pass('/web/js/shell.js continua 200 (asset não é gated)');
  else fail('/web/js/shell.js continua 200 (asset não é gated)', 'veio ' + asset.status);

  const loginRes = await request(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@e2e.local', password: 'senha-de-teste' })
  });
  if (loginRes.status === 200) pass('/api/auth/login com a conta de teste responde 200');
  else fail('/api/auth/login com a conta de teste responde 200', 'veio ' + loginRes.status);
  const cookies = loginRes.headers['set-cookie'] || [];
  if (cookies.length && /HttpOnly/i.test(cookies.join(';'))) pass('cookies de sessão são HttpOnly');
  else fail('cookies de sessão são HttpOnly', JSON.stringify(cookies));

  const cookieHeader = cookies.map(function (c) { return String(c).split(';')[0]; }).join('; ');
  if (cookieHeader) {
    const logged = await request(base, '/', { headers: { Cookie: cookieHeader } });
    if (logged.status === 200 && logged.body.indexOf('id="stage"') >= 0) pass('/ com cookie responde 200 e traz o palco');
    else fail('/ com cookie responde 200 e traz o palco', 'status ' + logged.status);
    if (/\bno-store\b/.test(header(logged, 'cache-control'))) pass('HTML autenticado é no-store');
    else fail('HTML autenticado é no-store', header(logged, 'cache-control') || 'ausente');
  }
}

async function testLogout(base) {
  group('gate de login');
  const loginRes = await request(base, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@e2e.local', password: 'senha-de-teste' })
  });
  const cookieHeader = (loginRes.headers['set-cookie'] || [])
    .map(function (c) { return String(c).split(';')[0]; }).join('; ');
  if (!cookieHeader) { fail('logout com sessão', 'login não devolveu cookie'); return; }
  const out = await request(base, '/api/auth/logout', { method: 'POST', headers: { Cookie: cookieHeader }, body: '{}' });
  if (out.status === 204) pass('POST /api/auth/logout responde 204'); else fail('POST /api/auth/logout responde 204', 'veio ' + out.status);
  const cleared = (out.headers['set-cookie'] || []).join(';');
  if (/sp_at=;|sp_at=;|Max-Age=0/i.test(cleared)) pass('logout apaga o cookie de sessão');
  else fail('logout apaga o cookie de sessão', cleared || 'sem Set-Cookie');
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

(async function main() {
  let base = flags.url.replace(/\/+$/, '');
  let own = null;

  try {
    if (flags.staticOnly) {
      /* modo antigo: só o servidor estático de assets (sem Functions) */
      const up = !flags.spawn && await alive(base);
      if (!up) {
        own = await spawnServer([]);
        base = own.base;
      }
      console.log('Space IPTV — smoke do servidor estático (assets, SEM login)');
      console.log('alvo: ' + base + (own ? '  (servidor temporário próprio; será encerrado)' : '  (servidor já no ar)'));
      console.log('');
      await testStatic(base);
      await testTraversal(base);
      await testPing(base, false);
      await testProxyOff(base);
      if (flags.proxyUrl) {
        const pbase = flags.proxyUrl.replace(/\/+$/, '');
        if (await alive(pbase)) {
          const ping = await request(pbase, '/__proxy/ping');
          let pd = null;
          try { pd = JSON.parse(ping.body); } catch (e) { pd = null; }
          if (pd && pd.ok === true) {
            await testPing(pbase, true);
            await testProxyOn(pbase);
          } else {
            skip('proxy-url ' + pbase, 'ping não devolveu ok:true (servidor sem --proxy?)');
          }
        } else {
          skip('proxy-url ' + pbase, 'servidor não está no ar');
        }
      }
    } else {
      /* padrão: contrato novo (login + gate), executando as Functions reais */
      if (!base) base = await startGateServer();
      console.log('Space IPTV — smoke do app com login (Pages Functions)');
      console.log('alvo: ' + base + (flags.url ? '  (servidor já no ar)' : '  (servidor temporário próprio; será encerrado)'));
      console.log('');
      await testGate(base);
      await testLogout(base);
      skip('servidor estático puro (server.js)', 'use --static para testar MIME/traversal/proxy do server.js');
    }
  } catch (e) {
    fail('execução', e && e.message ? e.message : String(e));
  } finally {
    stopServers();
    await stopGateServer();
  }

  console.log('');
  let lastGroup = '';
  for (const r of results) {
    if (r.group !== lastGroup) { console.log('== ' + r.group + ' =='); lastGroup = r.group; }
    console.log('  ' + fmt(r));
  }
  const p = results.filter(function (r) { return r.status === 'pass'; }).length;
  const f = results.filter(function (r) { return r.status === 'fail'; }).length;
  const s = results.filter(function (r) { return r.status === 'skip'; }).length;
  console.log('');
  console.log('Resumo: ' + p + ' PASS, ' + f + ' FAIL, ' + s + ' SKIP');
  if (flags.json) {
    console.log(JSON.stringify({ target: base, proxyUrl: flags.proxyUrl || null, pass: p, fail: f, skip: s, results }, null, 2));
  }
  process.exitCode = f ? 1 : 0;
})().then(function () {
  setTimeout(function () { process.exit(process.exitCode || 0); }, 100);
});
