/* Favoritos: acesso rápido numerado (o equivalente mobile das teclas 1..9 da TV)
   e a lista completa, separada por tipo. */
(function (g) {
  'use strict';
  var App = g.App;
  var U = App.m.ui;
  App.m.screens = App.m.screens || {};

  App.m.screens.favs = function () {
    var root = App.el('div');
    root.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var scroll = App.el('div', 'scroll');
    root.appendChild(scroll);

    var filter = 'live';

    function quickGrid() {
      var box = App.el('div');
      box.appendChild(U.sectionTitle('Acesso rápido'));
      var hint = App.el('div', 'small dim');
      hint.style.marginBottom = '8px';
      hint.textContent = 'Os nove primeiros canais favoritos. Toque para assistir.';
      box.appendChild(hint);

      var grid = App.el('div');
      var cols = App.m.tv ? 5 : 3;
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(' + cols + ',1fr);grid-gap:8px';
      for (var n = 1; n <= 9; n++) {
        var it = App.favs.byNumber(n);
        var cell = App.el('div', 'card');
        cell.style.cssText = 'padding:8px;min-height:' + (App.m.tv ? 108 : 88) + 'px;display:flex;flex-direction:column;align-items:center;justify-content:center;'
          + (it ? '' : 'opacity:.32');
        var num = App.el('div', null, String(n));
        num.style.cssText = 'font-family:var(--font-display);font-size:12px;color:var(--electricBlue)';
        cell.appendChild(num);
        if (it) {
          var logo = U.logo(it, 'thumb');
          logo.style.cssText = 'width:40px;height:40px;margin-top:6px;border-radius:10px;background:rgba(255,255,255,.06);'
            + 'display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:13px';
          var img = logo.querySelector('img');
          if (img) { img.style.maxWidth = '78%'; img.style.maxHeight = '78%'; img.style.objectFit = 'contain'; }
          cell.appendChild(logo);
          var nm = App.el('div', 'trunc small');
          nm.style.maxWidth = '100%';
          nm.style.marginTop = '4px';
          nm.textContent = it.n || '';
          cell.appendChild(nm);
          cell.addEventListener('click', (function (x) {
            return function () { App.m.player.open(x, { list: App.lists.active(), chans: App.favs.liveList() }); };
          })(it));
        } else {
          cell.appendChild(App.el('div', 'small dim', '—'));
        }
        grid.appendChild(cell);
      }
      box.appendChild(grid);
      return box;
    }

    function paint() {
      App.clear(scroll);
      var list = App.lists.active();
      if (!list) {
        scroll.appendChild(U.empty('Sem lista', 'Adicione uma lista para usar os favoritos.',
          'Ir para configurações', function () { App.m.shell.go('settings'); }));
        return;
      }

      var live = App.favs.list('live');
      if (live.length) scroll.appendChild(quickGrid());

      var chips = U.chips([
        { id: 'live', name: 'Canais (' + App.favs.list('live').length + ')' },
        { id: 'movie', name: 'Filmes (' + App.favs.list('movie').length + ')' },
        { id: 'series', name: 'Séries (' + App.favs.list('series').length + ')' }
      ], filter, function (c) {
        filter = c.id;
        paint();
      });
      chips.style.marginTop = '18px';
      scroll.appendChild(chips);

      var items = App.favs.list(filter);
      if (!items.length) {
        scroll.appendChild(U.empty('Nenhum favorito',
          'Toque na estrela de um canal, filme ou série para guardar aqui.'));
        return;
      }

      var host = App.el('div');
      host.style.height = Math.max(240, items.length * U.rowH(80)) + 'px';
      scroll.appendChild(host);

      U.vscroll(host, {
        count: items.length,
        rowH: U.rowH(80),
        render: function (i) {
          var it = items[i];
          return U.channelRow(it, {
            list: list,
            category: it.t === 'live' ? '' : (it.t === 'movie' ? 'Filme' : 'Série'),
            onOpen: function (x) {
              if (x.t === 'live') App.m.player.open(x, { list: list, chans: App.favs.liveList() });
              else if (x.missing) App.toast('Este item não está mais na lista');
              else App.m.shell.push('details', { item: x, type: x.t });
            }
          });
        }
      });
    }

    paint();
    App.bus.on('catalog', paint);

    return {
      el: root,
      destroy: function () { App.bus.off('catalog', paint); },
      refresh: paint
    };
  };
})(window);
