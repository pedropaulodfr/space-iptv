/* Sinopses de filmes e series via TMDb (The Movie Database).
 *
 * Modulo COMPARTILHADO entre o app Tizen e o app Android (o Gradle copia app/js para o APK).
 * Nao usa nada de plataforma: so App.http (XHR) e App.store (localStorage).
 *
 * Como funciona: o catalogo da lista IPTV quase nunca traz sinopse em M3U (e o Xtream as
 * vezes traz). Quando a tela de detalhes nao tem texto, ela pede aqui: limpa o nome do
 * arquivo, procura no TMDb em pt-BR (cai para en-US se nao houver traducao), escolhe o
 * resultado que combina com o titulo e o ano, e devolve {overview, poster, backdrop,
 * rating, year}. O resultado fica em cache por 30 dias, entao cada titulo consome no
 * maximo duas requisicoes na vida.
 *
 * Chave: a do painel do TMDb (v3, somente leitura). O app nao tem servidor proprio, entao
 * a chave viaja com ele - e o modelo normal de qualquer cliente TMDb. Pode ser trocada sem
 * recompilar: App.tmdb.setKey('nova') ou App.tmdb.setToken('eyJ...') (v4).
 */
(function (g) {
  'use strict';
  var App = g.App;

  var DEFAULT_KEY = 'bce7774fdf9000e6a834b75332bdf84e';
  var API = 'https://api.themoviedb.org/3';
  var IMG = 'https://image.tmdb.org/t/p/w500';
  var IMG_BIG = 'https://image.tmdb.org/t/p/w780';
  var TTL = 30 * 24 * 60 * 60 * 1000;   // 30 dias
  var LANGS = ['pt-BR', 'en-US'];
  var MAX_PAR = 2;                      // requisicoes simultaneas
  var KEEP = 400;                       // entradas de cache mantidas

  /* palavras que os provedores colam no nome do arquivo e que atrapalham a busca */
  var RUIDO = /\b(1080p?|720p?|2160p?|480p|4k|uhd|fullhd|hdtv|web-?dl|webrip|bluray|bdrip|brrip|dvdrip|hdcam|hdtc|cam|ts|tc|remux|hevc|h\.?264|h\.?265|x264|x265|aac|ac3|ddp?5\.?1|dual|dublado|dublada|legendado|legendada|dub|leg|nacional|10bit|hdr|completo|dvd)\b/gi;
  var PREFIXO = /^\s*(filme|filmes|serie|series|série|séries|movie|movies)\s*[-:|–]\s*/i;

  var mem = {};          // chave -> meta | null (cache da sessao)
  var fila = [];         // [{fn, res, rej}]
  var ativos = 0;

  function chaveApi() {
    var k = App.store.get('tmdbKey', '');
    return (typeof k === 'string' && k.length >= 20) ? k : DEFAULT_KEY;
  }
  function tokenApi() {
    var t = App.store.get('tmdbToken', '');
    return (typeof t === 'string' && t.length >= 40) ? t : '';
  }

  /* --------------------------------------------------------------- nome --- */
  function limparNome(nome, ano) {
    var s = String(nome == null ? '' : nome).replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
    s = s.replace(/[._]+/g, ' ');
    s = s.replace(RUIDO, ' ');
    s = s.replace(PREFIXO, ' ');
    /* ano entre parenteses/colchetes sai sempre */
    s = s.replace(/\(\s*(19|20)\d{2}\s*\)/g, ' ');
    s = s.replace(/\[\s*(19|20)\d{2}\s*\]/g, ' ');
    /* ano solto no fim: so sai se ainda sobrar titulo ("1917" fica inteiro) */
    var m = s.match(/\s+((?:19|20)\d{2})\s*$/);
    if (m && s.replace(m[0], ' ').replace(/[^\wÀ-ÿ]/g, '').length > 1) s = s.replace(m[0], ' ');
    s = s.replace(/\s*[-–—:|·]\s*$/g, '').replace(/\s{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
    return s || String(nome == null ? '' : nome).replace(/[._]+/g, ' ').trim();
  }

  function chaveDe(item) {
    var tipo = item.t === 'series' ? 'series' : 'movie';
    return tipo + '|' + App.norm(limparNome(item.n, item.y)) + '|' + (item.y || '');
  }

  /* -------------------------------------------------------------- cache --- */
  function doCache(k) {
    var c = App.store.get('tmdb.' + k, null);
    if (!c || !c.at || Date.now() - c.at > TTL) return undefined;
    return c.d || null;
  }
  function guardar(k, d) {
    if (!d) { App.store.del('tmdb.' + k); return; }
    App.store.set('tmdb.' + k, { at: Date.now(), d: d });
    aparar();
  }
  /* mantem o cache pequeno: apaga as entradas mais antigas quando passa do limite */
  var podado = 0;
  function aparar() {
    if (Date.now() - podado < 60000) return;
    podado = Date.now();
    try {
      var chaves = [], i, k;
      for (i = 0; i < localStorage.length; i++) {
        k = localStorage.key(i);
        if (k && k.indexOf('sl.tmdb.') === 0) chaves.push(k);
      }
      if (chaves.length <= KEEP) return;
      chaves.sort(function (a, b) {
        var ca = App.store.get(a.slice(3), {}), cb = App.store.get(b.slice(3), {});
        return (ca && ca.at || 0) - (cb && cb.at || 0);
      });
      chaves.slice(0, chaves.length - KEEP).forEach(function (k2) { localStorage.removeItem(k2); });
    } catch (e) { /* sem localStorage: segue so com a memoria */ }
  }

  /* --------------------------------------------------------------- fila --- */
  function enfileirar(fn) {
    return new Promise(function (res, rej) {
      fila.push({ fn: fn, res: res, rej: rej });
      bombear();
    });
  }
  function bombear() {
    while (ativos < MAX_PAR && fila.length) {
      var t = fila.shift();
      ativos++;
      (function (job) {
        new Promise(function (r) { r(job.fn()); }).then(job.res, job.rej)
          .then(function () { ativos--; bombear(); });
      })(t);
    }
  }

  /* ------------------------------------------------------------- request --- */
  function url(path, params) {
    var q = API + path + '?language=' + params.language + '&include_adult=false' + params.extra;
    var tok = tokenApi();
    if (tok) return { url: q, headers: { Authorization: 'Bearer ' + tok, accept: 'application/json' } };
    return { url: q + '&api_key=' + encodeURIComponent(chaveApi()), headers: null };
  }

  function buscar(item) {
    var tipo = item.t === 'series' ? 'tv' : 'movie';
    var titulo = limparNome(item.n, item.y);
    if (!titulo) return Promise.resolve(null);
    var ano = String(item.y || '').slice(0, 4) || (/^(19|20)\d{2}$/.test(item.y || '') ? item.y : '');
    var extra = '&query=' + encodeURIComponent(titulo);
    if (ano) extra += (tipo === 'tv' ? '&first_air_date_year=' : '&year=') + ano;

    function uma(lang) {
      var r = url('/search/' + tipo, { language: lang, extra: extra });
      return App.http.get(r.url, { json: true, timeout: 12000, headers: r.headers });
    }

    return enfileirar(function () { return uma(LANGS[0]); }).then(function (res) {
      var melhor = escolher(res, item, titulo, ano);
      if (melhor && melhor.overview) return melhor;
      /* sem sinopse em pt-BR: tenta o idioma original antes de desistir */
      return enfileirar(function () { return uma(LANGS[1]); }).then(function (res2) {
        var alt = escolher(res2, item, titulo, ano);
        if (melhor && alt) {
          if (!melhor.overview && alt.overview) melhor.overview = alt.overview;
          return melhor;
        }
        return melhor || alt;
      });
    });
  }

  function escolher(res, item, titulo, ano) {
    var lista = (res && res.results) || [], i, melhor = null, melhorNota = 0;
    for (i = 0; i < lista.length; i++) {
      var nota = pontuar(lista[i], titulo, ano);
      if (nota > melhorNota) { melhorNota = nota; melhor = lista[i]; }
    }
    if (!melhor || melhorNota < 4) return null;
    return meta(melhor);
  }

  /* Compara o resultado do TMDb com o nome da lista. Exige titulo compativel:
     sem isso, uma busca generica ("O Resgate") casaria com qualquer blockbuster. */
  function pontuar(o, titulo, ano) {
    var a = App.norm(o.title || o.name || ''), b = App.norm(titulo), s = 0;
    if (!a || !b) return 0;
    if (a === b) s += 6;
    else if (a.indexOf(b) === 0 || b.indexOf(a) === 0) s += 3;
    else if (a.indexOf(b) >= 0) s += 2;
    else return 0;
    var y = String(o.release_date || o.first_air_date || '').slice(0, 4);
    if (ano && y) {
      if (y === String(ano)) s += 3;
      else if (Math.abs(Number(y) - Number(ano)) <= 1) s += 1;
      else s -= 2;
    }
    if (o.overview) s += 1;
    if (o.vote_count) s += Math.min(2, o.vote_count / 2000);
    return s;
  }

  function meta(o) {
    var y = String(o.release_date || o.first_air_date || '');
    return {
      id: o.id,
      title: o.title || o.name || '',
      year: y.slice(0, 4),
      overview: String(o.overview || '').replace(/\s+/g, ' ').trim(),
      rating: o.vote_average ? String(Math.round(o.vote_average * 10) / 10) : '',
      poster: o.poster_path ? IMG + o.poster_path : '',
      backdrop: o.backdrop_path ? IMG_BIG + o.backdrop_path : ''
    };
  }

  /* ---------------------------------------------------------------- API --- */
  App.tmdb = {
    /* metadados de um item do catalogo (movie/series). Nunca rejeita: resolve null. */
    lookup: function (item) {
      if (!item || (item.t !== 'movie' && item.t !== 'series')) return Promise.resolve(null);
      var titulo = limparNome(item.n, item.y);
      if (!titulo) return Promise.resolve(null);
      var k = chaveDe(item);
      if (Object.prototype.hasOwnProperty.call(mem, k)) return Promise.resolve(mem[k]);

      var noCache = doCache(k);
      if (noCache !== undefined) { mem[k] = noCache; return Promise.resolve(noCache); }

      if (!App.isOnline()) return Promise.resolve(null);
      return buscar(item).then(function (d) {
        mem[k] = d || null;
        guardar(k, d);
        return d || null;
      }, function (e) {
        /* falha de rede/limite nao fica gravada: a proxima abertura tenta de novo */
        App.log('tmdb', e && e.code, e && e.status);
        return null;
      });
    },

    /* Preenche itens do catalogo sem bloquear a tela (usado onde a sinopse aparece
       junto com a lista). Silencioso de proposito. */
    preload: function (items, limite) {
      var lista = (items || []).slice(0, limite || 6), i;
      for (i = 0; i < lista.length; i++) if (lista[i]) App.tmdb.lookup(lista[i]);
    },

    setKey: function (k) { App.store.set('tmdbKey', k || ''); mem = {}; },
    setToken: function (t) { App.store.set('tmdbToken', t || ''); mem = {}; },
    hasKey: function () { return !!(chaveApi() || tokenApi()); },

    /* so para diagnostico/testes */
    limparNome: limparNome,
    clearCache: function () {
      mem = {};
      try {
        var chaves = [], i, k;
        for (i = 0; i < localStorage.length; i++) {
          k = localStorage.key(i);
          if (k && k.indexOf('sl.tmdb.') === 0) chaves.push(k);
        }
        chaves.forEach(function (k2) { localStorage.removeItem(k2); });
      } catch (e) { /* ignore */ }
    },
    cached: function () { return Object.keys(mem).length; }
  };
})(window);
