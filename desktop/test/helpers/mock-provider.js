/* Servidor HTTP local de mentira ("mock provider") para os testes do desktop.
 *
 * Sobe em 127.0.0.1 com porta efêmera e serve:
 *   - M3U (com `url-tvg` apontando para o XMLTV do próprio mock);
 *   - MP4 com e sem suporte a Range (retomada de download);
 *   - HLS: master m3u8, variantes, init map, segmentos, chave AES-128 e
 *     variante com DRM (SAMPLE-AES/fairplay) para provar a recusa;
 *   - XMLTV plain e gzip;
 *   - rotas falsas de backend (`/api/...`) para os testes de proxy;
 *   - 404, 403, atraso e redirecionamento.
 *
 * Regras de segurança/teste:
 *   - só escuta em 127.0.0.1 e porta efêmera;
 *   - registra requisições SEM querystring crua (credenciais Xtream ficam no
 *     path/query) e com Cookie/Auth mascarados no log público (`records`);
 *     campos de diagnóstico separados (`raw`) existem só em memória.
 *
 * Uso:
 *   const { startMockProvider } = require('../helpers/mock-provider');
 *   const mock = await startMockProvider({ api: true });
 *   ... mock.baseUrl ... mock.assets ... mock.records
 *   await mock.close();
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');

const MIME = {
  m3u8: 'application/vnd.apple.mpegurl',
  m3u: 'audio/x-mpegurl; charset=utf-8',
  ts: 'video/mp2t',
  mp4: 'video/mp4',
  bin: 'application/octet-stream',
  xml: 'application/xml; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  jpg: 'image/jpeg'
};

/* -------------------------------------------------------------------------- */
/* Conteúdo determinístico                                                    */
/* -------------------------------------------------------------------------- */

function patternBuffer(size, seed) {
  const buf = Buffer.alloc(size);
  let x = (seed >>> 0) || 0x12345678;
  for (let i = 0; i < size; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = (x >>> 24) & 0xff;
  }
  return buf;
}

function mp4Box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

/* MP4 "válido" o suficiente (ftyp + mdat) e determinístico. */
function makeMp4(size) {
  const ftyp = mp4Box('ftyp', Buffer.concat([
    Buffer.from('isom', 'latin1'),
    Buffer.from([0, 0, 0, 1]),
    Buffer.from('isomiso2avc1mp41', 'latin1')
  ]));
  const payload = patternBuffer(Math.max(1024, size), 0xa5a5a5);
  const mdat = mp4Box('mdat', payload);
  return Buffer.concat([ftyp, mdat, Buffer.alloc(8)]); /* 8 bytes de padding livre */
}

/* Segmento MPEG-TS "de mentira" (sync byte 0x47 a cada 188 bytes). */
function makeTsSegment(seed, packets) {
  const n = packets || 10;
  const buf = patternBuffer(188 * n, seed);
  for (let i = 0; i < n; i++) buf[i * 188] = 0x47;
  return buf;
}

function makeXmltv(opts) {
  /* Datas RELATIVAS ao "agora" por padrao: o EPG do desktop mostra agora/a seguir
     e o Guia precisa de programas cobrindo a janela atual (fixtures fixas de 2026
     ficariam fora da janela e o Guia apareceria vazio). `opts.now` permite
     determinismo nos testes. */
  const now = (opts && opts.now) ? new Date(opts.now).getTime() : Date.now();
  const hour = Math.floor(now / 3600000) * 3600000;
  function fmt(ts) {
    const d = new Date(ts);
    function p2(n) { return String(n).padStart(2, "0"); }
    return d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) +
      p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + " +0000";
  }
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<tv generator-info-name=\"space-iptv mock-provider\">",
    "  <channel id=\"mock.one\">",
    "    <display-name>Mock Um</display-name>",
    "    <display-name>Mock Um HD</display-name>",
    "    <icon src=\"https://example.invalid/mock1.png\"/>",
    "  </channel>",
    "  <channel id=\"mock.two\">",
    "    <display-name>Mock Dois</display-name>",
    "  </channel>",
    "  <programme start=\"" + fmt(hour) + "\" stop=\"" + fmt(hour + 3600000) + "\" channel=\"mock.one\">",
    "    <title>Programa Mock</title>",
    "    <desc>Descrição &amp; detalhes do programa mock.</desc>",
    "    <category>Teste</category>",
    "  </programme>",
    "  <programme start=\"" + fmt(hour + 3600000) + "\" stop=\"" + fmt(hour + 7200000) + "\" channel=\"mock.one\">",
    "    <title>Segundo Mock</title>",
    "  </programme>",
    "  <programme start=\"" + fmt(hour) + "\" stop=\"" + fmt(hour + 1800000) + "\" channel=\"mock.two\">",
    "    <title>Novela Mock</title>",
    "  </programme>",
    "</tv>",
    ""
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Utilidades HTTP                                                            */
/* -------------------------------------------------------------------------- */

function send(res, status, body, headers) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Length': String(buf.length),
    'Cache-Control': 'no-store'
  }, headers || {}));
  res.end(buf);
}

function sendJson(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), Object.assign({ 'Content-Type': MIME.json }, headers || {}));
}

/** Resposta com suporte a Range (206) para bytes. */
function sendRange(req, res, buf, contentType) {
  const range = req.headers && req.headers.range;
  if (!range) {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(buf.length),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    });
    return res.end(buf);
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!m) {
    res.writeHead(416, { 'Content-Range': 'bytes */' + buf.length });
    return res.end();
  }
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start == null && end == null) {
    res.writeHead(416, { 'Content-Range': 'bytes */' + buf.length });
    return res.end();
  }
  if (start == null) { /* bytes=-N (sufixo) */
    start = Math.max(0, buf.length - end);
    end = buf.length - 1;
  } else if (end == null) {
    end = buf.length - 1;
  }
  if (start >= buf.length || start > end) {
    res.writeHead(416, { 'Content-Range': 'bytes */' + buf.length });
    return res.end();
  }
  end = Math.min(end, buf.length - 1);
  const slice = buf.subarray(start, end + 1);
  res.writeHead(206, {
    'Content-Type': contentType,
    'Content-Length': String(slice.length),
    'Content-Range': 'bytes ' + start + '-' + end + '/' + buf.length,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  });
  res.end(slice);
}

function sanitizeHeaders(h) {
  const out = {};
  const copy = ['origin', 'referer', 'host', 'range', 'accept', 'accept-encoding', 'content-type', 'user-agent', 'sec-fetch-site', 'if-range'];
  for (const key of copy) if (h[key] !== undefined) out[key] = String(h[key]);
  /* diagnóstico (nunca credencial real): só sinaliza presença+máscara */
  if (h.cookie !== undefined) out.cookie = '[redacted]';
  if (h.authorization !== undefined) out.authorization = '[redacted]';
  return out;
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} [options]
 * @param {boolean} [options.api]       inclui as rotas de backend falso (`/api/...`)
 * @param {number}  [options.delayMs]   atraso artificial em todas as respostas
 * @param {number}  [options.mp4Bytes]  tamanho do MP4 servido
 * @returns {Promise<object>} provider
 */
function startMockProvider(options) {
  const opts = options || {};
  const delayMs = Number(opts.delayMs) > 0 ? Math.floor(opts.delayMs) : 0;

  /* --- assets (determinísticos, gerados uma vez) --- */
  const assets = {
    mp4: makeMp4(opts.mp4Bytes || 96 * 1024),
    xmltv: makeXmltv(),
    key: crypto.createHash('sha256').update('space-iptv-mock-hls-key').digest().subarray(0, 16),
    init: patternBuffer(512, 0x1a2b3c),
    plainSegments: [makeTsSegment(0x1111, 12), makeTsSegment(0x2222, 12)],
    hls: {}
  };
  assets.xmltvGz = zlib.gzipSync(Buffer.from(assets.xmltv, 'utf8'));

  /* variante 1080p: sem criptografia, com init map */
  assets.hls.v1080 = { segments: [makeTsSegment(0x3333, 16), makeTsSegment(0x4444, 16)] };

  /* variante 720p: AES-128 com IV explícito por segmento (chave servida junto) */
  const ivFor = function (seq) {
    const iv = Buffer.alloc(16);
    iv.writeUInt32BE(seq >>> 0, 12);
    return iv;
  };
  const encrypt = function (buf, iv) {
    const cipher = crypto.createCipheriv('aes-128-cbc', assets.key, iv);
    return Buffer.concat([cipher.update(buf), cipher.final()]);
  };
  assets.hls.v720 = {
    segments: [makeTsSegment(0x5555, 12), makeTsSegment(0x6666, 12)],
    ivs: [ivFor(0), ivFor(1)],
    encrypted: []
  };
  assets.hls.v720.segments.forEach(function (buf, i) {
    assets.hls.v720.encrypted.push(encrypt(buf, assets.hls.v720.ivs[i]));
  });

  const baseOf = function () { return provider.baseUrl; };

  /* --- rotas --- */
  const records = [];

  function record(req, status, pathname) {
    records.push({
      method: String(req.method || 'GET').toUpperCase(),
      path: pathname,
      status: status,
      headers: sanitizeHeaders(req.headers || {}),
      at: Date.now()
    });
  }

  function m3u() {
    const b = baseOf();
    return [
      '#EXTM3U url-tvg="' + b + '/xmltv.xml"',
      '#EXTINF:-1 tvg-id="mock.one" tvg-name="Canal Mock HLS" tvg-logo="" group-title="Ao Vivo",Canal Mock HLS',
      b + '/hls/master.m3u8',
      '#EXTINF:-1 tvg-id="mock.two" group-title="Filmes",Filme Mock (2026)',
      b + '/movie.mp4',
      '#EXTINF:-1 group-title="Filmes",Filme sem Range',
      b + '/no-range.mp4',
      '#EXTINF:-1 group-title="Filmes",Fora do ar (404)',
      b + '/missing.mp4',
      '#EXTINF:-1 group-title="Filmes",Proibido (403)',
      b + '/forbidden.mp4',
      '#EXTINF:-1 group-title="Protegido",Protegido por DRM',
      b + '/hls/drm/master.m3u8',
      ''
    ].join('\n');
  }

  function playlist720() {
    const b = baseOf();
    const ivHex = function (iv) { return iv.toString('hex'); };
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MAP:URI="' + b + '/hls/v720/init.mp4"',
      '#EXT-X-KEY:METHOD=AES-128,URI="' + b + '/hls/v720/key.bin",IV=0x' + ivHex(assets.hls.v720.ivs[0]),
      '#EXTINF:4.000000,',
      'seg0.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="' + b + '/hls/v720/key.bin",IV=0x' + ivHex(assets.hls.v720.ivs[1]),
      '#EXTINF:4.000000,',
      'seg1.ts',
      '#EXT-X-ENDLIST',
      ''
    ].join('\n');
  }

  function playlist1080() {
    const b = baseOf();
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-MAP:URI="' + b + '/hls/v1080/init.mp4"',
      '#EXTINF:4.000000,',
      'seg0.ts',
      '#EXTINF:4.000000,',
      'seg1.ts',
      '#EXT-X-ENDLIST',
      ''
    ].join('\n');
  }

  function master() {
    const b = baseOf();
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-STREAM-INF:BANDWIDTH=900000,AVERAGE-BANDWIDTH=800000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
      b + '/hls/v720/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2600000,AVERAGE-BANDWIDTH=2400000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
      b + '/hls/v1080/index.m3u8',
      ''
    ].join('\n');
  }

  function drmMaster() {
    const b = baseOf();
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://space-iptv-mock",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720',
      b + '/hls/drm/v/index.m3u8',
      ''
    ].join('\n');
  }

  function drmVariant() {
    const b = baseOf();
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MAP:URI="' + b + '/hls/drm/v/init.mp4"',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://space-iptv-mock",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"',
      '#EXTINF:4.000000,',
      'seg0.ts',
      '#EXT-X-ENDLIST',
      ''
    ].join('\n');
  }

  function apiEcho(req, urlObj) {
    return {
      method: String(req.method || 'GET').toUpperCase(),
      pathname: urlObj.pathname,
      query: Object.fromEntries(urlObj.searchParams.entries()),
      headers: req.headers
    };
  }

  const routes = {
    'GET /m3u': function (req, res) {
      send(res, 200, m3u(), { 'Content-Type': MIME.m3u });
    },
    'GET /': function (req, res) {
      send(res, 200, m3u(), { 'Content-Type': MIME.m3u });
    },
    'GET /movie.mp4': function (req, res) {
      sendRange(req, res, assets.mp4, MIME.mp4);
    },
    'GET /no-range.mp4': function (req, res) {
      res.writeHead(200, { 'Content-Type': MIME.mp4, 'Content-Length': String(assets.mp4.length), 'Cache-Control': 'no-store' });
      res.end(assets.mp4);
    },
    'GET /missing.mp4': function (req, res) {
      send(res, 404, '404 - não encontrado', { 'Content-Type': MIME.txt });
    },
    'GET /forbidden.mp4': function (req, res) {
      send(res, 403, '403 - proibido', { 'Content-Type': MIME.txt });
    },
    'GET /slow': async function (req, res) {
      await new Promise(function (r) { setTimeout(r, Math.max(delayMs, 250)); });
      send(res, 200, 'resposta lenta', { 'Content-Type': MIME.txt });
    },
    'GET /redirect-to-movie': function (req, res) {
      res.writeHead(302, { Location: '/movie.mp4', 'Cache-Control': 'no-store' });
      res.end();
    },
    'GET /hls/master.m3u8': function (req, res) {
      send(res, 200, master(), { 'Content-Type': MIME.m3u8 });
    },
    'GET /hls/v720/index.m3u8': function (req, res) {
      send(res, 200, playlist720(), { 'Content-Type': MIME.m3u8 });
    },
    'GET /hls/v1080/index.m3u8': function (req, res) {
      send(res, 200, playlist1080(), { 'Content-Type': MIME.m3u8 });
    },
    'GET /hls/drm/master.m3u8': function (req, res) {
      send(res, 200, drmMaster(), { 'Content-Type': MIME.m3u8 });
    },
    'GET /hls/drm/v/index.m3u8': function (req, res) {
      send(res, 200, drmVariant(), { 'Content-Type': MIME.m3u8 });
    },
    'GET /hls/v720/key.bin': function (req, res) {
      send(res, 200, assets.key, { 'Content-Type': MIME.bin });
    },
    'GET /hls/v720/init.mp4': function (req, res) {
      sendRange(req, res, assets.init, MIME.mp4);
    },
    'GET /hls/v1080/init.mp4': function (req, res) {
      sendRange(req, res, assets.init, MIME.mp4);
    },
    'GET /hls/drm/v/init.mp4': function (req, res) {
      sendRange(req, res, assets.init, MIME.mp4);
    },
    'GET /hls/v720/seg0.ts': function (req, res) { send(res, 200, assets.hls.v720.encrypted[0], { 'Content-Type': MIME.ts }); },
    'GET /hls/v720/seg1.ts': function (req, res) { send(res, 200, assets.hls.v720.encrypted[1], { 'Content-Type': MIME.ts }); },
    'GET /hls/v1080/seg0.ts': function (req, res) { send(res, 200, assets.hls.v1080.segments[0], { 'Content-Type': MIME.ts }); },
    'GET /hls/v1080/seg1.ts': function (req, res) { send(res, 200, assets.hls.v1080.segments[1], { 'Content-Type': MIME.ts }); },
    'GET /hls/drm/v/seg0.ts': function (req, res) { send(res, 200, assets.hls.v1080.segments[0], { 'Content-Type': MIME.ts }); },
    'GET /xmltv.xml': function (req, res) {
      send(res, 200, assets.xmltv, { 'Content-Type': MIME.xml });
    },
    'GET /xmltv.xml.gz': function (req, res) {
      send(res, 200, assets.xmltvGz, {
        'Content-Type': MIME.xml,
        'Content-Encoding': 'gzip'
      });
    },
    'GET /poster.jpg': function (req, res) {
      send(res, 200, patternBuffer(256, 0x777), { 'Content-Type': MIME.jpg });
    },
    /* backend falso (para testes de proxy) */
    'GET /api/auth/session': function (req, res) {
      sendJson(res, 200, { user: { email: 'desktop.user@example.com', name: 'Usuário Teste', role: 'user' } }, {
        'Set-Cookie': [
          'space_session=mock-token; Domain=example.com; Path=/; HttpOnly; SameSite=Lax; Secure',
          'space_pref=1; Domain=example.com; Path=/; Secure'
        ]
      });
    },
    'POST /api/auth/login': function (req, res) {
      sendJson(res, 200, { ok: true, user: { email: 'desktop.user@example.com', role: 'user' } }, {
        'Set-Cookie': ['space_session=mock-token; Domain=example.com; Path=/; HttpOnly; Secure']
      });
    },
    'POST /api/auth/logout': function (req, res) {
      sendJson(res, 200, { ok: true }, {
        'Set-Cookie': ['space_session=; Domain=example.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure']
      });
    },
    'GET /api/auth/logout': function (req, res) {
      sendJson(res, 200, { ok: true });
    },
    'GET /api/echo': function (req, res, urlObj) {
      sendJson(res, 200, apiEcho(req, urlObj));
    },
    'POST /api/echo': function (req, res, urlObj) {
      sendJson(res, 200, apiEcho(req, urlObj));
    },
    'GET /api/admin/users': function (req, res) {
      sendJson(res, 200, { leak: true, items: [{ id: 1, email: 'admin@example.com' }] });
    },
    'GET /api/error': function (req, res) {
      sendJson(res, 500, { error: 'mock_error', message: 'falha simulada do upstream' });
    },
    'GET /api/protected': function (req, res) {
      sendJson(res, 401, { error: 'unauthorized', message: 'sessão inválida (mock)' });
    },
    'GET /api/health': function (req, res) {
      sendJson(res, 200, { ok: true });
    }
  };

  const provider = {
    baseUrl: '',
    port: 0,
    records: records,
    assets: assets,
    ready: false,
    close: null,
    reset: function () { records.length = 0; },
    last: function () { return records.length ? records[records.length - 1] : null; },
    find: function (predicate) {
      for (let i = records.length - 1; i >= 0; i--) if (predicate(records[i])) return records[i];
      return null;
    },
    requestsFor: function (pathname) {
      return records.filter(function (r) { return r.path === pathname; });
    }
  };

  const server = http.createServer(function (req, res) {
    let urlObj;
    try {
      urlObj = new URL(String(req.url || '/'), 'http://127.0.0.1');
    } catch (e) {
      send(res, 400, 'bad request');
      record(req, 400, '/');
      return;
    }
    const pathname = urlObj.pathname;
    const key = String(req.method || 'GET').toUpperCase() + ' ' + pathname;
    const handler = routes[key] || (opts.api ? routes['GET ' + pathname] : null);

    res.on('finish', function () { record(req, res.statusCode, pathname); });

    if (!handler) {
      send(res, 404, 'rota mock não encontrada: ' + pathname, { 'Content-Type': MIME.txt });
      return;
    }
    const run = function () { return handler(req, res, urlObj); };
    if (delayMs) setTimeout(run, delayMs);
    else run();
  });

  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    const bindHost = opts.host || '127.0.0.1';
    server.listen(0, bindHost, function () {
      provider.port = server.address().port;
      provider.host = bindHost;
      provider.baseUrl = 'http://' + (bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost) + ':' + provider.port;
      provider.ready = true;
      provider.close = function () {
        return new Promise(function (res) {
          try { server.close(function () { res(); }); } catch (e) { res(); }
          try { server.closeAllConnections && server.closeAllConnections(); } catch (e) { /* ignore */ }
        });
      };
      resolve(provider);
    });
  });
}

module.exports = {
  startMockProvider: startMockProvider,
  makeMp4: makeMp4,
  makeTsSegment: makeTsSegment,
  makeXmltv: makeXmltv,
  MIME: MIME
};
