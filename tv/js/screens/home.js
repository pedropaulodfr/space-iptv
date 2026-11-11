/* Inicio: continuar assistindo, canais favoritos, filmes, series e categorias rapidas.
   So mostra o que existe na lista (nada de conteudo inventado). */
(function (g) {
  'use strict';
  var App = g.App;

  App.screens.home = function (shell) {
    var el, track, rows = [], r = 0, onFav, onCat;

    function snapshot(h) { return App.catalog.find(h.t, h.id) || { t: h.t, id: h.id, n: h.n, l: h.l, ns: '' }; }

    function build() {
      App.clear(el); rows = []; r = 0;
      var home = App.el('div', 'home'); track = App.el('div', 'home-track'); home.appendChild(track); el.appendChild(home);
      var d = App.catalog.data;

      if (!App.catalog.hasData()) {
        var m = !App.lists.active()
          ? 'Bem-vindo ao Space IPTV.\n\nNenhuma lista cadastrada ainda. Abra Configurações para adicionar uma lista M3U (URL) ou uma conta Xtream Codes.'
          : (App.catalog.isLoading() ? 'Carregando sua lista...' : 'Esta lista ainda não possui conteúdo carregado. Abra Configurações e atualize a lista.');
        var n = App.el('div', 'hero-note', m); n.style.whiteSpace = 'pre-line'; track.appendChild(n);
        return;
      }

      var cont = App.parental.filterHist(App.hist.continueList()).slice(0, 20);
      if (cont.length) add('Continuar assistindo', cont, 300, 330, function (h) {
        var it = snapshot(h), sub = h.ep ? 'T' + h.ep.s + ' • E' + h.ep.e : App.fmtTime(h.pos) + ' / ' + App.fmtTime(h.dur);
        return App.cards.poster(it, { lazy: true, sub: sub, progress: h.dur ? h.pos / h.dur : 0 });
      }, function (h) { App.actions.resume(h); }, null);

      var fl = App.favs.list('live').filter(function (i) { return !i.missing; }).slice(0, 20);
      if (fl.length) add('Canais favoritos', fl, 200, 270, function (it) { return App.cards.poster(it, { lazy: true, sub: '' }); },
        function (it) { App.actions.playLive(it, fl); }, function (it) { App.actions.toggleFav(it); });

      var liveAll = App.parental.filter(d.live).filter(function (i) { return i.l; });
      if (!liveAll.length) liveAll = App.parental.filter(d.live);
      var liveRow = liveAll.slice(0, 20);
      if (liveRow.length) add('TV ao vivo', liveRow, 200, 270, function (it) { return App.cards.poster(it, { lazy: true, sub: '' }); },
        function (it) { App.actions.playLive(it, liveRow); }, function (it) { App.actions.toggleFav(it); });

      [['movie', 'Filmes'], ['series', 'Séries']].forEach(function (p) {
        var all = App.parental.filter(d[p[0]]).filter(function (i) { return i.l; });
        if (!all.length) all = App.parental.filter(d[p[0]]);
        if (!all.length) return;
        var dated = all.filter(function (i) { return i.a > 0; }), title = p[1];
        if (dated.length > 10) { all = dated.slice().sort(function (a, b) { return b.a - a.a; }); title = p[1] + ' recentes'; }
        var list = all.slice(0, 20);
        add(title, list, 200, 330, function (it) { return App.cards.poster(it, { lazy: true }); },
          function (it) { App.actions.open(it); }, function (it) { App.actions.toggleFav(it); });
      });

      var quick = [];
      [['live', 'TV'], ['movie', 'Filmes'], ['series', 'Séries']].forEach(function (p) {
        App.parental.filterCats(p[0]).slice().sort(function (a, b) { return d.by[p[0]][b.id].length - d.by[p[0]][a.id].length; }).slice(0, 6)
          .forEach(function (c) { quick.push({ type: p[0], id: c.id, label: p[1] + ' • ' + c.name }); });
      });
      if (quick.length) add('Acesso rápido', quick, 300, 84, function (q) {
        var c = App.el('div', 'card'); c.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;padding:0 22px;font-size:17px;font-weight:500;overflow:hidden;white-space:nowrap;text-overflow:ellipsis';
        c.textContent = q.label; return c;
      }, function (q) { App.screens.setCat(q.type, q.id); shell.goto(q.type === 'live' ? 'live' : q.type === 'movie' ? 'movies' : 'series'); }, null);

      if (!rows.length) {
        track.appendChild(App.el('div', 'lock-note', App.parental.locked()
          ? 'Conteúdo adulto oculto pelo controle parental.\n\nConfigurações → Controle parental → digite a senha para liberar.'
          : 'Esta lista ainda não possui conteúdo carregado.'));
      }
    }

    function add(title, items, cw, ch, render, sel, hold) {
      var row = new App.HRow({ title: title, items: items, cardW: cw, cardH: ch, render: render, onSelect: sel, onHold: hold ? function (it, i) { hold(it, i); row.refresh(); } : null });
      track.appendChild(row.el); rows.push(row);
    }

    function scrollTo(i) { track.style.transform = 'translate3d(0,' + (-rows[i].el.offsetTop) + 'px,0)'; }

    return {
      hints: ['OK: abrir', 'AMARELO / segurar OK: favoritar'],
      mount: function (root) {
        el = root; build();
        onFav = function () { if (rows[r]) rows[r].refresh(); };
        App.bus.on('favs', onFav);
        onCat = function (p) {
          if (!el || !(p === undefined || p === 1 || p === -1)) return;
          build();
          if (App.shell.inScreen()) { if (rows.length) { rows[0].focus(); } else App.shell.toMenu(); }
        };
        App.bus.on('catalog', onCat); App.bus.on('catalog:loading', onCat);
      },
      unmount: function () { App.bus.off('favs', onFav); App.bus.off('catalog', onCat); App.bus.off('catalog:loading', onCat); rows = []; el = null; },
      enter: function () { if (!rows.length) return false; rows[r].focus(); scrollTo(r); return true; },
      key: function (a) {
        if (!rows.length) return false;
        if (rows[r].key(a)) return true;
        if (a === 'down' && r < rows.length - 1) { var i = rows[r].idx; rows[r].blur(); r++; rows[r].focus(Math.min(i, rows[r].cards.length - 1)); scrollTo(r); return true; }
        if (a === 'up' && r > 0) { var j = rows[r].idx; rows[r].blur(); r--; rows[r].focus(Math.min(j, rows[r].cards.length - 1)); scrollTo(r); return true; }
        if (a === 'up' || a === 'down') return true;
        return false;
      }
    };
  };
})(window);
