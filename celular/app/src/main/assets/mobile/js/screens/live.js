/* TV ao vivo: categorias, busca dentro do catalogo e lista virtualizada por categoria. */
(function (g) {
  'use strict';
  var App = g.App;
  var U = App.m.ui;
  App.m.screens = App.m.screens || {};

  App.m.screens.live = function (arg) {
    arg = arg || {};
    var pad = App.m.tv ? 20 : 14;
    var root = App.el('div');
    root.style.cssText = 'height:100%;display:flex;flex-direction:column';

    var head = App.el('div');
    head.style.cssText = 'padding:6px ' + pad + 'px 0';
    var chipsBox = App.el('div');
    var listHost = App.el('div');
    listHost.style.cssText = 'flex:1;min-height:0;position:relative;padding:0 ' + pad + 'px';

    var query = '';
    var cat = arg.cat || '*';
    var items = [];
    var list = App.lists.active();

    /* campo de busca ------------------------------------------------------- */
    var searchBox = App.el('div');
    searchBox.style.cssText = 'display:flex;align-items:center;margin:2px 0 10px';
    var input = App.el('input', 'input');
    input.type = 'search';
    input.placeholder = 'Buscar canal…';
    input.style.minHeight = '44px';
    input.addEventListener('input', function () {
      query = input.value;
      clearTimeout(t);
      t = setTimeout(paintItems, 220);
    });
    var t = null;
    searchBox.appendChild(input);
    head.appendChild(searchBox);
    head.appendChild(chipsBox);
    root.appendChild(head);
    root.appendChild(listHost);

    function catName(id) {
      var a = (App.catalog.data.cats || {}).live || [], i;
      for (i = 0; i < a.length; i++) if (a[i].id === id) return a[i].name;
      return '';
    }

    function paintChips() {
      var cats = App.parental.filterCats('live');
      App.clear(chipsBox);
      var all = [{ id: '*', name: 'Todos (' + App.catalog.data.live.length + ')' }]
        .concat(cats.map(function (c) { return { id: c.id, name: c.name }; }));
      var box = U.chips(all, cat, function (c) {
        cat = c.id;
        paintChips();
        paintItems();
        listHost.scrollTop = 0;
      });
      box.style.paddingBottom = '8px';
      chipsBox.appendChild(box);
    }

    function compute() {
      if (query.trim()) {
        var r = App.catalog.search(query, ['live'], 300);
        return r.live;
      }
      return App.catalog.items('live', cat);
    }

    var vs = null;

    function paintItems() {
      items = compute();
      App.clear(listHost);
      if (!items.length) {
        listHost.appendChild(U.empty('Nenhum canal',
          query ? 'Nada encontrado para "' + query + '".'
            : (App.parental.locked() ? 'Conteúdo adulto oculto pelo controle parental.' : 'Esta categoria está vazia.')));
        return;
      }
      vs = U.vscroll(listHost, {
        count: items.length,
        rowH: U.rowH(76),
        render: function (i) {
          var it = items[i];
          if (App.health && App.health.enabled()) App.health.observe(list, [it]);
          return U.channelRow(it, {
            list: list,
            category: catName(it.c),
            onOpen: function (x) {
              App.m.player.open(x, { list: list, chans: items });
            }
          });
        }
      });
    }

    function paint() {
      list = App.lists.active();
      paintChips();
      paintItems();
    }

    paint();
    App.bus.on('catalog', paint);

    return {
      el: root,
      destroy: function () {
        App.bus.off('catalog', paint);
        if (App.health) App.health.cancel();
      },
      refresh: paint
    };
  };
})(window);
