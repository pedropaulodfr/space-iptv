/* Shell do app: menu lateral, troca de telas, HUD, saida e inicializacao */
(function (g) {
  'use strict';
  var App = g.App;

  var ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    live: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 3l4 3 4-3"/>',
    movies: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5M16 4v5"/>',
    series: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>',
    favs: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.2 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'
  };
  var MENU = [
    { id: 'home', label: 'Início', make: function () { return App.screens.home(App.shell); } },
    { id: 'live', label: 'TV ao vivo', make: function () { return App.screens.browse('live'); } },
    { id: 'movies', label: 'Filmes', make: function () { return App.screens.browse('movie'); } },
    { id: 'series', label: 'Séries', make: function () { return App.screens.browse('series'); } },
    { id: 'search', label: 'Pesquisa', make: function () { return App.screens.results('search'); } },
    { id: 'favs', label: 'Favoritos', make: function () { return App.screens.results('favs'); } },
    { sep: true },
    { id: 'settings', label: 'Configurações', make: function () { return App.screens.settings(); } }
  ];

  var side, screenEl, nodes = [], items = [], menuIdx = 0, curIdx = 0, area = 'menu', cur = null;

  function icon(id) { return '<svg class="ico" viewBox="0 0 24 24">' + ICONS[id] + '</svg>'; }

  function buildMenu() {
    side = document.getElementById('sidebar'); screenEl = document.getElementById('screen');
    MENU.forEach(function (m) {
      if (m.sep) { side.appendChild(App.el('div', 'nav-sep')); return; }
      var n = App.el('div', 'nav-item'); n.innerHTML = icon(m.id); n.appendChild(App.el('span', null, m.label));
      side.appendChild(n); nodes.push(n); items.push(m);
    });
  }
  function paintMenu() {
    nodes.forEach(function (n, i) {
      n.classList[i === curIdx ? 'add' : 'remove']('active');
      n.classList[area === 'menu' && i === menuIdx ? 'add' : 'remove']('focused');
    });
  }
  function hints(list) {
    var h = document.getElementById('hints'); App.clear(h);
    ['◀▶▲▼ navegar', 'OK selecionar', 'VOLTAR voltar'].concat(list || []).forEach(function (t) { h.appendChild(App.el('span', null, t)); });
  }

  function show(i) {
    if (cur) { cur.unmount(); App.clear(screenEl); }
    curIdx = i; cur = items[i].make(); cur.mount(screenEl);
    paintMenu();
  }

  App.shell = {
    inScreen: function () { return area === 'screen'; },
    toMenu: function () { area = 'menu'; menuIdx = curIdx; paintMenu(); hints(['OK abrir seção']); },
    goto: function (id) {
      var i; for (i = 0; i < items.length; i++) if (items[i].id === id) break;
      if (i >= items.length) return;
      show(i); menuIdx = i; App.shell.intoScreen();
    },
    intoScreen: function () {
      if (cur && cur.enter()) { area = 'screen'; paintMenu(); hints(cur.hints); }
      else { App.shell.toMenu(); }
    }
  };

  var shellLayer = {
    key: function (a) {
      if (a === 'exit') { confirmExit(); return true; }
      /* teclas 1..9: abrem o canal favorito correspondente em qualquer tela
         (durante a reproducao quem trata e a camada do player) */
      if (a && a.length === 2 && a.charAt(0) === 'n' && a !== 'n0') {
        App.actions.playFavNumber(+a.charAt(1));   /* tecla sem favorito: nao faz nada */
        return true;
      }
      if (area === 'screen') {
        if (cur.key(a)) return true;
        if (a === 'left' || a === 'back') { App.shell.toMenu(); return true; }
        return true;
      }
      if (a === 'up') { if (menuIdx > 0) { menuIdx--; paintMenu(); } return true; }
      if (a === 'down') { if (menuIdx < items.length - 1) { menuIdx++; paintMenu(); } return true; }
      if (a === 'ok' || a === 'right') { if (menuIdx !== curIdx) show(menuIdx); App.shell.intoScreen(); return true; }
      if (a === 'back') { confirmExit(); return true; }
      return true;
    }
  };

  var exitAsking = false;
  function confirmExit() {
    if (exitAsking) return;
    exitAsking = true;
    App.ui.confirm({ title: 'Sair', msg: 'Deseja fechar o Space IPTV?', yes: 'Sair', no: 'Ficar' }).then(function (ok) {
      exitAsking = false;
      if (!ok) return;
      try { g.tizen.application.getCurrentApplication().exit(); } catch (e) { try { g.close(); } catch (e2) { /* navegador */ } }
    });
  }

  /* ---------- HUD ---------- */
  function clock() {
    var d = new Date(); document.getElementById('hud-clock').textContent = App.pad(d.getHours()) + ':' + App.pad(d.getMinutes());
  }
  function hudStatus(text, cls) { var s = document.getElementById('hud-status'); s.textContent = text || ''; s.className = 'badge' + (cls ? ' ' + cls : ''); }
  function hudList() { var l = App.lists.active(); document.getElementById('hud-list').textContent = l ? l.name : 'Sem lista'; }
  function refreshStatus() {
    if (!App.isOnline()) return hudStatus('Sem internet • dados salvos', 'warn');
    if (App.catalog.isLoading()) return;
    hudStatus('');
  }

  App.bus.on('catalog:loading', function (p) {
    if (p >= 0 && p < 1) hudStatus('Atualizando ' + Math.round(p * 100) + '%');
    else refreshStatus();
  });
  App.bus.on('catalog:error', function (e) { hudStatus('Erro ao atualizar', 'warn'); App.toast(e.message, 4500); });
  App.bus.on('catalog:done', function (o) {
    hudStatus('Atualizada', 'ok'); setTimeout(refreshStatus, 3000);
    if (o.warns && o.warns.length) App.toast(o.warns[0], 4500);
  });
  App.bus.on('catalog', hudList);
  g.addEventListener('online', function () { refreshStatus(); var l = App.lists.active(); if (l && App.catalog.needsRefresh()) App.catalog.refresh(l); });
  g.addEventListener('offline', refreshStatus);

  /* ---------- inicializacao ---------- */
  function start() {
    App.registerKeys();
    buildMenu(); clock(); setInterval(clock, 30000);
    App.nav.push(shellLayer);
    App.starfield.start();
    var l = App.lists.active();
    hudList(); refreshStatus();
    show(0); App.shell.intoScreen();
    if (!l) { App.shell.goto('settings'); App.toast('Adicione uma lista para começar'); return; }
    App.catalog.init(l).then(function (has) {
      /* retomada do ultimo canal: so depois do catalogo carregado, uma unica vez,
         e nunca para conteudo adulto (a decisao fica em App.resume.decide) */
      var alvo = App.resume.startup();
      if (alvo) {
        var itensFav = App.catalog.items('live', alvo.c);
        App.actions.playLive(alvo, itensFav && itensFav.length ? itensFav : null);
      }
      if (App.isOnline() && (!has || App.catalog.needsRefresh())) App.catalog.refresh(l);
      else if (!App.isOnline()) refreshStatus();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(window);
