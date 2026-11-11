/* Casca do app: abas inferiores, pilha de telas, inicializacao e botao voltar. */
(function (g) {
  'use strict';
  var App = g.App;
  var U = App.m.ui;

  var view = document.getElementById('view');
  var tabsEl = document.getElementById('tabs');

  var TABS = [
    { id: 'home', label: 'Início', icon: 'home' },
    { id: 'live', label: 'TV', icon: 'live' },
    { id: 'movies', label: 'Filmes', icon: 'movie' },
    { id: 'series', label: 'Séries', icon: 'series' },
    { id: 'favs', label: 'Favoritos', icon: 'star' }
  ];

  var stack = [];
  var cur = null;
  var activeTab = 'home';

  function screenFor(entry) {
    var a = entry.arg;
    switch (entry.name) {
      case 'live': return App.m.screens.live(a);
      case 'movies': return App.m.screens.vod({ type: 'movie', cat: a && a.cat });
      case 'series': return App.m.screens.vod({ type: 'series', cat: a && a.cat });
      case 'favs': return App.m.screens.favs(a);
      case 'search': return App.m.screens.search(a);
      case 'settings': return App.m.screens.settings(a);
      case 'details': return App.m.screens.details(a);
      default: return App.m.screens.home(a);
    }
  }

  function paintTabs() {
    var b = tabsEl.querySelectorAll('button');
    for (var i = 0; i < b.length; i++) {
      b[i].classList.toggle('on', b[i].getAttribute('data-tab') === activeTab);
    }
  }

  function mount(entry) {
    if (cur && cur.destroy) {
      try { cur.destroy(); } catch (e) { /* ignore */ }
    }
    /* Trocar de tela fecha o que estiver por cima. Sem isto uma folha esquecida
       (a lista de canais do player, por exemplo) continuava aberta por cima da
       tela nova - e, no projetor, roubava o foco do controle remoto. */
    if (App.m.ui && App.m.ui.closeTop) {
      var guard = 0;
      while (App.m.ui.closeTop() && guard++ < 12) { /* esvazia a pilha */ }
    }
    App.clear(view);
    cur = screenFor(entry);
    if (!cur) {
      view.appendChild(U.empty('Tela indisponível', ''));
      return;
    }
    view.appendChild(cur.el);
    activeTab = entry.tab || entry.name;
    paintTabs();
    /* projetor/controle remoto: o anel comeca no primeiro item da tela nova */
    if (App.m.focus) App.m.focus.reset(120);
  }

  /* Redesenha a tela atual mantendo a posicao na pilha. Usado quando o modo de
     tela muda (celular <-> projetor) e as medidas precisam ser refeitas. */
  function reflow() {
    if (!stack.length) return;
    mount(top());
  }

  function top() { return stack[stack.length - 1]; }

  function go(name, arg) {
    stack = [{ name: name, arg: arg, tab: name }];
    mount(top());
  }

  function push(name, arg) {
    stack.push({ name: name, arg: arg, tab: activeTab });
    mount(top());
  }

  function back() {
    if (stack.length <= 1) return false;
    stack.pop();
    mount(top());
    return true;
  }

  function refresh() {
    if (!cur) return;
    if (activeTab === 'favs' && cur.refresh) cur.refresh();
  }

  function refreshTitle() {
    document.title = 'Space IPTV';
  }

  /* Atualiza o catalogo da lista e repinta a tela atual. */
  function refreshList(list) {
    list = list || App.lists.active();
    if (!list) return;
    App.lists.setActive(list.id);
    App.catalog.init(list).then(function () {
      if (cur && cur.refresh) cur.refresh();
      if (!App.isOnline()) {
        App.toast('Sem internet — mostrando os dados salvos', 2600);
        return;
      }
      App.toast('Atualizando lista…', 1800);
      App.catalog.refresh(list);
    });
  }

  function activate(id) {
    var l = App.lists.get(id);
    if (!l) return;
    App.lists.setActive(id);
    App.catalog.init(l).then(function () {
      go('home');
      App.toast('Lista ativa: ' + (l.name || ''), 2000);
      if (App.isOnline() && App.catalog.needsRefresh()) App.catalog.refresh(l);
    });
  }

  /* ------------------------------------------------------------- eventos --- */
  function wire() {
    var searchBtn = document.getElementById('btn-search');
    var settingsBtn = document.getElementById('btn-settings');
    searchBtn.innerHTML = U.ico('search');
    settingsBtn.innerHTML = U.ico('gear');
    searchBtn.addEventListener('click', function () { push('search'); });
    settingsBtn.addEventListener('click', function () { push('settings'); });

    App.bus.on('catalog:error', function (e) {
      App.toast(e && e.message ? e.message : 'Erro ao atualizar a lista', 3200);
    });
    App.bus.on('catalog:done', function (o) {
      if (o && o.warns && o.warns.length) App.toast(o.warns[0], 3200);
    });
  }

  function buildTabs() {
    TABS.forEach(function (t) {
      var b = document.createElement('button');
      b.setAttribute('data-tab', t.id);
      b.innerHTML = U.ico(t.icon) + '<span>' + t.label + '</span>';
      b.addEventListener('click', function () {
        if (App.m.player.isOpen()) return;
        if (activeTab === t.id && stack.length === 1) {
          var s = view.querySelector('.scroll, .vscroll');
          if (s) s.scrollTop = 0;
          return;
        }
        go(t.id, null);
      });
      tabsEl.appendChild(b);
    });
  }

  /* -------------------------------------------------------------- inicio --- */
  function start() {
    buildTabs();
    wire();

    g.AndroidShell = {
      back: function () {
        if (App.m.player.isOpen()) { App.m.player.close(); return true; }
        if (App.m.ui.closeTop()) return true;
        return App.m.shell.back();
      }
    };

    var l = App.lists.active();
    if (!l) {
      go('settings');
      App.toast('Adicione uma lista para começar', 3000);
      return;
    }

    go('home');
    App.catalog.init(l).then(function (has) {
      /* retomada do ultimo canal: uma unica vez, depois do catalogo carregado.
         App.resume.decide() nunca devolve canal adulto. */
      var alvo = App.resume.startup();
      if (alvo) {
        App.m.player.open(alvo, {
          list: l,
          chans: App.catalog.items('live', alvo.c)
        });
      }
      if (!App.isOnline()) {
        App.toast('Sem internet — mostrando os dados salvos', 3000);
        return;
      }
      if (!has || App.catalog.needsRefresh()) App.catalog.refresh(l);
    });
  }

  App.m.shell = {
    start: start,
    go: go,
    push: push,
    back: back,
    reflow: reflow,
    refresh: refresh,
    refreshTitle: refreshTitle,
    refreshList: refreshList,
    activate: activate,
    current: function () { return top(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
