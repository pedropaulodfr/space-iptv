global.window = global; require('../tv/js/core/util.js');
const m3u = require('../tv/js/parser/m3u.js'), fs = require('fs');
const mb = () => { global.gc && global.gc(); return Math.round(process.memoryUsage().heapUsed / 1048576); };
const buf = fs.readFileSync(process.argv[2]); const dec = new (require('util').TextDecoder)('utf-8'); const p = new m3u.Parser();
const t = Date.now(); const base = mb(); let peak = 0;
for (let i = 0; i < buf.length; i += 65536) { p.feed(dec.decode(buf.subarray(i, i + 65536), { stream: true })); if ((i / 65536) % 200 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed / 1048576); }
const r = p.end();
console.log('streaming em', Date.now() - t, 'ms | live', r.live.length, 'movie', r.movie.length, 'series', r.series.length, 'eps blocos', r.epPacked.length);
const ep = r.epPacked.reduce((a, s) => a + s.length, 0); console.log('episodios empacotados:', Math.round(ep / 1048576), 'M chars');
const keep = { live: r.live, movie: r.movie, series: r.series, cats: r.cats };
const afterParse = mb(); r.epPacked = null; const afterDrop = mb();
console.log('heap base', base, '| pico ~', Math.round(peak), '| apos parse', afterParse, '| sem episodios (o que fica na memoria)', afterDrop, 'MB');
const u = m3u.unpack(buf.length ? ((global.__x = 1), '1\t1\tT\thttp://x/1') : ''); console.log('unpack ok', u[0].eps[0].url);
