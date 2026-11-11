/* Início: continuar assistindo, favoritos e faixas por categoria. */
(function (g) {
  'use strict';
  var App = g.App;
  var U = App.m.ui;
  App.m.screens = App.m.screens || {};

  /* Cartao de canal (16:9). A caixa vem do CSS (padding-bottom num filho bloco):
     a WebView antiga do projetor nao entende `aspect-ratio`. */
  function chanCard(item, onOpen) {
    var card = App.el('div', 'poster wide');
    card.style.width = App.m.tv ? '196px' : '124px';
    var frame = App.el('div', 'frame');
    var box = App.el('div', 'artwrap');
    if (item.l) {
      var img = new Image();
      img.src = item.l;
      img.alt = '';
      img.style.cssText = 'max-width:78%;max-height:78%;object-fit:contain';
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      box.appendChild(img);
    } else {
      box.appendChild(App.el('div', 'dim', (item.n || '?').charAt(0).toUpperCase()));
    }
    if (App.health && App.health.enabled() && item.t === 'live') {
      var dot = App.el('i', 'hdot gray');
      dot.style.cssText = 'position:absolute;left:6px;top:6px';
      dot.setAttribute('data-hkey', App.health.keyOf(item, App.lists.active()));
      App.health.paint(dot, item, App.lists.active());
      box.appendChild(dot);
    }
    frame.appendChild(box);
    card.appendChild(frame);
    var cap = App.el('div', 'cap');
    cap.style.padding = '16px 7px 7px';
    cap.appendChild(App.el('div', 'trunc', item.n || 'Sem nome'));
    card.appendChild(cap);
    card.addEventListener('click', function () { onOpen(item); });
    return card;
  }

  function strip(items, render) {
    var box = App.el('div', 'chips');
    box.style.paddingBottom = '2px';
    items.forEach(function (it) {
      var cell = render(it);
      cell.style.flex = 'none';
      box.appendChild(cell);
    });
    return box;
  }

  App.m.screens.home = function () {
    var root = App.el('div');
    root.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var scroll = App.el('div', 'scroll');
    root.appendChild(scroll);

    var progressEl = null;
    function onLoading(p) {
      if (!progressEl) return;
      if (p >= 0 && p < 1) progressEl.textContent = 'Atualizando a lista… ' + Math.round(p * 100) + '%';
    }
    App.bus.on('catalog:loading', onLoading);

    function play(item, chans) {
      App.m.player.open(item, { list: App.lists.active(), chans: chans });
    }

    function continueRow() {
      var recs = App.hist.continueList().slice(0, 12);
      var items = [];
      recs.forEach(function (r) {
        var it = App.catalog.find(r.t, r.id);
        if (!it) return;
        if (App.parental && App.parental.isAdult(it)) return;
        items.push({ it: it, r: r });
      });
      if (!items.length) return null;
      var sec = U.sectionTitle('Continuar assistindo');
      var st = strip(items, function (o) {
        var card = U.poster(o.it, {
          progress: true,
          hist: o.r,
          onOpen: function () {
            if (o.r.ep) App.m.player.open(o.it, { list: App.lists.active(), ep: o.r.ep });
            else play(o.it);
          }
        });
        card.style.width = App.m.tv ? '168px' : '112px';
        return card;
      });
      return [sec, st];
    }

    function favRow() {
      var favs = App.favs.list('live').slice(0, 14);
      if (!favs.length) return null;
      return [U.sectionTitle('Favoritos', 'ver todos', function () { App.m.shell.go('favs'); }),
        strip(favs, function (it) { return chanCard(it, function (x) { play(x, App.favs.liveList()); }); })];
    }

    function liveRows() {
      var cats = App.parental.filterCats('live');
      var out = [];
      var used = 0;
      for (var i = 0; i < cats.length && used < 4; i++) {
        var items = App.catalog.items('live', cats[i].id).slice(0, 14);
        if (items.length < 2) continue;
        used++;
        out.push(U.sectionTitle(cats[i].name, 'ver', (function (c) {
          return function () { App.m.shell.go('live', { cat: c.id }); };
        })(cats[i])));
        out.push(strip(items, function (it) {
          return chanCard(it, function (x) { play(x, App.catalog.items('live', cats[i].id)); });
        }));
      }
      return out.length ? out : null;
    }

    function paint() {
      App.clear(scroll);
      progressEl = null;
      var list = App.lists.active();

      if (!list) {
        scroll.appendChild(U.empty('Bem-vindo ao Space IPTV',
          'Adicione uma lista M3U ou um painel Xtream Codes para começar a assistir.',
          'Adicionar lista', function () { App.m.shell.go('settings'); }));
        return;
      }

      var head = App.el('div');
      head.style.cssText = 'padding:14px 0 6px';
      head.appendChild(App.el('h1', null, 'Olá!'));
      head.appendChild(App.el('div', 'muted small', list.name + ' • ' +
        App.catalog.data.live.length + ' canais, ' +
        App.catalog.data.movie.length + ' filmes e ' +
        App.catalog.data.series.length + ' séries'));
      scroll.appendChild(head);

      if (App.catalog.isLoading()) {
        var box = App.el('div', 'card');
        box.style.cssText = 'padding:14px;margin-top:12px;display:flex;align-items:center';
        var sp = U.spinner();
        sp.style.margin = '0';
        box.appendChild(sp);
        var txt = App.el('div', 'small muted', 'Atualizando a lista…');
        txt.style.marginLeft = '14px';
        box.appendChild(txt);
        scroll.appendChild(box);
        progressEl = txt;
      }

      if (!App.catalog.hasData() && !App.catalog.isLoading()) {
        scroll.appendChild(U.empty('Lista vazia',
          'Não há canais salvos. Verifique a internet e toque em atualizar.',
          'Atualizar agora', function () { App.m.shell.refreshList(); }));
        return;
      }

      var c = continueRow();
      if (c) c.forEach(function (e) { scroll.appendChild(e); });

      var f = favRow();
      if (f) f.forEach(function (e) { scroll.appendChild(e); });

      var l = liveRows();
      if (l) l.forEach(function (e) { scroll.appendChild(e); });
      else {
        scroll.appendChild(U.sectionTitle('Ao vivo'));
        scroll.appendChild(U.empty('Nenhum canal',
          App.parental.locked() ? 'Conteúdo adulto oculto pelo controle parental.' : 'Esta lista não tem canais ao vivo.'));
      }
    }

    paint();
    App.bus.on('catalog', paint);

    return {
      el: root,
      destroy: function () {
        App.bus.off('catalog', paint);
        App.bus.off('catalog:loading', onLoading);
      },
      refresh: paint
    };
  };
})(window);
