/* Acoes de abrir/reproduzir + tela de detalhes (filme e serie com temporadas/episodios) */
(function (g) {
  'use strict';
  var App = g.App;

  function curList() { return App.lists.get(App.catalog.listId) || App.lists.active(); }
  function fail(e) { App.toast(App.friendly(e && e.code ? e : { code: 'network' }), 3500); }

  var A = App.actions = {
    toggleFav: function (it) {
      if (it.missing) return;
      var on = App.favs.toggle(it);
      App.toast(on ? '★ Adicionado aos favoritos' : 'Removido dos favoritos');
      return on;
    },

    open: function (it, ctx) {
      if (it.missing) {
        var real = App.catalog.find(it.t, it.id);
        if (!real) return App.toast('Este item não está na lista atual. Atualize a lista.', 3500);
        it = real;
      }
      return App.parental.guard(it).then(function (ok) {
        if (!ok) return;
        if (it.t === 'live') return A.playLive(it, ctx && ctx.items, ctx && ctx.onClose);
        return A.details(it);
      });
    },

    /* Atalho numerico (1..9): abre o canal favorito correspondente de qualquer tela.
       Devolve true quando havia um favorito associado a tecla. */
    playFavNumber: function (n) {
      var it = App.favs.byNumber(n);
      if (!it) return false;
      if (App.parental.locked() && App.parental.isAdult(it)) { App.toast('Conteúdo adulto bloqueado', 2200); return true; }
      A.playLive(it, App.catalog.items('live', it.c));
      return true;
    },

    playLive: function (it, items, onClose) {
      return App.parental.guard(it).then(function (ok) {
        if (!ok) return;
        var list = curList(), idx = items ? items.indexOf(it) : -1;
        return App.catalog.urls(it, list).then(function (urls) {
          App.player.play({
            item: it, list: list, urls: urls, live: true,
            chans: items && idx >= 0 ? { items: items, index: idx } : null, onClose: onClose
          });
        });
      }).then(null, fail);
    },

    playMovie: function (it, onClose) {
      return App.parental.guard(it).then(function (ok) {
        if (!ok) return;
        var list = curList(), h = App.hist.get(it), start = h && h.pos > 10 && !(h.dur && h.pos / h.dur > 0.95) ? h.pos : 0;
        return App.catalog.urls(it, list).then(function (urls) {
          App.player.play({ item: it, list: list, urls: urls, live: false, startAt: start, onClose: onClose });
        });
      }).then(null, fail);
    },

    playEpisode: function (it, ep, sn, onClose) {
      return App.parental.guard(it).then(function (ok) {
        if (!ok) return;
        var list = curList(), h = App.hist.get(it), start = h && h.ep && h.ep.id === ep.id && h.pos > 10 && !(h.dur && h.pos / h.dur > 0.95) ? h.pos : 0;
        var e = { id: ep.id, e: ep.e, s: sn, title: ep.title, x: ep.x, url: ep.url };
        return App.catalog.urls(it, list, e).then(function (urls) {
          App.player.play({
            item: it, list: list, ep: e, urls: urls, live: false, startAt: start, onClose: onClose,
            title: function (i) { return i.n; },
            sub: function () { return 'T' + sn + ' • E' + ep.e + (ep.title ? ' — ' + ep.title : ''); }
          });
        });
      }).then(null, fail);
    },

    /* retoma a partir de uma entrada do historico */
    resume: function (h) {
      var it = App.catalog.find(h.t, h.id);
      if (!it) return App.toast('Este item não está na lista atual. Atualize a lista.', 3500);
      return App.parental.guard(it).then(function (ok) {
        if (!ok) return;
        if (h.t === 'live') return A.playLive(it, App.catalog.items('live', it.c));
        if (h.t === 'movie') return A.playMovie(it);
        return A.details(it, h.ep);
      });
    },

    /* ---------- detalhes ---------- */
    details: function (it, resumeEp) {
      var list = curList(), isSeries = it.t === 'series';
      var ov = App.el('div', 'overlay details');
      var bg = App.el('div', 'det-bg'), shade = App.el('div', 'det-shade'), main = App.el('div', 'det-main');
      ov.appendChild(bg); ov.appendChild(shade); ov.appendChild(main);
      var poster = App.el('div', 'det-poster'); poster.appendChild(App.el('div', 'ph', ''));
      main.appendChild(poster);
      var info = App.el('div', 'det-info'); main.appendChild(info);
      var h1 = App.el('h1', null, it.n), meta = App.el('div', 'det-meta'), plot = App.el('div', 'det-plot');
      info.appendChild(h1); info.appendChild(meta); info.appendChild(plot);
      if (isSeries) plot.style.maxHeight = '90px';

      function setImg(url) {
        if (!/^https?:\/\//i.test(url || '')) return;
        App.clear(poster);
        var im = document.createElement('img'); im.alt = ''; im.onerror = function () { if (im.parentNode) im.parentNode.removeChild(im); };
        im.src = url; poster.appendChild(im);
      }
      function setBg(url) { if (/^https?:\/\//i.test(url || '')) bg.style.backgroundImage = 'url("' + url.replace(/["()\\]/g, '') + '")'; }
      function badges(o) {
        App.clear(meta);
        [o.y, o.g, o.dur, o.r && o.r !== '0' ? '★ ' + o.r : ''].forEach(function (v) { if (v) meta.appendChild(App.el('span', 'badge', v)); });
      }
      var m = { y: it.y, g: it.g, dur: it.d ? Math.round(it.d / 60) + ' min' : '', r: it.r };
      badges(m); plot.textContent = it.p || '';
      setImg(it.l); setBg(it.bd || it.l);

      /* Sinopse do TMDb: preenche o que a lista nao trouxe (M3U quase nunca traz plot).
         O texto do provedor, quando existir, sempre vence - por isso so escreve se vazio. */
      if (App.tmdb) App.tmdb.lookup(it).then(function (t) {
        if (!t) return;
        if (!plot.textContent && t.overview) plot.textContent = t.overview;
        if (!it.l && t.poster) setImg(t.poster);
        if (!it.bd && t.backdrop) setBg(t.backdrop);
        if (!it.y && t.year) badges({ y: t.year, g: it.g, r: it.r || t.rating });
      });

      /* botoes */
      var btnPlay = App.ui.btn('▶  Assistir', 'primary'), btnFav = App.ui.btn(''), btnBack = App.ui.btn('Voltar');
      function favLabel() { btnFav.textContent = App.favs.has(it) ? '★  Nos favoritos' : '☆  Favoritar'; }
      favLabel();
      var h = App.hist.get(it);
      if (!isSeries && h && h.pos > 10 && !(h.dur && h.pos / h.dur > 0.95)) btnPlay.textContent = '▶  Continuar (' + App.fmtTime(h.pos) + ')';
      var row = App.el('div', 'det-btns'); row.appendChild(btnPlay); row.appendChild(btnFav); row.appendChild(btnBack); info.appendChild(row);
      var btns = App.ui.group([btnPlay, btnFav, btnBack], true);

      var seasonsEl = null, chips = null, epList = null, zone = 0, data = null, seasonIdx = 0, chipNodes = [];
      var close;

      function refreshAfterPlay() { var hh = App.hist.get(it); if (!isSeries && hh && hh.pos > 10) btnPlay.textContent = '▶  Continuar (' + App.fmtTime(hh.pos) + ')'; if (epList) epList.refreshAll(); }

      btnBack._act = function () { close(); };
      btnFav._act = function () { A.toggleFav(it); favLabel(); };
      btnPlay._act = function () {
        if (!isSeries) return A.playMovie(it, refreshAfterPlay);
        if (!data || !data.seasons.length) return App.toast('Nenhum episódio disponível.');
        var hh = App.hist.get(it), s = data.seasons[seasonIdx], ep = s.eps[0], sn = s.n;
        if (hh && hh.ep) { data.seasons.forEach(function (ss) { ss.eps.forEach(function (e) { if (e.id === hh.ep.id) { ep = e; sn = ss.n; } }); }); }
        A.playEpisode(it, ep, sn, refreshAfterPlay);
      };

      if (isSeries) {
        seasonsEl = App.el('div', 'seasons'); info.appendChild(seasonsEl);
        var wrap = App.el('div', 'ep-list'), eroot = App.el('div'); wrap.appendChild(eroot); info.appendChild(wrap);
        epList = new App.VList({
          root: eroot, cols: 1, rowH: 76, empty: 'Carregando episódios...',
          render: function (e, i, cell) {
            var c = App.el('div', 'card ep'), sn = data.seasons[seasonIdx].n, hh = App.hist.get(it);
            c.appendChild(App.el('div', 'no', 'E' + App.pad(e.e)));
            c.appendChild(App.el('div', 'nm', e.title || ('Episódio ' + e.e)));
            var watched = hh && hh.ep && hh.ep.id === e.id;
            c.appendChild(App.el('div', 'du', (watched ? 'em andamento • ' : '') + (e.dur || '')));
            cell.appendChild(c);
          },
          onSelect: function (e) { A.playEpisode(it, e, data.seasons[seasonIdx].n, refreshAfterPlay); }
        });
        epList.setItems([]);
        epList.empty.style.display = 'block'; epList.empty.textContent = 'Carregando episódios...';
        App.catalog.seriesInfo(it, list).then(function (r) {
          data = r;
          if (r.info) {
            badges({ y: r.info.y || it.y, g: r.info.g || it.g, r: r.info.r || it.r });
            if (r.info.plot) plot.textContent = r.info.plot;
            if (r.info.l) setImg(r.info.l); if (r.info.bd) setBg(r.info.bd);
          }
          if (!r.seasons.length) { epList.empty.textContent = 'Nenhum episódio encontrado para esta série.'; return; }
          r.seasons.forEach(function (s, i) {
            var c = App.ui.btn('Temporada ' + s.n); c.style.height = '52px'; c.style.padding = '0 24px'; c.style.fontSize = '16px';
            c._act = function () { setSeason(i); zoneTo(2); };
            seasonsEl.appendChild(c); chipNodes.push(c);
          });
          chips = App.ui.group(chipNodes, true);
          var si = 0;
          if (resumeEp) r.seasons.forEach(function (s, i) { if (s.n === resumeEp.s) si = i; });
          setSeason(si);
          if (resumeEp) { r.seasons[si].eps.forEach(function (e, i) { if (e.id === resumeEp.id) epList.idx = i; }); epList.scrollTo(epList.idx); epList.render(); }
        }).then(null, function (e) { epList.empty.textContent = App.friendly(e && e.code ? e : { code: 'network' }); });
      } else {
        App.catalog.vodInfo(it, list).then(function (r) {
          if (!r) return;
          badges({ y: r.y || it.y, g: r.g || it.g, dur: r.dur || m.dur, r: r.r || it.r });
          if (r.plot) plot.textContent = r.plot;
          if (r.l) setImg(r.l); if (r.bd) setBg(r.bd);
        });
      }

      function setSeason(i) {
        seasonIdx = i;
        chipNodes.forEach(function (c, k) { c.classList[k === i ? 'add' : 'remove']('primary'); });
        if (chips) chips.i = i;
        epList.setItems(data.seasons[i].eps);
      }
      function zoneTo(z) {
        if (z === 1 && !chips) z = btns ? 0 : 0;
        if (z === 2 && !(epList && epList.items.length)) z = chips ? 1 : 0;
        btns.blur(); if (chips) chips.blur(); if (epList) epList.blur();
        zone = z;
        if (z === 0) btns.focus(); else if (z === 1) chips.focus(chips.i); else epList.focus();
      }

      close = App.ui.open(ov, {
        key: function (a) {
          if (a === 'back') { close(); return true; }
          if (a === 'yellow' || a === 'hold') { btnFav._act(); return true; }
          if (zone === 0) {
            if (btns.key(a)) return true;
            if (a === 'down' && isSeries) zoneTo(chips ? 1 : 2);
          } else if (zone === 1) {
            if (chips.key(a)) return true;
            if (a === 'up') zoneTo(0); else if (a === 'down') zoneTo(2);
          } else {
            if (a === 'hold' || a === 'yellow') return true;
            if (epList.key(a)) return true;
            if (a === 'up') zoneTo(chips ? 1 : 0);
          }
          return true;
        }
      });
      btns.focus(0);
    }
  };
})(window);
