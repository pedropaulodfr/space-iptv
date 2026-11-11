// Servidor de DESENVOLVIMENTO: serve tv/ na porta 8080 e imita Xtream Codes (usuario test / senha test) na 8081.
// Dados sinteticos apenas para testar a interface. NAO faz parte do pacote da TV.
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'tv');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.xml': 'text/xml' };

/* Arte sintetica (posteres, capas, backdrops e logos) servida pelo mock.
   Sao imagens abstratas geradas localmente: nenhum material de terceiros. */
const IMG = 'http://127.0.0.1:8080/artimg/';

const liveCats = ['Abertos', 'Filmes', 'Esportes', 'Noticias', 'Documentarios', 'Infantil', 'Entretenimento'].map((n, i) => ({ category_id: String(i + 1), category_name: n }));
const live = []; for (let i = 1; i <= 3000; i++) live.push({ stream_id: i, name: 'Canal ' + i + (i % 3 ? ' HD' : ' FHD'), stream_icon: IMG + 'l' + ((i % 4) + 1) + '.png', category_id: String((i % 7) + 1), epg_channel_id: 'c' + i });
const vodCats = ['Acao', 'Comedia', 'Drama', 'Terror'].map((n, i) => ({ category_id: String(100 + i), category_name: n }));
const vod = []; for (let i = 1; i <= 1500; i++) vod.push({ stream_id: 5000 + i, name: 'Filme Exemplo ' + i + ' (' + (1990 + i % 34) + ')', stream_icon: IMG + 'p' + ((i % 8) + 1) + '.png', backdrop_path: IMG + 'b' + ((i % 4) + 1) + '.png', category_id: String(100 + i % 4), container_extension: 'mp4', rating: String((i % 10) + 0.5), added: String(1700000000 + i * 1000) });
const serCats = ['Drama', 'Anime'].map((n, i) => ({ category_id: String(200 + i), category_name: n }));
const ser = []; for (let i = 1; i <= 300; i++) ser.push({ series_id: 9000 + i, name: 'Serie Exemplo ' + i, cover: IMG + 's' + ((i % 4) + 1) + '.png', backdrop_path: [IMG + 'b' + ((i % 4) + 1) + '.png'], plot: 'Sinopse de teste da serie ' + i + '.', genre: 'Drama', releaseDate: (2000 + i % 24) + '-01-01', rating: '7.5', category_id: String(200 + i % 2), last_modified: String(1700000000 + i) });

function seriesInfo(id) {
  const eps = {}; for (let s = 1; s <= 3; s++) { eps[s] = []; for (let e = 1; e <= 12; e++) eps[s].push({ id: String(id * 100 + s * 20 + e), episode_num: e, title: 'Episodio ' + e, container_extension: 'mkv', info: { duration: '45:00', plot: 'Resumo.' } }); }
  return {
    info: {
      plot: 'Sinopse de teste da serie ' + id + '. '.repeat(1), genre: 'Drama', releaseDate: '2015-05-05', rating: '8',
      cover: IMG + 's' + ((id % 4) + 1) + '.png', backdrop_path: [IMG + 'b' + ((id % 4) + 1) + '.png']
    },
    episodes: eps
  };
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (u.pathname === '/player_api.php') {
    const q = u.searchParams, ok = q.get('username') === 'test' && q.get('password') === 'test';
    const send = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    if (!ok) return send({ user_info: { auth: 0 } });
    switch (q.get('action')) {
      case null: return send({ user_info: { auth: 1, status: 'Active' }, server_info: {} });
      case 'get_live_categories': return send(liveCats);
      case 'get_live_streams': return send(live);
      case 'get_vod_categories': return send(vodCats);
      case 'get_vod_streams': return send(vod);
      case 'get_series_categories': return send(serCats);
      case 'get_series': return send(ser);
      case 'get_series_info': return send(seriesInfo(+q.get('series_id')));
      case 'get_vod_info': return send({ info: { plot: 'Descricao de teste do filme.', genre: 'Acao', duration: '1:50:00', releasedate: '2020-01-01', movie_image: IMG + 'p' + ((+q.get('vod_id') % 8) + 1) + '.png', backdrop_path: [IMG + 'b' + ((+q.get('vod_id') % 4) + 1) + '.png'] } });
    }
    return send([]);
  }
  if (u.pathname === '/list.m3u') {
    res.setHeader('Content-Type', 'audio/x-mpegurl');
    let t = '#EXTM3U\n'; for (let i = 1; i <= 200; i++) t += `#EXTINF:-1 tvg-id="c${i}" group-title="Grupo ${i % 5}",Canal M3U ${i}\nhttp://localhost:9/live/${i}.m3u8\n`;
    for (let i = 1; i <= 20; i++) t += `#EXTINF:-1 group-title="Filmes",Filme M3U ${i} (2021)\nhttp://localhost:9/movie/${i}.mp4\n`;
    for (let s = 1; s <= 2; s++) for (let e = 1; e <= 4; e++) t += `#EXTINF:-1 group-title="Series",Serie M3U S0${s}E0${e}\nhttp://localhost:9/series/${s}${e}.mkv\n`;
    return res.end(t);
  }

  /* Streams sinteticos: latencia e falha variando por id, para exercitar os
     indicadores de saude do app (verde/amarelo/laranja/vermelho) nas capturas. */
  if (/^\/(live|movie|series)\//.test(u.pathname)) {
    const arq = u.pathname.split('/').pop() || '';
    const ext = (arq.split('.').pop() || 'ts').toLowerCase();
    if (ext === 'm3u8') { res.statusCode = 404; return res.end('404'); }
    const id = parseInt((arq.match(/(\d+)/) || [0, 1])[1], 10) || 1;
    if (id % 7 === 0) { res.statusCode = 404; return res.end('404'); }          /* canal fora do ar */
    const atraso = id % 5 === 0 ? 4200 : (id % 3 === 0 ? 1900 : 120);           /* lento / medio / rapido */
    return setTimeout(() => {
      try {
        if (res.writableEnded || res.destroyed) return;
        const buf = Buffer.alloc(188 * 3);
        buf[0] = 0x47; buf[188] = 0x47; buf[376] = 0x47;                        /* sync byte de MPEG-TS */
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' });
        res.end(buf);
      } catch (e) { /* cliente abortou a sonda */ }
    }, atraso);
  }
  /* arte sintetica */
  if (u.pathname.indexOf('/artimg/') === 0) {
    const f = path.join(__dirname, '_art', 'posters', path.basename(decodeURIComponent(u.pathname)));
    if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('404'); }
    res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'max-age=120');
    return fs.createReadStream(f).pipe(res);
  }

  let f = path.join(root, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('404'); }
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(f).pipe(res);
}).listen(8080, () => console.log('mock em http://localhost:8080'));
