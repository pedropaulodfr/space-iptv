/* Filmes e Séries: grade de pôsteres + tela de detalhes com episódios. */
(function (g) {
  'use strict';
  var App = g.App;
  var U = App.m.ui;
  App.m.screens = App.m.screens || {};

  /* Quantas colunas de poster cabem. Usa a largura UTIL (no projetor existe a
     trilha lateral) e um minimo por cartao, entao a grade se adapta sozinha. */
  function cols() {
    var w = U.contentWidth();
    var min = App.m.tv ? 168 : 104;
    var n = Math.floor(w / min);
    if (n < 3) n = 3;
    if (n > 9) n = 9;
    return n;
  }

  /* O catalogo devolve temporadas em DUAS formas:
     - M3U (episodios empacotados): array [{n, eps:[...]}]
     - Xtream (get_series_info):    objeto {temporada: [episodios]}
     Normaliza para { numeroDaTemporada: [episodios] }. */
  function normalizeSeasons(s) {
    var out = {};
    if (!s) return out;
    if (Array.isArray(s)) {
      s.forEach(function (x) {
        if (x && x.eps) out[x.n == null ? 0 : x.n] = x.eps;
      });
      return out;
    }
    Object.keys(s).forEach(function (k) {
      var v = s[k];
      if (v && v.eps) out[v.n == null ? k : v.n] = v.eps;
      else if (Array.isArray(v)) out[k] = v;
    });
    return out;
  }

  function seasonKeys(map) {
    return Object.keys(map).sort(function (a, b) { return Number(a) - Number(b); });
  }

  App.m.screens.vod = function (arg) {
    var type = (arg && arg.type) || 'movie';
    var pad = App.m.tv ? 20 : 14;
    var root = App.el('div');
    root.style.cssText = 'height:100%;display:flex;flex-direction:column';

    var head = App.el('div');
    head.style.cssText = 'padding:6px ' + pad + 'px 0';
    var chipsBox = App.el('div');
    head.appendChild(chipsBox);

    var gridHost = App.el('div');
    gridHost.style.cssText = 'flex:1;min-height:0;padding:0 ' + pad + 'px';
    root.appendChild(head);
    root.appendChild(gridHost);

    var cat = arg && arg.cat ? arg.cat : '*';
    var items = [];

    function catName(id) {
      var a = (App.catalog.data.cats || {})[type] || [], i;
      for (i = 0; i < a.length; i++) if (a[i].id === id) return a[i].name;
      return '';
    }

    function paintChips() {
      var cats = App.parental.filterCats(type);
      var all = [{ id: '*', name: 'Todos (' + App.catalog.data[type].length + ')' }]
        .concat(cats.map(function (c) { return { id: c.id, name: c.name }; }));
      App.clear(chipsBox);
      var box = U.chips(all, cat, function (c) {
        cat = c.id;
        paintChips();
        paintGrid();
        gridHost.scrollTop = 0;
      });
      box.style.paddingBottom = '8px';
      chipsBox.appendChild(box);
    }

    function paintGrid() {
      items = App.catalog.items(type, cat);
      App.clear(gridHost);

      if (!items.length) {
        gridHost.appendChild(U.empty('Nada aqui',
          App.parental.locked() ? 'Conteúdo adulto oculto pelo controle parental.' : 'Esta categoria está vazia.'));
        return;
      }

      var n = cols();
      var gap = App.m.tv ? 12 : 10;
      var cellW = Math.floor((U.contentWidth() - pad * 2 - (n - 1) * gap) / n);
      var rowH = Math.floor(cellW * 1.5) + gap;
      var rows = Math.ceil(items.length / n);

      U.vscroll(gridHost, {
        count: rows,
        rowH: rowH,
        render: function (r) {
          var row = App.el('div');
          row.style.cssText = 'display:flex;align-items:flex-start';
          for (var i = 0; i < n; i++) {
            var it = items[r * n + i];
            if (!it) break;
            var cell = U.poster(it, {
              onOpen: function (x) {
                App.m.shell.push('details', { item: x, type: type });
              }
            });
            cell.style.width = cellW + 'px';
            cell.style.flex = 'none';
            cell.style.marginRight = (i < n - 1) ? gap + 'px' : '0';
            row.appendChild(cell);
          }
          return row;
        }
      });
    }

    function paint() {
      paintChips();
      paintGrid();
    }

    paint();
    App.bus.on('catalog', paint);

    return {
      el: root,
      destroy: function () { App.bus.off('catalog', paint); },
      refresh: paint
    };
  };

  /* ------------------------------------------------------------- detalhes --- */
  App.m.screens.details = function (arg) {
    var item = arg.item;
    var list = App.lists.active();
    var root = App.el('div');
    var scroll = App.el('div', 'scroll narrow');
    root.appendChild(scroll);

    var seasons = null;
    var season = null;
    /* Metadados do TMDb (sinopse/poster/nota) preenchem o que a lista nao trouxe.
       Referencias aos nos ficam aqui para atualizar a tela sem remonta-la. */
    var tmdbData = null, tmdbAsked = false;
    var artBox = null, plotSlot = null, metaBox = null;
    var info = {};

    function play(ep) {
      App.m.player.open(item, { list: list, ep: ep || null });
    }

    function addArt(url) {
      if (!artBox || artBox.firstChild || !/^https?:\/\//i.test(url || '')) return;
      var img = new Image();
      img.src = url;
      /* absoluta: a caixa do cartaz tem altura 0 e o espaco vem do padding-bottom
         (a WebView 71 nao entende aspect-ratio) */
      img.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover';
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      artBox.appendChild(img);
    }

    function header(info) {
      var wrap = App.el('div');
      wrap.style.cssText = 'display:flex;padding-top:8px';

      var artW = App.m.tv ? 168 : 116;
      var art = App.el('div');
      art.style.cssText = 'width:' + artW + 'px;flex:none;border-radius:14px;overflow:hidden;'
        + 'background:rgba(255,255,255,.06);position:relative;height:0;padding-bottom:' + Math.round(artW * 1.5) + 'px';
      artBox = art;
      addArt(item.l || (tmdbData && tmdbData.poster) || '');
      wrap.appendChild(art);

      var tx = App.el('div');
      tx.style.cssText = 'flex:1;min-width:0;margin-left:' + (App.m.tv ? 20 : 14) + 'px';
      tx.appendChild(App.el('h1', null, item.n || 'Sem nome'));

      var meta = [];
      var ano = item.y || (tmdbData && tmdbData.year) || '';
      var nota = item.r || (tmdbData && tmdbData.rating) || '';
      if (ano) meta.push(ano);
      if (nota) meta.push('★ ' + nota);
      if (item.g) meta.push(item.g);
      if (info && info.d) meta.push(info.d + ' min');
      metaBox = null;
      if (meta.length) {
        var m = App.el('div', 'muted small');
        m.style.marginTop = '6px';
        m.textContent = meta.join(' • ');
        tx.appendChild(m);
        metaBox = m;
      }

      var btnRow = App.el('div');
      btnRow.style.cssText = 'display:flex;margin-top:14px';

      var h = App.hist.get(item);
      var label = (h && h.pos > 10000) ? 'Continuar' : 'Assistir';
      if (item.t === 'series') label = 'Assistir 1º episódio';

      var b = U.btn(label, 'primary', function () {
        if (item.t !== 'series') return play(null);
        var eps = seasons && seasons[season];
        if (!eps || !eps.length) return App.toast('Carregando episódios…', 1500);
        play(eps[0]);
      });
      b.classList.add('sm');
      /* No projetor um botao de 600px de largura fica desproporcional: fica do
         tamanho do texto, com uma area minima confortavel para o controle. */
      if (App.m.tv) { b.style.flex = '0 0 auto'; b.style.minWidth = '260px'; }
      else b.style.flex = '1';
      btnRow.appendChild(b);

      var fav = U.iconBtn(App.favs.has(item) ? 'star' : 'star', function () {
        var on = App.favs.toggle(item);
        fav.style.color = on ? '#ffcf5c' : '';
        App.toast(on ? 'Adicionado aos favoritos' : 'Removido dos favoritos', 1500);
      }, 'Favorito');
      if (App.favs.has(item)) fav.style.color = '#ffcf5c';
      fav.style.marginLeft = '8px';
      btnRow.appendChild(fav);

      tx.appendChild(btnRow);
      wrap.appendChild(tx);
      return wrap;
    }

    /* A sinopse mora num slot fixo logo abaixo do cabecalho: assim o texto pode chegar
       depois (TMDb) sem baguncar a ordem da tela. */
    function setPlot(texto) {
      if (!plotSlot) return;
      App.clear(plotSlot);
      var p = String(texto || '').trim();
      if (!p) return;
      plotSlot.style.cssText = 'margin-top:16px';
      plotSlot.appendChild(U.sectionTitle('Sinopse'));
      var t = App.el('div', 'small');
      t.style.cssText = 'color:rgba(245,247,255,.82);line-height:1.5';
      t.textContent = p;
      plotSlot.appendChild(t);
    }

    /* Pede ao TMDb uma vez por tela. O texto do provedor (Xtream) sempre vence. */
    function askTmdb() {
      if (tmdbAsked || !App.tmdb) return;
      tmdbAsked = true;
      App.tmdb.lookup(item).then(function (t) {
        if (!t) return;
        tmdbData = t;
        if (!item.l) addArt(t.poster);
        if (metaBox) {
          var bits = [], ano = item.y || t.year, nota = item.r || t.rating;
          if (ano) bits.push(ano);
          if (nota) bits.push('★ ' + nota);
          if (item.g) bits.push(item.g);
          if (bits.length) metaBox.textContent = bits.join(' • ');
        }
        var prov = (info && info.plot) || item.p || '';
        if (!prov && t.overview) setPlot(t.overview);
      });
    }

    function episodesBox() {
      var box = App.el('div');
      box.style.cssText = 'margin-top:18px';
      if (!seasons) return box;

      var keys = seasonKeys(seasons);
      if (!keys.length) return box;
      season = season || keys[0];

      box.appendChild(U.sectionTitle('Episódios'));
      var chips = U.chips(keys.map(function (k) { return { id: k, name: 'Temporada ' + k }; }), season, function (c) {
        season = c.id;
        paintEpisodes();
      });
      box.appendChild(chips);

      var host = App.el('div');
      box.appendChild(host);

      function paintEpisodes() {
        var list2 = seasons[season] || [];
        var chipsEls = chips.querySelectorAll('.chip');
        for (var i = 0; i < chipsEls.length; i++) {
          chipsEls[i].classList.toggle('on', chipsEls[i].textContent === 'Temporada ' + season);
        }
        App.clear(host);
        if (!list2.length) {
          host.appendChild(U.empty('Sem episódios', 'Esta temporada não tem episódios listados.'));
          return;
        }
        var items = list2.map(function (e) {
          return {
            id: e.id, t: 'series', n: (e.e ? e.e + '. ' : '') + (e.title || 'Episódio'), l: item.l, c: item.c, ns: App.norm(e.title || ''),
            _ep: e
          };
        });
        var rowH = U.rowH(76);
        var scroller = App.el('div');
        scroller.style.height = Math.min(App.m.tv ? 440 : 360, items.length * rowH) + 'px';
        host.appendChild(scroller);
        U.vscroll(scroller, {
          count: items.length,
          rowH: rowH,
          render: function (i) {
            var it = items[i];
            var row = App.el('div', 'row');
            row.appendChild(U.logo({ n: String(it._ep.e || i + 1) }, 'thumb'));
            var txt = App.el('div', 'txt');
            txt.appendChild(App.el('div', 't', it.n));
            txt.appendChild(App.el('div', 's', (it._ep.x || '').toUpperCase() + (it._ep.d ? ' • ' + it._ep.d + ' min' : '')));
            row.appendChild(txt);
            var pl = App.el('button', 'star');
            pl.innerHTML = U.ico('play');
            row.appendChild(pl);
            row.addEventListener('click', function () { play(it._ep); });
            return row;
          }
        });
        return host;
      }

      setTimeout(paintEpisodes, 0);
      return box;
    }

    function pintar() {
      scroll.appendChild(header(info));
      plotSlot = App.el('div');
      scroll.appendChild(plotSlot);
      var prov = (info && info.plot) || item.p || '';
      setPlot(prov || (tmdbData && tmdbData.overview) || '');
    }

    function paint() {
      App.clear(scroll);
      info = {};
      pintar();

      if (item.t === 'series') {
        var host = App.el('div');
        scroll.appendChild(host);
        App.catalog.seriesInfo(item, list).then(function (r) {
          info = r.info || {};
          seasons = normalizeSeasons(r.seasons);
          App.clear(scroll);
          pintar();
          scroll.appendChild(episodesBox());
        }, function () {
          App.clear(scroll);
          pintar();
          scroll.appendChild(U.empty('Não foi possível abrir a série',
            'O servidor não devolveu a lista de episódios.', 'Tentar de novo', paint));
        });
      } else if (App.catalog.vodInfo) {
        App.catalog.vodInfo(item, list).then(function (r) {
          if (!r) return;
          info = r || {};
          App.clear(scroll);
          pintar();
        });
      }
    }

    paint();
    askTmdb();

    return {
      el: root,
      destroy: function () {},
      refresh: paint
    };
  };
})(window);
