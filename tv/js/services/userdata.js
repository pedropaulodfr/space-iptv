/* Favoritos e historico, sempre vinculados a lista de origem */
(function (g) {
  'use strict';
  var App = g.App, MAXH = 60;

  function lid() { return App.catalog.listId || (App.lists.active() || {}).id || ''; }
  function key(t, id) { return lid() + '|' + t + '|' + id; }

  var numMap = null;   /* cache: "tipo|id" -> numero do atalho (1..9) */

  App.favs = {
    has: function (it) { return !!App.store.get('favs', {})[key(it.t, it.id)]; },
    toggle: function (it) {
      var f = App.store.get('favs', {}), k = key(it.t, it.id), on;
      if (f[k]) { delete f[k]; on = false; }
      else { f[k] = { t: it.t, id: it.id, n: it.n, l: it.l || '', ts: Date.now() }; on = true; }
      App.store.set('favs', f);
      numMap = null;
      App.bus.emit('favs', { item: it, on: on });
      return on;
    },
    /* itens favoritos da lista ativa (resolvidos no catalogo quando possivel) */
    list: function (type) {
      var f = App.store.get('favs', {}), pre = lid() + '|', out = [], k, r, it;
      for (k in f) {
        if (k.indexOf(pre) !== 0) continue;
        r = f[k];
        if (type && r.t !== type) continue;
        it = App.catalog.find(r.t, r.id);
        out.push({ ts: r.ts, it: it || { t: r.t, id: r.id, n: r.n, ns: App.norm(r.n), l: r.l, c: '', missing: true } });
      }
      out.sort(function (a, b) { return b.ts - a.ts; });
      var lista = out.map(function (o) { return o.it; });
      return App.parental ? App.parental.filter(lista) : lista;
    },

    /* canais favoritos da lista ativa, na mesma ordem do filtro "Canais" da tela de Favoritos */
    liveList: function () {
      return App.favs.list('live').filter(function (it) { return !it.missing; });
    },
    /* mapa "tipo|id" -> numero de atalho (1..9) dos nove primeiros canais favoritos */
    nums: function () {
      if (numMap) return numMap;
      numMap = {};
      App.favs.liveList().slice(0, 9).forEach(function (it, i) { numMap[it.t + '|' + it.id] = i + 1; });
      return numMap;
    },
    /* numero do atalho do item (0 = nenhum) */
    num: function (it) { if (!it) return 0; return App.favs.nums()[it.t + '|' + it.id] || 0; },
    /* canal favorito associado a tecla n (1..9) -> item ou null */
    byNumber: function (n) { return (n >= 1 && n <= 9) ? (App.favs.liveList()[n - 1] || null) : null; }
  };

  /* a numeracao depende da lista ativa e dos favoritos: qualquer mudanca invalida o cache */
  App.bus.on('favs', function () { numMap = null; });
  App.bus.on('catalog', function () { numMap = null; });

  App.hist = {
    /* registra posicao. ep: {id,e,s,title,x,url} para series */
    record: function (item, ep, pos, dur) {
      var h = App.store.get('hist', []), k = key(item.t, item.id), i, rec;
      for (i = 0; i < h.length; i++) if (h[i].k === k) { h.splice(i, 1); break; }
      rec = { k: k, list: lid(), t: item.t, id: item.id, n: item.n, l: item.l || '', ep: ep || null, pos: Math.floor(pos || 0), dur: Math.floor(dur || 0), ts: Date.now() };
      h.unshift(rec);
      if (h.length > MAXH) h.length = MAXH;
      App.store.set('hist', h);
    },
    get: function (item) {
      var h = App.store.get('hist', []), k = key(item.t, item.id), i;
      for (i = 0; i < h.length; i++) if (h[i].k === k) return h[i];
      return null;
    },
    remove: function (item) {
      App.store.set('hist', App.store.get('hist', []).filter(function (r) { return r.k !== key(item.t, item.id); }));
    },
    /* filmes/episodios a meio caminho da lista ativa */
    continueList: function () {
      var l = lid();
      return App.store.get('hist', []).filter(function (r) {
        return r.list === l && r.t !== 'live' && r.pos > 10 && !(r.dur > 0 && r.pos / r.dur > 0.95);
      });
    },
    lastLive: function () {
      var l = lid(), h = App.store.get('hist', []), i;
      for (i = 0; i < h.length; i++) if (h[i].list === l && h[i].t === 'live') return h[i];
      return null;
    }
  };
})(window);
