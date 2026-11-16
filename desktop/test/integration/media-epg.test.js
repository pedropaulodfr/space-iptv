/* Integração ponta a ponta de MÍDIA e EPG pelo servidor interno de verdade.
 *
 * O servidor interno nega loopback na allowlist (proteção contra recursão), então
 * o mock é servido pelo IP da LAN desta máquina (bind 0.0.0.0) — um "provedor"
 * externo de mentira. Se não houver IP de LAN alcançável (CI/offline), o teste é
 * pulado com motivo explícito, nunca falha silenciosa.
 *
 * Cobre: /_epg/source com gzip real + parse incremental + cache simulado (TTL),
 * /media-proxy com MP4 (bytes idênticos), Range/206 e reescrita de playlist HLS.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const util = require('../helpers/util');
const { startMockProvider } = require('../helpers/mock-provider');
const { createServer } = require(util.desktopPath('src', 'main', 'server.js'));
const { createMediaProxy } = require(util.desktopPath('src', 'main', 'media-proxy.js'));
const epgParse = require(util.desktopPath('src', 'renderer', 'js', 'epg', 'epg-parse.js'));

function lanAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '';
}

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

function makeRenderer(t) {
  const dir = util.makeTmp(t, 'renderer-media');
  fs.mkdirSync(path.join(dir, 'tv', 'css'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Space IPTV</title>');
  fs.writeFileSync(path.join(dir, 'tv', 'css', 'design-system.css'), ':root{}');
  return dir;
}

/** Servidor interno com o proxy de mídia real (`createMediaProxy`) ligado. */
async function startHarness(t, opts) {
  const mock = opts.mock;
  const renderer = makeRenderer(t);
  const authChanges = [];
  let started = null;
  const apiOrigin = mock.baseUrl;

  const mediaProxyModule = {
    createHandlers: ({ isHostAllowed }) => ({
      mediaProxy: (req, res, urlParam) => createMediaProxy({ origin: started.url, isHostAllowed })(req, res, urlParam)
    })
  };

  const server = createServer({
    config: { effectiveApiOrigin: () => apiOrigin, get internalPort() { return 0; } },
    getRendererDir: () => renderer,
    version: '1.0.0-test',
    env: {},
    downloadsModule: null,
    mediaProxyModule: mediaProxyModule,
    onAuthChange: (v, r) => authChanges.push({ value: v, reason: r }),
    log: () => {}
  });
  started = await server.start();
  t.after(() => server.stop());
  return { server: server, url: started.url, mock: mock, authChanges: authChanges };
}

/* Um único mock/LAN para o arquivo inteiro (mais rápido que subir por teste). */
const LAN = lanAddress();
const LAN_BASE = LAN ? 'http://' + LAN : '';

let shared = null;
test.before(async () => {
  if (!LAN) return;
  const mock = await startMockProvider({ api: true, host: '0.0.0.0' });
  if (!(await reachable('http://' + LAN + ':' + mock.port + '/m3u'))) {
    await mock.close();
    return;
  }
  shared = { mock: mock };
});

test.after(async () => {
  if (shared) await shared.mock.close();
});

async function harness(t) {
  if (!shared) {
    t.skip('sem IP de LAN alcançável para simular provedor externo: ' + (LAN || '(nenhum)'));
    return null;
  }
  const h = await startHarness(t, { mock: shared.mock });
  await util.request(h.url + '/api/auth/login', { method: 'POST', body: '{}' });
  const registered = await util.request(h.url + '/_hosts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hosts: [LAN] })
  });
  assert.equal(registered.status, 200);
  assert.ok(registered.json().hosts.indexOf(LAN) >= 0, 'host da LAN registrado na allowlist');
  return h;
}

test('EPG fim a ponta: /_epg/source (gzip) -> parse -> cache simulado com TTL', async (t) => {
  const h = await harness(t);
  if (!h) return;

  const sourceUrl = LAN_BASE + ':' + shared.mock.port + '/xmltv.xml.gz';
  const res = await util.request(h.url + '/_epg/source?url=' + encodeURIComponent(sourceUrl));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /xml/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['content-encoding'], 'gzip', 'gzip repassado (não descomprime no servidor)');
  assert.deepEqual(res.body.subarray(0, 2), Buffer.from([0x1f, 0x8b]), 'bytes gzip reais');

  // parser incremental sobre o stream descomprimido, em chunks pequenos
  const raw = zlib.gunzipSync(res.body).toString('utf8');
  const parser = new epgParse.Parser({ defaultOffsetMin: 0 });
  for (let i = 0; i < raw.length; i += 7) parser.feed(raw.slice(i, i + 7));
  const parsed = parser.end();
  assert.equal(parsed.channels.length, 2);
  assert.equal(parsed.programmes.length, 3);
  assert.equal(parsed.channels[0].id, 'mock.one');
  assert.equal(parsed.programmes[0].t, 'Programa Mock');
  /* o mock gera XMLTV relativo ao agora (o Guia precisa cobrir a janela atual);
     comparamos com o start que o proprio mock publicou. */
  const mStart = /start="(\d{14}) \+0000"/.exec(shared.mock.assets.xmltv);
  const expectedStart = Date.UTC(+mStart[1].slice(0, 4), +mStart[1].slice(4, 6) - 1, +mStart[1].slice(6, 8),
    +mStart[1].slice(8, 10), +mStart[1].slice(10, 12), +mStart[1].slice(12, 14));
  assert.equal(parsed.programmes[0].s, expectedStart);

  // cache simulado (como o IndexedDB do renderer): chave por lista + TTL
  const cache = new Map();
  const ttlHours = 24;
  const now = 1763150000000;
  cache.set('epg.meta.mock', { fetchedAt: now, channels: parsed.channels.length, programmes: parsed.programmes.length });
  cache.set('epg.ch.mock', parsed.programmes.slice(0, 2));

  const meta = cache.get('epg.meta.mock');
  const fresh = (now + 23 * 3600 * 1000) - meta.fetchedAt < ttlHours * 3600 * 1000;
  const stale = (now + 25 * 3600 * 1000) - meta.fetchedAt >= ttlHours * 3600 * 1000;
  assert.equal(fresh, true, 'cache de 23h ainda é válido');
  assert.equal(stale, true, 'cache de 25h exige refresh');
  assert.equal(cache.get('epg.ch.mock').length, 2);
});

test('EPG: XMLTV sem gzip e conteúdo inválido do upstream', async (t) => {
  const h = await harness(t);
  if (!h) return;

  const plain = await util.request(h.url + '/_epg/source?url=' + encodeURIComponent(LAN_BASE + ':' + shared.mock.port + '/xmltv.xml'));
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  const parsed = epgParse.parse(plain.text);
  assert.equal(parsed.channels.length, 2);

  const missing = await util.request(h.url + '/_epg/source?url=' + encodeURIComponent(LAN_BASE + ':' + shared.mock.port + '/rota-inexistente.xml'));
  assert.equal(missing.status, 502, '404 do provedor de guia vira 502 amigável');
});

test('/media-proxy fim a ponta: MP4 idêntico e Range/206', async (t) => {
  const h = await harness(t);
  if (!h) return;

  const target = encodeURIComponent(LAN_BASE + ':' + shared.mock.port + '/movie.mp4');
  const full = await util.request(h.url + '/media-proxy?url=' + target);
  assert.equal(full.status, 200);
  assert.match(full.headers['content-type'], /video\/mp4/);
  assert.equal(full.body.length, shared.mock.assets.mp4.length);
  assert.equal(Buffer.compare(full.body, shared.mock.assets.mp4), 0);

  const part = await util.request(h.url + '/media-proxy?url=' + target, { headers: { range: 'bytes=10-109' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 10-109/' + shared.mock.assets.mp4.length);
  assert.equal(Buffer.compare(part.body, shared.mock.assets.mp4.subarray(10, 110)), 0);
});

test('/media-proxy fim a ponta: playlist HLS é reescrita para o proxy local', async (t) => {
  const h = await harness(t);
  if (!h) return;

  const target = encodeURIComponent(LAN_BASE + ':' + shared.mock.port + '/hls/v1080/index.m3u8');
  const res = await util.request(h.url + '/media-proxy?url=' + target);
  assert.equal(res.status, 200);
  assert.ok(res.text.indexOf('#EXTM3U') >= 0);
  assert.ok(res.text.indexOf('127.0.0.1:' + new URL(h.url).port + '/media-proxy?url=') >= 0, 'URLs absolutas no proxy local');
  assert.ok(res.text.indexOf(encodeURIComponent(LAN_BASE + ':' + shared.mock.port + '/hls/v1080/seg0.ts')) >= 0, 'segmento resolvido');

  // e o segmento reescrito realmente baixa pelo proxy
  const segUrl = extractFirstUri(res.text);
  assert.ok(segUrl, 'achou uma URL reescrita');
  const seg = await util.request(segUrl);
  assert.equal(seg.status, 200);
  assert.ok(seg.body.length > 0);
});

test('/media-proxy: 404 do provedor é repassado; host não registrado => 403', async (t) => {
  const h = await harness(t);
  if (!h) return;

  const notFound = await util.request(h.url + '/media-proxy?url=' + encodeURIComponent(LAN_BASE + ':' + shared.mock.port + '/missing.mp4'));
  assert.equal(notFound.status, 404);

  // 127.0.0.1 (loopback) nunca entra na allowlist
  const loopback = await util.request(h.url + '/media-proxy?url=' + encodeURIComponent('http://127.0.0.1:' + shared.mock.port + '/movie.mp4'));
  assert.equal(loopback.status, 403);
});

/** Primeira linha de URI (não-comentário) da playlist. */
function extractFirstUri(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (s && s.charAt(0) !== '#') return s;
  }
  return '';
}
