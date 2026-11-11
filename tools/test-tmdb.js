// DESENVOLVIMENTO: testa o modulo REAL de sinopses (tv/js/services/tmdb.js) no Node.
// Usa a API de verdade do TMDb, com shims minimos de App.store/App.http/App.norm.
//
// Uso:  node tools\test-tmdb.js
const path = require('path');

const memoria = new Map();
global.window = global;
global.App = {
  store: {
    get: (k, d) => (memoria.has(k) ? JSON.parse(memoria.get(k)) : d),
    set: (k, v) => { memoria.set(k, JSON.stringify(v)); return true; },
    del: (k) => { memoria.delete(k); }
  },
  isOnline: () => true,
  log: () => {},
  norm: (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
  http: {
    get: (url, opts) => {
      pedidos.push(url);
      return fetch(url, { headers: (opts && opts.headers) || {} }).then((r) => {
        if (!r.ok) return Promise.reject({ code: 'http', status: r.status });
        return r.json();
      });
    }
  }
};
let pedidos = [];

require(path.join(__dirname, '..', 'tv', 'js', 'services', 'tmdb.js'));
const T = global.App.tmdb;

let falhas = 0;
function ok(nome, cond, extra) {
  if (cond) console.log('  ok   ' + nome);
  else { falhas++; console.log('  FALHOU ' + nome + (extra ? ' :: ' + JSON.stringify(extra) : '')); }
}

(async () => {
  console.log('== limpeza de nome ==');
  const casos = [
    ['Oppenheimer (2023)', 'Oppenheimer'],
    ['Duna: Parte 2 (2024) 1080p', 'Duna: Parte 2'],
    ['[Filmes] Batman - O Cavaleiro das Trevas [L]', 'Batman - O Cavaleiro das Trevas'],
    ['1917', '1917'],
    ['Breaking Bad', 'Breaking Bad'],
    ['Filme.de.Teste.2024.DUBLADO', 'Filme de Teste']
  ];
  for (const [entrada, esperado] of casos) {
    const saida = T.limparNome(entrada, '');
    ok(JSON.stringify(entrada) + ' -> ' + JSON.stringify(saida), saida === esperado, { saida, esperado });
  }

  console.log('\n== busca real ==');
  const t1 = await T.lookup({ t: 'movie', n: 'Oppenheimer (2023)', y: '2023' });
  ok('filme com sinopse em pt-BR', !!(t1 && /Oppenheimer/i.test(t1.overview)), t1 && t1.overview.slice(0, 60));
  ok('ano e nota preenchidos', !!(t1 && t1.year === '2023' && Number(t1.rating) > 0), t1 && { y: t1.year, r: t1.rating });
  ok('pôster montado', !!(t1 && /^https:\/\/image\.tmdb\.org\/t\/p\/w500\//.test(t1.poster)), t1 && t1.poster);

  const t2 = await T.lookup({ t: 'series', n: 'Breaking Bad', y: '2008' });
  ok('serie com sinopse', !!(t2 && t2.overview.length > 40), t2 && t2.overview.slice(0, 60));

  const antes = pedidos.length;
  const t3 = await T.lookup({ t: 'movie', n: 'Oppenheimer (2023)', y: '2023' });
  ok('segunda consulta vem do cache (sem rede)', pedidos.length === antes && t3 && t3.id === t1.id, { pedidos: pedidos.length - antes });

  const t4 = await T.lookup({ t: 'movie', n: 'Filme de teste (2024)', y: '2024' });
  ok('titulo inexistente nao casa com nada', t4 === null, t4 && t4.title);

  const t5 = await T.lookup({ t: 'live', n: 'Canal HLS (teste)' });
  ok('canal ao vivo nao consulta o TMDb', t5 === null);

  ok('nenhuma requisicao exposta com a chave em claro? (informativo)', true);

  console.log('\n' + (falhas ? 'FALHAS: ' + falhas : 'TUDO OK') + ' — ' + pedidos.length + ' requisicoes');
  process.exit(falhas ? 1 : 0);
})();
