/* Testes unitários de `src/main/media-proxy.js` contra o mock provider local.
 * Cobre: Range/206, reescrita de playlist, allowlist, recusa de esquema/host,
 * recursão, repasse de 404/403, sem Cookie no upstream e funções puras.
 * Contrato: CONTRACTS.md §2.2 (downloads/proxy de mídia).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const util = require('../helpers/util');
const { startMockProvider } = require('../helpers/mock-provider');
const proxyMod = require(util.desktopPath('src', 'main', 'media-proxy.js'));

const { createMediaProxy } = proxyMod;

/** Sobe um servidor local que só chama o handler do proxy. */
async function proxyHarness(t, opts) {
  const mock = await startMockProvider();
  t.after(() => mock.close());
  const local = await util.listen((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      if (!res.headersSent) { res.writeHead(500); res.end('erro no teste: ' + (e && e.message)); }
    });
  });
  t.after(() => local.close());
  const handler = createMediaProxy(Object.assign({
    origin: local.url,
    isHostAllowed: (host) => host === '127.0.0.1' || host === 'localhost',
    fetchImpl: fetch
  }, opts || {}));
  return { mock: mock, local: local, url: local.url, proxyUrl: (target) => local.url + '/media-proxy?url=' + encodeURIComponent(target) };
}

test('MP4 sem Range: 200, bytes idênticos e nenhum Cookie vai ao upstream', async (t) => {
  const h = await proxyHarness(t);
  const res = await util.request(h.proxyUrl(h.mock.baseUrl + '/movie.mp4'), {
    headers: { cookie: 'space_session=segredo-do-usuario', referer: 'http://127.0.0.1/' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.body.length, h.mock.assets.mp4.length);
  assert.equal(Buffer.compare(res.body, h.mock.assets.mp4), 0);

  const rec = h.mock.requestsFor('/movie.mp4')[0];
  assert.ok(rec, 'upstream recebeu a requisição');
  assert.equal(rec.headers.cookie, undefined, 'Cookie NUNCA é repassado ao provedor de mídia');
  assert.equal(rec.headers.referer, undefined, 'Referer não é repassado');
});

test('Range é repassado e a resposta 206 preserva Content-Range', async (t) => {
  const h = await proxyHarness(t);
  const total = h.mock.assets.mp4.length;
  const res = await util.request(h.proxyUrl(h.mock.baseUrl + '/movie.mp4'), {
    headers: { range: 'bytes=100-199' }
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], 'bytes 100-199/' + total);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.body.length, 100);
  assert.equal(Buffer.compare(res.body, h.mock.assets.mp4.subarray(100, 200)), 0);
  const rec = h.mock.requestsFor('/movie.mp4')[0];
  assert.equal(rec.headers.range, 'bytes=100-199');
});

test('playlist HLS é reescrita para URLs absolutas do proxy local', async (t) => {
  const h = await proxyHarness(t);
  const target = h.mock.baseUrl + '/hls/v1080/index.m3u8';
  const res = await util.request(h.proxyUrl(target));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /mpegurl/);
  const body = res.text;

  assert.ok(body.indexOf('#EXTM3U') >= 0, 'conteúdo de playlist');
  assert.ok(!/(^|\n)seg0\.ts/.test(body), 'segmento relativo não pode sobrar cru');
  assert.ok(body.indexOf(h.url + '/media-proxy?url=') >= 0, 'linhas usam o proxy local absoluto');
  assert.ok(body.indexOf(encodeURIComponent(h.mock.baseUrl + '/hls/v1080/seg0.ts')) >= 0, 'segmento apontado');
  assert.ok(body.indexOf(encodeURIComponent(h.mock.baseUrl + '/hls/v1080/init.mp4')) >= 0, 'init map apontado');
  // o upstream recebeu a playlist e não foi pedido nenhum segmento ainda
  assert.equal(h.mock.requestsFor('/hls/v1080/seg0.ts').length, 0);
});

test('allowlist: host fora da lista recebe 403 sem tocar no upstream', async (t) => {
  const h = await proxyHarness(t, { isHostAllowed: () => false });
  const res = await util.request(h.proxyUrl(h.mock.baseUrl + '/movie.mp4'));
  assert.equal(res.status, 403);
  assert.equal(h.mock.records.length, 0, 'nada foi requisitado ao provedor');
});

test('recusa esquemas não http(s) e URLs com credenciais embutidas', async (t) => {
  const h = await proxyHarness(t);
  const file = await util.request(h.url + '/media-proxy?url=' + encodeURIComponent('file:///C:/Windows/win.ini'));
  assert.equal(file.status, 400);
  const ftp = await util.request(h.url + '/media-proxy?url=' + encodeURIComponent('ftp://example.com/x.mp4'));
  assert.equal(ftp.status, 400);
  const creds = await util.request(h.proxyUrl('http://usuario:senha@127.0.0.1:' + h.mock.port + '/movie.mp4'));
  assert.equal(creds.status, 400);
  assert.equal(h.mock.records.length, 0);
});

test('recusa recursão no próprio proxy (loop)', async (t) => {
  const h = await proxyHarness(t);
  const loop = h.url + '/media-proxy?url=' + encodeURIComponent(h.url + '/media-proxy?url=' + encodeURIComponent(h.mock.baseUrl + '/movie.mp4'));
  const res = await util.request(loop);
  assert.equal(res.status, 400);
  assert.equal(h.mock.records.length, 0);
});

test('erros do upstream são repassados (404/403) com segurança', async (t) => {
  const h = await proxyHarness(t);
  const notFound = await util.request(h.proxyUrl(h.mock.baseUrl + '/missing.mp4'));
  assert.equal(notFound.status, 404);
  const forbidden = await util.request(h.proxyUrl(h.mock.baseUrl + '/forbidden.mp4'));
  assert.equal(forbidden.status, 403);
});

test('redirecionamento do upstream é seguido e revalidado', async (t) => {
  const h = await proxyHarness(t);
  const res = await util.request(h.proxyUrl(h.mock.baseUrl + '/redirect-to-movie'));
  assert.equal(res.status, 200);
  assert.equal(res.body.length, h.mock.assets.mp4.length);
});

test('parâmetros inválidos: url ausente, url gigante, método diferente de GET', async (t) => {
  const h = await proxyHarness(t);
  assert.equal((await util.request(h.url + '/media-proxy')).status, 400);
  assert.equal((await util.request(h.url + '/media-proxy?url=%20')).status, 400);
  assert.equal((await util.request(h.url + '/media-proxy?url=' + encodeURIComponent('http://127.0.0.1/' + 'x'.repeat(9000)))).status, 400);
  assert.equal((await util.request(h.proxyUrl(h.mock.baseUrl + '/movie.mp4'), { method: 'POST' })).status, 405);
});

test('pingPayload e utilidades de playlist', () => {
  const ping = proxyMod.pingPayload(['cdn.example.com', 'outro.example.com']);
  assert.equal(ping.ok, true);
  assert.equal(ping.proxy, 'local');
  assert.equal(typeof ping.version, 'string');
  assert.deepEqual(ping.hosts, ['cdn.example.com', 'outro.example.com']);
  assert.deepEqual(proxyMod.pingPayload(null).hosts, []);

  assert.equal(proxyMod.looksLikePlaylistUrl('https://x.com/a/index.m3u8?k=1'), true);
  assert.equal(proxyMod.looksLikePlaylistUrl('https://x.com/a/video.mp4'), false);
  assert.equal(proxyMod.looksLikePlaylistUrl('não é url'), false);
  assert.equal(proxyMod.bufferLooksLikePlaylist(Buffer.from('#EXTM3U\n#EXT-X-VERSION:3')), true);
  assert.equal(proxyMod.bufferLooksLikePlaylist(Buffer.from('\uFEFF\n #EXTM3U\n')), true);
  assert.equal(proxyMod.bufferLooksLikePlaylist(Buffer.from('<html>')), false);
  assert.equal(proxyMod.bufferLooksLikePlaylist(Buffer.alloc(0)), false);
});

test('rewritePlaylist: relativas viram absolutas, URIs de chave também', () => {
  const base = 'https://cdn.example.com/hls/a/index.m3u8';
  const proxyBase = 'http://127.0.0.1:41000';
  const src = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXT-X-MAP:URI=\'/init.mp4\'',
    'seg0.ts',
    'https://outro.example.com/seg1.ts?token=abc',
    'data:text/plain;base64,AAAA',
    ''
  ].join('\n');
  const out = proxyMod.rewritePlaylist(src, base, proxyBase);
  const lines = out.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines[1], '#EXT-X-KEY:METHOD=AES-128,URI="' + proxyBase + '/media-proxy?url=' + encodeURIComponent('https://cdn.example.com/hls/a/key.bin') + '"');
  assert.equal(lines[2], '#EXT-X-MAP:URI="' + proxyBase + '/media-proxy?url=' + encodeURIComponent('https://cdn.example.com/init.mp4') + '"');
  assert.equal(lines[3], proxyBase + '/media-proxy?url=' + encodeURIComponent('https://cdn.example.com/hls/a/seg0.ts'));
  assert.ok(lines[4].indexOf(proxyBase + '/media-proxy?url=') === 0, 'absoluta também passa pelo proxy');
  assert.equal(lines[5], 'data:text/plain;base64,AAAA', 'esquema não http(s) mantém a linha');
});

test('proxyUri/redactTarget/safeDecode', () => {
  assert.equal(proxyMod.proxyUri('a.ts', 'http://x/y/index.m3u8', 'http://127.0.0.1:1'), 'http://127.0.0.1:1/media-proxy?url=' + encodeURIComponent('http://x/y/a.ts'));
  assert.equal(proxyMod.proxyUri('file:///etc/passwd', 'http://x/', 'http://127.0.0.1:1'), null);
  assert.equal(proxyMod.proxyUri('', 'http://x/', 'http://127.0.0.1:1'), null);
  const red = proxyMod.redactTarget('https://user:senha@cdn.example.com/a/b.ts?token=abc');
  assert.equal(red, 'https://cdn.example.com/...');
  assert.ok(red.indexOf('senha') < 0 && red.indexOf('token') < 0);
  assert.equal(proxyMod.redactTarget('xx'), '(url inválida)');
  assert.equal(proxyMod.safeDecode('%41'), 'A');
  assert.equal(proxyMod.safeDecode('%zz'), null);
});

test('upstreamHeaders nunca inclui Cookie/Authorization/Referer', () => {
  const h = proxyMod.upstreamHeaders({
    headers: {
      accept: 'video/*',
      range: 'bytes=0-1',
      cookie: 'a=b',
      authorization: 'Bearer x',
      referer: 'http://evil/',
      host: 'evil'
    }
  });
  assert.equal(h.accept, 'video/*');
  assert.equal(h.range, 'bytes=0-1');
  assert.equal(h['accept-encoding'], 'identity');
  for (const key of ['cookie', 'authorization', 'referer', 'host']) {
    assert.equal(Object.prototype.hasOwnProperty.call(h, key), false, key + ' não pode ir ao upstream');
  }
});

test('passThroughHeaders: no-store, nosniff, mantém Content-Range/Type', () => {
  const fake = {
    headers: {
      get(name) {
        const map = {
          'content-type': 'video/mp4',
          'content-length': '100',
          'content-range': 'bytes 0-99/1000',
          'accept-ranges': 'bytes'
        };
        return map[String(name).toLowerCase()] || null;
      }
    }
  };
  const h = proxyMod.passThroughHeaders(fake);
  assert.equal(h['Cache-Control'], 'no-store');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['Content-Type'], 'video/mp4');
  assert.equal(h['Content-Length'], '100');
  assert.equal(h['Content-Range'], 'bytes 0-99/1000');
  assert.equal(h['Accept-Ranges'], 'bytes');
});

test('cliente que aborta no meio não derruba o servidor', async (t) => {
  const h = await proxyHarness(t);
  const http = require('http');
  const u = new URL(h.proxyUrl(h.mock.baseUrl + '/slow'));
  await new Promise((resolve) => {
    const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => resolve());
    setTimeout(() => { try { req.destroy(); } catch (e) { /* ignore */ } resolve(); }, 700);
  });
  // servidor continua respondendo normalmente depois do aborto
  const ok = await util.request(h.proxyUrl(h.mock.baseUrl + '/movie.mp4'));
  assert.equal(ok.status, 200);
});
