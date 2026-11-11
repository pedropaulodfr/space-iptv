global.window = global;
require('../tv/js/core/util.js');
const m3u = require('../tv/js/parser/m3u.js');
const assert = require('assert');
const sample = '﻿#EXTM3U x-tvg-url="http://epg"\r\n' +
'#EXTINF:-1 tvg-id="g1" tvg-name="Canal Um HD" tvg-logo="http://img/1.png" group-title="Abertos, TV",Canal Um HD\r\nhttp://srv/live/u/p/1.m3u8\r\n' +
"#EXTINF:-1 tvg-id='' tvg-logo='http://img/2.png' group-title='Esportes',Esporte 24h\nhttp://srv/live/u/p/2.ts\n" +
'#EXTINF:7200 tvg-logo="http://img/f.jpg" group-title="Filmes | Acao",Filme Teste (2019)\nhttp://srv/movie/u/p/10.mp4\n' +
'#EXTINF:-1 group-title="Series | Drama",Minha Serie S01E01 Piloto\nhttp://srv/series/u/p/100.mkv\n' +
'#EXTINF:-1 group-title="Series | Drama",Minha Serie S01E02\nhttp://srv/series/u/p/101.mkv\n' +
'#EXTINF:-1 group-title="Series | Drama",Minha Serie S02E01\nhttp://srv/series/u/p/102.mkv\n' +
'#EXTGRP:Noticias\n#EXTINF:-1,Noticias 24\nhttps://cdn/news/index.m3u8?token=abc\n' +
'#EXTINF:-1 tvg-name="sem url"\n#EXTINF:-1,Sem Grupo\nrtmp://x/y\n';
m3u.parse(sample).then(r => {
  assert.strictEqual(r.live.length, 4, 'live=' + r.live.length);
  assert.strictEqual(r.movie.length, 1);
  assert.strictEqual(r.series.length, 1);
  assert.strictEqual(r.live[0].c, 'Abertos, TV');            // virgula dentro de aspas
  assert.strictEqual(r.live[0].l, 'http://img/1.png');
  assert.strictEqual(r.live[1].c, 'Esportes');                // aspas simples
  assert.strictEqual(r.live[2].c, 'Noticias');                // EXTGRP
  assert.strictEqual(r.movie[0].y, '2019'); assert.strictEqual(r.movie[0].d, 7200);
  assert.strictEqual(r.series[0].n, 'Minha Serie');
  const sea = m3u.unpack(r.epPacked[0]);
  assert.strictEqual(sea.length, 2);
  assert.strictEqual(sea[0].eps.length, 2);
  assert.strictEqual(sea[1].n, 2);
  console.log('M3U OK:', r.live.length, 'canais,', r.movie.length, 'filme,', r.series.length, 'serie com', sea.length, 'temporadas');
  return m3u.parse('isso nao e uma lista').then(() => { throw new Error('devia rejeitar'); }, e => assert.strictEqual(e.code, 'invalid'));
}).then(() => { console.log('invalida rejeitada OK');
  // desempenho: 100 mil entradas
  let big = '#EXTM3U\n'; for (let i = 0; i < 100000; i++) big += `#EXTINF:-1 tvg-logo="http://i/${i}.png" group-title="G${i%50}",Canal ${i}\nhttp://s/live/u/p/${i}.m3u8\n`;
  const t = Date.now(); return m3u.parse(big).then(r => console.log('100k itens em', Date.now() - t, 'ms ->', r.live.length));
}).catch(e => { console.error('FALHA', e); process.exit(1); });
