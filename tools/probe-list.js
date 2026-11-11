global.window = global; require('../tv/js/core/util.js');
const m3u = require('../tv/js/parser/m3u.js'), fs = require('fs');
m3u.parse(fs.readFileSync(process.argv[2], 'utf8')).then(r => {
  console.log('canais', r.live.length, '| filmes', r.movie.length, '| series', r.series.length);
  console.log('categorias live:', r.cats.live.length, r.cats.live.slice(0, 8).map(c => c.name).join(' / '));
  const ext = {}; r.live.concat(r.movie).forEach(i => { const m = /\.(m3u8|ts|mp4|mkv)(\?|$)/i.exec(i.u); const k = m ? m[1].toLowerCase() : 'outro'; ext[k] = (ext[k] || 0) + 1; });
  console.log('formatos de URL:', JSON.stringify(ext));
  console.log('com logo:', r.live.filter(i => i.l).length, '| exemplos:', r.live.slice(0, 3).map(i => i.n + ' -> ' + i.u.replace(/^(https?:\/\/[^\/]+).*/, '$1/...')).join(' | '));
}).catch(e => console.log('erro', e));
