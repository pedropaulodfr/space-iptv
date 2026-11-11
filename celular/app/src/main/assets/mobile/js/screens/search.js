/* Pesquisa: canais, filmes e séries na mesma caixa, com resultados agrupados. */
(function (g) {
  'use strict';
  var App = g.App;
  var U = App.m.ui;
  App.m.screens = App.m.screens || {};

  App.m.screens.search = function () {
    var root = App.el('div');
    root.style.cssText = 'height:100%;display:flex;flex-direction:column';

    var head = App.el('div');
    head.style.cssText = 'padding:6px ' + (App.m.tv ? 20 : 14) + 'px 10px';
    var input = App.el('input', 'input');
    input.type = 'search';
    input.placeholder = 'Buscar por nome…';
    input.autofocus = true;
    head.appendChild(input);
    root.appendChild(head);

    var scroll = App.el('div', 'scroll');
    scroll.style.flex = '1';
    scroll.style.minHeight = '0';
    root.appendChild(scroll);

    var timer = null;

    function playLive(item, chans) {
      App.m.player.open(item, { list: App.lists.active(), chans: chans });
    }

    function section(title, items, renderRow) {
      if (!items.length) return null;
      var box = App.el('div');
      box.appendChild(U.sectionTitle(title + ' (' + items.length + ')'));
      var host = App.el('div');
      host.style.height = (items.length * U.rowH(80)) + 'px';
      box.appendChild(host);
      U.vscroll(host, { count: items.length, rowH: U.rowH(80), render: renderRow });
      return box;
    }

    function run() {
      var q = input.value.trim();
      App.clear(scroll);
      if (q.length < 2) {
        scroll.appendChild(U.empty('Pesquisar', 'Digite pelo menos 2 letras para procurar canais, filmes e séries.'));
        return;
      }
      var r = App.catalog.search(q, ['live', 'movie', 'series'], 80);
      var total = r.live.length + r.movie.length + r.series.length;
      if (!total) {
        scroll.appendChild(U.empty('Nada encontrado', 'Nenhum resultado para "' + q + '".'));
        return;
      }

      var a = section('Canais', r.live, function (i) {
        var it = r.live[i];
        return U.channelRow(it, {
          list: App.lists.active(),
          onOpen: function (x) { playLive(x, r.live); }
        });
      });
      if (a) scroll.appendChild(a);

      var b = section('Filmes', r.movie, function (i) {
        var it = r.movie[i];
        return U.channelRow(it, {
          list: App.lists.active(),
          category: it.y || '',
          onOpen: function (x) { App.m.shell.push('details', { item: x, type: 'movie' }); }
        });
      });
      if (b) scroll.appendChild(b);

      var c = section('Séries', r.series, function (i) {
        var it = r.series[i];
        return U.channelRow(it, {
          list: App.lists.active(),
          category: it.y || '',
          onOpen: function (x) { App.m.shell.push('details', { item: x, type: 'series' }); }
        });
      });
      if (c) scroll.appendChild(c);
    }

    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(run, 260);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { clearTimeout(timer); run(); input.blur(); }
    });

    run();
    /* No projetor nao abre o teclado sozinho: o usuario chega pela trilha e o
       controle precisa andar pela tela antes de digitar. */
    if (!App.m.tv) setTimeout(function () { input.focus(); }, 150);

    return {
      el: root,
      destroy: function () { clearTimeout(timer); }
    };
  };
})(window);
