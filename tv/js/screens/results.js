/* Pesquisa global e Favoritos: filtro por tipo + grade de resultados */
(function (g) {
  'use strict';
  var App = g.App;
  var FILTERS = [{ k: 'all', n: 'Todos' }, { k: 'live', n: 'Canais' }, { k: 'movie', n: 'Filmes' }, { k: 'series', n: 'Séries' }];

  /* mode: 'search' | 'favs' */
  App.screens.results = function (mode) {
    var el, grid, chips, chipNodes = [], field, input, zone, filter = 'all', data = { live: [], movie: [], series: [] }, onFav, onCat, query = '';
    var search = mode === 'search';

    function items() {
      return filter === 'all' ? data.live.concat(data.movie, data.series) : data[filter];
    }
    function counts() {
      chipNodes.forEach(function (c, i) {
        var k = FILTERS[i].k, n = k === 'all' ? data.live.length + data.movie.length + data.series.length : data[k].length;
        c.textContent = FILTERS[i].n + ' (' + n + ')';
        c.classList[k === filter ? 'add' : 'remove']('primary');
      });
    }
    function empty() {
      if (search) return query ? 'Nada encontrado para "' + query + '".' : 'Digite para pesquisar canais, filmes e séries da lista ativa.';
      return 'Você ainda não tem favoritos. Segure OK ou use a tecla amarela em qualquer item.';
    }
    function load() {
      if (search) data = App.catalog.search(query);
      else data = { live: App.favs.list('live'), movie: App.favs.list('movie'), series: App.favs.list('series') };
      counts(); grid.o.empty = empty(); grid.setItems(items());
    }
    var doSearch = App.debounce(function () { query = input.value.replace(/^\s+|\s+$/g, ''); load(); }, 250);

    function setFilter(i) { filter = FILTERS[i].k; counts(); grid.o.empty = empty(); grid.setItems(items()); }

    function paintZone() {
      if (field) field.classList[zone === 'field' ? 'add' : 'remove']('focused');
      if (zone === 'chips') chips.focus(chips.i); else chips.blur();
      if (zone === 'grid') grid.focus(); else grid.blur();
    }
    function go(z) {
      if (z === 'grid' && !grid.items.length) z = 'chips';
      zone = z; paintZone();
    }

    return {
      hints: search ? ['OK em "Pesquisar": abrir teclado', 'OK: abrir resultado'] : ['OK: abrir', 'AMARELO / segurar OK: remover dos favoritos'],
      mount: function (root) {
        el = root; App.clear(el);
        var head = App.el('div', 'res-head'), body = App.el('div', 'res-body'), groot = App.el('div');
        if (search) {
          field = App.el('div', 'field'); field.appendChild(App.el('label', null, 'Pesquisar')); input = document.createElement('input');
          input.type = 'text'; input.placeholder = 'Nome de canal, filme ou série'; input.autocomplete = 'off'; input.spellcheck = false;
          input.addEventListener('input', doSearch); field.appendChild(input); head.appendChild(field);
        }
        var row = App.el('div', 'chip-row'); row.style.padding = '0'; row.style.marginLeft = search ? '0' : '0';
        chipNodes = FILTERS.map(function (f, i) { var c = App.ui.btn(f.n); c.style.height = '56px'; c._act = function () { setFilter(i); }; row.appendChild(c); return c; });
        chips = App.ui.group(chipNodes, true); head.appendChild(row);
        body.appendChild(groot); el.appendChild(head); el.appendChild(body);
        grid = new App.VList({
          root: groot, cols: 5, rowH: 420, empty: '',
          render: function (it, i, cell) { cell.appendChild(App.cards.any(it)); },
          onSelect: function (it) { App.actions.open(it, { items: filter === 'live' ? grid.items : data.live }); },
          onHold: function (it, i) { App.actions.toggleFav(it); if (!search) load(); else grid.refreshItem(i); }
        });
        zone = search ? 'field' : 'chips';
        onFav = function () { if (!search && grid) { var k = grid.idx; load(); grid.idx = App.clamp(k, 0, Math.max(0, grid.items.length - 1)); grid.scrollTo(grid.idx); grid.render(); if (zone === 'grid') { if (grid.items.length) grid.focus(); else go('chips'); } } };
        onCat = function () { if (grid) load(); };
        App.bus.on('favs', onFav); App.bus.on('catalog', onCat);
        load();
      },
      unmount: function () { App.bus.off('favs', onFav); App.bus.off('catalog', onCat); doSearch.cancel(); grid = chips = field = input = el = null; },
      enter: function () { paintZone(); return true; },
      key: function (a) {
        if (zone === 'field') {
          if (a === 'ok') { input.focus(); return true; }
          if (a === 'down') { go('chips'); return true; }
          return a !== 'left' && a !== 'back';
        }
        if (zone === 'chips') {
          if (chips.key(a)) return true;
          if (a === 'up' && search) { go('field'); return true; }
          if (a === 'down') { go('grid'); return true; }
          return a !== 'left' && a !== 'back' ? true : false;
        }
        if (grid.key(a)) return true;
        if (a === 'up') { go('chips'); return true; }
        return a !== 'left' && a !== 'back' ? true : false;
      }
    };
  };
})(window);
