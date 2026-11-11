/* TV ao vivo, Filmes e Series: categorias a esquerda, grade virtualizada a direita */
(function (g) {
  'use strict';
  var App = g.App;
  App.screens = App.screens || {};
  var lastCat = { live: '*', movie: '*', series: '*' };

  var EMPTY = {
    live: 'Nenhum canal nesta categoria.',
    movie: 'Nenhum filme nesta categoria.',
    series: 'Nenhuma série nesta categoria.'
  };

  App.screens.browse = function (type) {
    var cats, grid, el, zone = 'cats', catItems = [], catNames = {}, selId = '*', onData, onFav, applyCat, onHealth, onHealthCfg;

    function msg(text, loading) {
      App.clear(el);
      el.appendChild(loading ? App.ui.loading(text) : App.el('div', 'hero-note', text));
    }

    /* canais realmente na tela (a grade e virtualizada: so as linhas visiveis existem) */
    function visibleItems() {
      var out = [], r, start, i, it;
      if (!grid) return out;
      for (r in grid.rows) {
        start = (+r) * grid.cols;
        for (i = 0; i < grid.cols; i++) { it = grid.items[start + i]; if (it) out.push(it); }
      }
      return out;
    }
    /* verifica primeiro o que esta a vista; com whole=true completa a categoria (fila limitada) */
    function syncHealth(whole) {
      if (type !== 'live' || !App.health || !App.health.enabled()) return;
      /* usa o id do catalogo em memoria: e a mesma chave que os cards usam para pintar */
      var list = App.catalog.listId || App.lists.active();
      App.health.observe(list, visibleItems());
      if (whole) App.health.observe(list, grid ? grid.items : []);
    }
    function showHealth(it) {
      if (!App.health) return;
      if (!App.health.enabled()) {
        return App.ui.alert('Monitoramento desligado',
          'O monitoramento da saúde dos canais está desligado.\n\nLigue em Configurações → Monitoramento da saúde dos canais.');
      }
      if (type === 'live' && it) return App.ui.alert('Saúde do canal', App.health.detail(it));
      App.ui.alert('Saúde dos canais', App.health.legend());
    }

    function build() {
      if (cats) cats.o.onFocus.cancel();
      cats = grid = null; zone = 'cats';
      App.clear(el);
      var d = App.catalog.data, total = App.parental.filter(d[type]).length;
      if (!total) {
        if (App.catalog.isLoading()) return msg('Carregando conteúdo da lista...', true);
        if (!App.lists.active()) return msg('Nenhuma lista cadastrada. Vá em Configurações para adicionar uma lista M3U ou Xtream Codes.');
        if (d[type].length && App.parental.locked()) return msg('Conteúdo adulto oculto pelo controle parental.\n\nConfigurações → Controle parental → digite a senha para liberar.');
        return msg('Esta lista não possui ' + (type === 'live' ? 'canais' : type === 'movie' ? 'filmes' : 'séries') + '.');
      }
      var wrap = App.el('div', 'split'), cp = App.el('div', 'cats glass-panel'), croot = App.el('div'), content = App.el('div', 'content'), groot = App.el('div');
      cp.appendChild(croot); content.appendChild(groot); wrap.appendChild(cp); wrap.appendChild(content); el.appendChild(wrap);
      croot.style.height = '100%';

      catNames = {};
      catItems = [{ id: '*', name: 'Todos', n: total }];
      App.parental.filterCats(type).forEach(function (c) { catNames[c.id] = c.name; catItems.push({ id: c.id, name: c.name, n: App.parental.filter(d.by[type][c.id]).length }); });
      var temSel = false;
      catItems.forEach(function (c) { if (c.id === lastCat[type]) temSel = true; });
      if (!temSel) lastCat[type] = '*';
      selId = lastCat[type];

      cats = new App.VList({
        root: croot, cols: 1, rowH: 76,
        render: function (c, i, cell) {
          var r = App.el('div', 'cat-item' + (c.id === selId ? ' sel' : '')); r.appendChild(App.el('span', null, c.name)); r.appendChild(App.el('span', 'n', String(c.n))); cell.style.padding = '6px 0'; cell.appendChild(r);
        },
        onFocus: App.debounce(function (c) { if (c && c.id !== selId) applyCat(c.id); }, 140),
        onSelect: function () { focusGrid(); }
      });
      var isLive = type === 'live';
      grid = new App.VList({
        root: groot, cols: isLive ? 3 : 5, rowH: isLive ? 112 : 420, empty: EMPTY[type],
        render: function (it, i, cell) {
          cell.appendChild(isLive ? App.cards.channel(it, { sub: selId === '*' ? catNames[it.c] : '' }) : App.cards.poster(it));
        },
        onSelect: function (it) {
          App.actions.open(it, {
            items: grid.items,
            onClose: function (s) { var i = grid ? grid.items.indexOf(s.item) : -1; if (i >= 0) grid.setIdx(i); }
          });
        },
        onHold: function (it, i) { App.actions.toggleFav(it); grid.refreshItem(i); }
      });
      applyCat = function (id) {
        selId = id; lastCat[type] = id;
        grid.setItems(App.catalog.items(type, id));
        cats.refreshAll();
        if (App.health) App.health.cancel();   /* trocou de categoria: descarta o lote anterior */
        syncHealth(true);
      };
      cats.setItems(catItems);
      var si = 0; catItems.forEach(function (c, i) { if (c.id === selId) si = i; });
      cats.idx = si; cats.scrollTo(si); cats.render();
      grid.setItems(App.catalog.items(type, selId));
      syncHealth(true);
    }

    function focusGrid() {
      if (!grid || !grid.items.length) return false;
      cats.blur(); zone = 'grid'; grid.focus(); return true;
    }

    return {
      hints: type === 'live' ? ['OK: assistir', 'AMARELO / segurar OK: favoritar', 'INFO: saúde do canal'] : ['OK: detalhes', 'AMARELO / segurar OK: favoritar'],
      mount: function (root) {
        el = root; zone = 'cats'; build();
        onData = function () {
          if (!el) return;
          build();
          if (App.shell.inScreen()) { if (cats) cats.focus(); else App.shell.toMenu(); }
        };
        onFav = function () { if (grid) grid.refreshAll(); };
        onHealth = function (e) { if (grid && e && e.key) App.health.paintKey(grid.root, e.key, e.rec); };
        /* ligar/desligar nas configuracoes tem efeito imediato nesta tela */
        onHealthCfg = function (on) {
          if (!grid || !App.health) return;
          if (!on) { App.health.cancel(); grid.refreshAll(); }   /* tira os pontos e para a fila */
          else syncHealth(true);                                  /* volta respeitando o cache */
        };
        App.bus.on('catalog', onData); App.bus.on('catalog:loading', onData.loadHook = function (p) { if (p === 1 || p === -1) onData(); });
        App.bus.on('favs', onFav);
        if (App.health) { App.bus.on('health', onHealth); App.bus.on('health:config', onHealthCfg); }
      },
      unmount: function () {
        App.bus.off('catalog', onData); App.bus.off('catalog:loading', onData.loadHook); App.bus.off('favs', onFav);
        if (App.health) { App.bus.off('health', onHealth); App.bus.off('health:config', onHealthCfg); App.health.cancel(); }
        if (cats) { cats.o.onFocus.cancel(); } cats = grid = null; el = null;
      },
      enter: function () {
        if (!cats) return false;
        if (zone === 'grid' && focusGrid()) return true;
        zone = 'cats'; return cats.focus();
      },
      key: function (a) {
        if (!cats) return false;
        if (zone === 'cats') {
          if (a === 'info') { showHealth(null); return true; }
          if (cats.key(a)) return true;
          if (a === 'right') return focusGrid();
          return false;
        }
        if (a === 'back') { grid.blur(); zone = 'cats'; cats.focus(); return true; }
        if (a === 'info') { showHealth(grid.current()); return true; }
        if (grid.key(a)) { syncHealth(false); return true; }
        if (a === 'left') { grid.blur(); zone = 'cats'; cats.focus(); return true; }
        return true;
      },
      /* atalho vindo da Home: abre direto uma categoria */
      pickCat: function (id) { lastCat[type] = id; }
    };
  };
  App.screens.setCat = function (type, id) { lastCat[type] = id; };
})(window);
