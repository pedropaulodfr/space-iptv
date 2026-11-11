// Servidor de DESENVOLVIMENTO com streams IPTV de verdade, gerados por ffmpeg:
// HLS (playlist + segmentos .ts), MPEG-TS continuo (ao vivo), MP4 com Range,
// canais com erro (404/403) e um canal adulto para testar o controle parental.
//
// Uso:  node tools\mock-streams.js                 (porta 8090)
// No emulador Android, o host e 10.0.2.2; num aparelho fisico use o IP da maquina:
//       set HOST_IP=192.168.0.10 & node tools\mock-streams.js
//
// http://<host>:8090/lista.m3u  -> lista pronta para colar no app
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '_streams');
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST_IP || '10.0.2.2';

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska'
};

function playlist() {
  const b = 'http://' + HOST + ':' + PORT;
  return [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="hls" tvg-logo="" group-title="Ao Vivo",Canal HLS (teste)',
    b + '/hls/index.m3u8',
    '#EXTINF:-1 tvg-id="ts" group-title="Ao Vivo",Canal TS contínuo (teste)',
    b + '/live/2.ts',
    '#EXTINF:-1 group-title="Ao Vivo",Canal fora do ar (404)',
    b + '/live/404.ts',
    '#EXTINF:-1 group-title="Ao Vivo",Canal proibido (403)',
    b + '/live/403.ts',
    '#EXTINF:-1 group-title="Adulto XXX",Canal adulto (teste de bloqueio)',
    b + '/live/9.ts',
    '#EXTINF:-1 group-title="Filmes",Filme de teste (2024)',
    b + '/movie/1.mp4',
    '#EXTINF:-1 group-title="Filmes",Filme de teste — segundo (2023)',
    b + '/movie/2.mp4',
    '#EXTINF:-1 group-title="Séries",Série de teste S01E01 Piloto',
    b + '/series/1.mp4',
    '#EXTINF:-1 group-title="Séries",Série de teste S01E02 Segundo',
    b + '/series/2.mp4',
    ''
  ].join('\n');
}

/* MPEG-TS "ao vivo": repete o arquivo indefinidamente. */
function liveTs(res) {
  const f = path.join(ROOT, 'live.ts');
  if (!fs.existsSync(f)) {
    res.statusCode = 404;
    return res.end('gere tools/_streams/live.ts com ffmpeg');
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  let alive = true;
  res.on('close', () => { alive = false; });
  (function pump() {
    if (!alive) return;
    const s = fs.createReadStream(f, { highWaterMark: 188 * 40 });
    s.on('data', () => { s.pause(); setTimeout(() => s.resume(), 24); });
    s.on('end', () => setTimeout(pump, 10));
    s.on('error', () => { alive = false; });
    s.pipe(res, { end: false });
  })();
}

function sendFile(req, res, file) {
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start)) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.statusCode = 416; return res.end(); }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Content-Length': end - start + 1,
      'Cache-Control': 'no-store'
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(file).pipe(res);
}

/* ---------------------------------------------------------------------------
   Xtream Codes de teste (usuario test / senha test), no mesmo servidor.
   As URLs de stream sao montadas pelo app no formato /live/<user>/<pass>/<id>.m3u8
   e resolvidas aqui para o HLS real (ou TS), para exercitar o caminho completo.
   ------------------------------------------------------------------------- */
const XT = {
  live: [
    { stream_id: 1, name: 'Xtream HLS (teste)', category_id: '1', stream_icon: '' },
    { stream_id: 2, name: 'Xtream HLS 2 (teste)', category_id: '1', stream_icon: '' }
  ],
  vod: [
    { stream_id: 11, name: 'Filme Xtream (2024)', container_extension: 'mp4', category_id: '2', rating: '7.1' }
  ],
  series: [
    { series_id: 21, name: 'Série Xtream', category_id: '3', plot: 'Sinopse de teste.', genre: 'Drama', releaseDate: '2020-01-01', rating: '8.0' }
  ]
};

function xtreamApi(res, q) {
  const ok = q.get('username') === 'test' && q.get('password') === 'test';
  const send = (o) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(o));
  };
  if (!ok) return send({ user_info: { auth: 0 } });
  switch (q.get('action')) {
    case null: return send({ user_info: { auth: 1, status: 'Active' }, server_info: {} });
    case 'get_live_categories': return send([{ category_id: '1', category_name: 'Ao Vivo' }]);
    case 'get_live_streams': return send(XT.live);
    case 'get_vod_categories': return send([{ category_id: '2', category_name: 'Filmes' }]);
    case 'get_vod_streams': return send(XT.vod);
    case 'get_series_categories': return send([{ category_id: '3', category_name: 'Séries' }]);
    case 'get_series': return send(XT.series);
    case 'get_series_info':
      return send({
        info: { plot: 'Sinopse de teste.', genre: 'Drama', releaseDate: '2020-01-01', rating: '8.0' },
        episodes: {
          1: [
            { id: 101, episode_num: 1, title: 'Episódio 1', container_extension: 'mp4', info: { duration: '00:12:00' } },
            { id: 102, episode_num: 2, title: 'Episódio 2', container_extension: 'mp4', info: { duration: '00:12:00' } }
          ]
        }
      });
    case 'get_vod_info':
      return send({ info: { plot: 'Descrição de teste.', genre: 'Ação', duration: '00:12:00', releasedate: '2024-01-01' } });
    default: return send([]);
  }
}

/* Lista "de navegacao": categorias suficientes para a faixa de chips ter de rolar
   e filmes suficientes para a grade passar da primeira tela. Serve para testar as
   setas do controle remoto (projetor), onde a lista normal e pequena demais. */
function listaNavegacao() {
  const b = 'http://' + HOST + ':' + PORT;
  const out = ['#EXTM3U'];
  for (let c = 1; c <= 6; c++) {
    for (let i = 1; i <= 4; i++) {
      out.push('#EXTINF:-1 tvg-id="live' + c + '_' + i + '" tvg-logo="" group-title="Ao Vivo ' + c + '",Canal ' + c + '.' + i + ' (teste)');
      out.push(b + '/hls/index.m3u8');
    }
  }
  for (let c = 1; c <= 12; c++) {
    for (let i = 1; i <= 5; i++) {
      out.push('#EXTINF:-1 tvg-id="mov' + c + '_' + i + '" group-title="Filmes Cat ' + c + '",Filme ' + c + ' numero ' + i + ' (202' + (c % 10) + ')');
      out.push(b + '/movie/' + c + i + '.mp4');
    }
  }
  for (let c = 1; c <= 3; c++) {
    for (let i = 1; i <= 2; i++) {
      for (let e = 1; e <= 2; e++) {
        out.push('#EXTINF:-1 tvg-id="ser' + c + '_' + i + '" group-title="Series Cat ' + c + '",Serie ' + c + ' Item ' + i + ' S01E0' + e + ' Episodio ' + e);
        out.push(b + '/series/' + c + i + '.mp4');
      }
    }
  }
  out.push('');
  return out.join('\n');
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/player_api.php') return xtreamApi(res, u.searchParams);

  if (p === '/lista.m3u' || p === '/') {
    res.writeHead(200, {
      'Content-Type': 'audio/x-mpegurl; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    return res.end(playlist());
  }

  if (p === '/navegacao.m3u') {
    res.writeHead(200, {
      'Content-Type': 'audio/x-mpegurl; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    return res.end(listaNavegacao());
  }

  // Xtream: /live/<user>/<pass>/<id>.m3u8 (HLS real) e .ts (TS continuo)
  let m = /^\/live\/[^/]+\/[^/]+\/(\d+)\.(m3u8|ts)$/.exec(p);
  if (m) {
    if (m[2] === 'm3u8') {
      res.writeHead(302, { Location: '/hls/index.m3u8', 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    return liveTs(res);
  }
  // Xtream VOD/series: /movie|/series/<user>/<pass>/<id>.<ext> -> MP4 de teste
  m = /^\/(movie|series)\/[^/]+\/[^/]+\/(\d+)\.(mp4|mkv)$/.exec(p);
  if (m) return sendFile(req, res, path.join(ROOT, 'vod', 'test.mp4'));

  // canais "ao vivo" em MPEG-TS (qualquer id), menos os de erro
  m = /^\/live\/(\d+)\.ts$/.exec(p);  if (m) {
    const id = Number(m[1]);
    if (id === 404) { res.statusCode = 404; res.setHeader('Access-Control-Allow-Origin', '*'); return res.end('404'); }
    if (id === 403) { res.statusCode = 403; res.setHeader('Access-Control-Allow-Origin', '*'); return res.end('403'); }
    return liveTs(res);
  }

  // VOD: filmes e episodios apontam para o mesmo MP4 de teste
  m = /^\/(movie|series)\/(\d+)\.(mp4|mkv)$/.exec(p);
  if (m) return sendFile(req, res, path.join(ROOT, 'vod', 'test.mp4'));

  if (p === '/livets') return liveTs(res);

  const file = path.join(ROOT, decodeURIComponent(p).replace(/^\/+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end('404');
  }
  return sendFile(req, res, file);
}).listen(PORT, '0.0.0.0', () => {
  console.log('streams de teste em http://' + HOST + ':' + PORT + '/lista.m3u  (raiz: ' + ROOT + ')');
});
