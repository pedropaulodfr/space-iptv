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
const flags = { json: false, spawn: false, url: 'http://127.0.0.1:8095', proxyUrl: '' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') flags.json = true;
  else if (a === '--spawn') flags.spawn = true;
  else if (a === '--url') flags.url = argv[++i] || '';
  else if (a === '--proxy-url') flags.proxyUrl = argv[++i] || '';
  else if (a === '--help' || a === '-h') {
    console.log('Uso: node web/smoke.js [--url URL] [--proxy-url URL] [--spawn] [--json]');
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
/* Main                                                                */
/* ------------------------------------------------------------------ */

(async function main() {
  let base = flags.url.replace(/\/+$/, '');
  let own = null;

  try {
    const up = !flags.spawn && await alive(base);
    if (!up) {
      own = await spawnServer([]);
      base = own.base;
    }
    console.log('Space IPTV — smoke do servidor web');
    console.log('alvo: ' + base + (own ? '  (servidor temporário próprio; será encerrado)' : '  (servidor já no ar)'));
    console.log('proxy esperado: desligado' + (flags.proxyUrl ? ' + servidor extra com --proxy' : ''));
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
    } else {
      const pbase = 'http://127.0.0.1:8094';
      if (await alive(pbase)) {
        const ping = await request(pbase, '/__proxy/ping');
        let pd = null;
        try { pd = JSON.parse(ping.body); } catch (e) { pd = null; }
        if (pd && pd.ok === true) {
          group('proxy 8094 (detectado)');
          pass('8094 está no ar com proxy ligado');
          await testProxyOn(pbase);
        }
      } else {
        group('proxy 8094 (detectado)');
        skip('8094 com --proxy', 'não está no ar; casos de proxy ligado não executados');
      }
    }
  } catch (e) {
    fail('execução', e && e.message ? e.message : String(e));
  } finally {
    stopServers();
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
