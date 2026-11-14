/* Catalogo da lista ativa: cache em IndexedDB, atualizacao, indices e busca em memoria */
(function (g) {
  'use strict';
  var App = g.App, STALE = 6 * 3600 * 1000, seriesCache = {}, loading = false;
  var TYPES = ['live', 'movie', 'series'];

  function index(d) {
    d.by = { live: {}, movie: {}, series: {} }; d.map = { live: {}, movie: {}, series: {} };
    TYPES.forEach(function (t) {
      var by = d.by[t], map = d.map[t];
      by['*'] = d[t];
      d[t].forEach(function (it) { (by[it.c] = by[it.c] || []).push(it); map[it.id] = it; });
      d.cats[t] = (d.cats[t] || []).filter(function (c) { return by[c.id] && by[c.id].length; });
    });
    return d;
  }
  function blank() { return index({ live: [], movie: [], series: [], cats: { live: [], movie: [], series: [] }, warns: [] }); }

  /* M3U em fluxo: baixa e interpreta em pedacos, sem montar o arquivo inteiro na memoria */
  function loadM3u(list, c, prog) {
    if (!g.TextDecoder) {
      return App.http.get(c.url, { timeout: 180000 }).then(function (t) { prog(0.5); return App.m3u.parse(t); });
    }
    var parser = new App.m3u.Parser(), dec = new g.TextDecoder('utf-8'), est = list.bytes || 0;
    return App.http.stream(c.url, {
      onChunk: function (u8) { parser.feed(dec.decode(u8, { stream: true })); },
      onProgress: function (loaded, total) {
        var t = total || est;
        prog(t ? Math.min(0.95, loaded / t * 0.95) : 0.95 * (1 - Math.exp(-loaded / 52428800)));
      }
    }).then(function (bytes) {
      parser.feed(dec.decode());
      var r = parser.end(); r.bytes = bytes; return r;
    });
  }

  /* M3U enviado como arquivo: o texto esta no IndexedDB local, sem rede. */
  function loadM3uFile(list, prog) {
    return App.lists.readM3uFile(list).then(function (text) {
      prog(0.25);
      return App.m3u.parse(text).then(function (r) {
        r.bytes = text.length;
        prog(0.95);
        return r;
      });
    });
  }

  /* Episodios M3U vao para blocos separados no IndexedDB (so lidos ao abrir a serie) */
  function saveCache(list, d, now) {
    var id = list.id, packed = d.epPacked || [], C = App.m3u.EPCHUNK, n = Math.ceil(packed.length / C), k = 0;
    delete d.epPacked;
    return App.idb.get('cat.' + id).then(function (old) {
      var oldN = old && old.epc || 0;
      return new Promise(function (res) {
        (function next() {
          if (k >= n) return res();
          App.idb.put('eps.' + id + '.' + k, packed.slice(k * C, (k + 1) * C)).then(function () { k++; setTimeout(next, 0); });
        })();
      }).then(function () {
        packed = null;
        return App.idb.put('cat.' + id, { ver: 2, updated: now, epc: n, data: d });
      }).then(function () {
        var j, ps = []; for (j = n; j < oldN; j++) ps.push(App.idb.del('eps.' + id + '.' + j));
        return Promise.all(ps);
      });
    });
  }

  App.catalog = {
    data: blank(), listId: null, updated: 0,

    /* apaga o cache de uma lista (catalogo e blocos de episodios) */
    dropCache: function (id) {
      return App.idb.get('cat.' + id).then(function (old) {
        var ps = [App.idb.del('cat.' + id)], j;
        for (j = 0; j < (old && old.epc || 0); j++) ps.push(App.idb.del('eps.' + id + '.' + j));
        return Promise.all(ps);
      });
    },
    isLoading: function () { return loading; },
    hasData: function () { var d = App.catalog.data; return d.live.length + d.movie.length + d.series.length > 0; },

    /* carrega do cache local (rapido, funciona offline) */
    init: function (list) {
      seriesCache = {};
      if (!list) { App.catalog.data = blank(); App.catalog.listId = null; App.bus.emit('catalog'); return Promise.resolve(false); }
      return App.idb.get('cat.' + list.id).then(function (c) {
        App.catalog.listId = list.id;
        if (c && c.data) { App.catalog.data = index(c.data); App.catalog.updated = c.updated || 0; }
        else { App.catalog.data = blank(); App.catalog.updated = 0; }
        App.bus.emit('catalog');
        return !!(c && c.data);
      });
    },

    needsRefresh: function () { return !App.catalog.updated || Date.now() - App.catalog.updated > STALE; },

    /* baixa e substitui os dados. Em caso de falha mantem o cache anterior. */
    refresh: function (list) {
      if (loading || !list) return Promise.resolve(false);
      loading = true; App.bus.emit('catalog:loading', 0);
      var lastP = -1;
      var prog = function (p) { var q = Math.round(p * 100); if (q !== lastP) { lastP = q; App.bus.emit('catalog:loading', p); } };
      return App.lists.creds(list).then(function (c) {
        if (list.type === 'm3u') return list.source === 'file' ? loadM3uFile(list, prog) : loadM3u(list, c, prog);
        return App.xtream.fetchAll(c, prog);
      }).then(function (d) {
        var now = Date.now();
        d.warns = d.warns || [];
        return saveCache(list, d, now).then(function () {
          App.lists.patch(list.id, { updated: now, error: '', bytes: d.bytes || 0 });
          seriesCache = {};
          if (App.lists.active() && App.lists.active().id === list.id) {
            App.catalog.data = index(d); App.catalog.listId = list.id; App.catalog.updated = now;
          }
          loading = false; App.bus.emit('catalog:loading', 1); App.bus.emit('catalog'); App.bus.emit('catalog:done', { list: list, warns: d.warns });
          return true;
        });
      }).then(null, function (e) {
        loading = false;
        var msg = App.friendly(e);
        App.lists.patch(list.id, { error: msg });
        App.log('falha ao carregar lista', e && e.code, e && e.status);
        App.bus.emit('catalog:loading', -1); App.bus.emit('catalog:error', { list: list, message: msg });
        return false;
      });
    },

    items: function (type, cat) {
      var d = App.catalog.data, arr = (d.by[type] && d.by[type][cat || '*']) || [];
      return App.parental ? App.parental.filter(arr) : arr;
    },
    find: function (type, id) { return App.catalog.data.map[type][id] || null; },

    search: function (q, types, limit) {
      var toks = App.norm(q).split(/\s+/).filter(Boolean), out = { live: [], movie: [], series: [] };
      if (!toks.length) return out;
      limit = limit || 200;
      (types || TYPES).forEach(function (t) {
        var arr = App.catalog.data[t], i, it, pre = [], rest = [], ok, k;
        for (i = 0; i < arr.length && pre.length + rest.length < limit * 2; i++) {
          it = arr[i]; ok = true;
          for (k = 0; k < toks.length; k++) if (it.ns.indexOf(toks[k]) < 0) { ok = false; break; }
          if (ok) (it.ns.indexOf(toks[0]) === 0 ? pre : rest).push(it);
        }
        out[t] = App.parental ? App.parental.filter(pre.concat(rest).slice(0, limit)) : pre.concat(rest).slice(0, limit);
      });
      return out;
    },

    /* detalhes de serie: Xtream consulta o servidor; M3U ja tem os episodios */
    seriesInfo: function (item, list) {
      var m3uInfo = { plot: item.p || '', g: item.g || '', y: item.y || '', r: '', l: item.l, bd: '' };
      if (item.eps) return Promise.resolve({ info: m3uInfo, seasons: item.eps });   /* cache antigo */
      if (item.ek != null) {
        return App.idb.get('eps.' + list.id + '.' + item.ek).then(function (arr) {
          var s = arr && arr[item.ei];
          if (!s) throw { code: 'parse' };
          return { info: m3uInfo, seasons: App.m3u.unpack(s) };
        });
      }
      var k = list.id + '|' + item.id;
      if (seriesCache[k]) return Promise.resolve(seriesCache[k]);
      return App.lists.creds(list).then(function (c) { return App.xtream.seriesInfo(c, item.id); }).then(function (r) { seriesCache[k] = r; return r; });
    },
    vodInfo: function (item, list) {
      if (list.type !== 'xtream') return Promise.resolve(null);
      return App.lists.creds(list).then(function (c) { return App.xtream.vodInfo(c, item.id); }).then(null, function () { return null; });
    },

    /* URLs de reproducao (em ordem de tentativa). ep so para series. */
    urls: function (item, list, ep) {
      return App.lists.creds(list).then(function (c) {
        if (list.type === 'm3u') return [ep ? ep.url : item.u];
        if (ep) return App.xtream.episodeUrls(c, ep.id, ep.x);
        if (item.t === 'live') return App.xtream.liveUrls(c, item.id);
        return App.xtream.movieUrls(c, item.id, item.x);
      });
    }
  };
})(window);
