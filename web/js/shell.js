/* Shell web: menu lateral, HUD, troca de telas, startup, palco escalado e tela cheia.
   Recria tv/js/main.js SEM o modal de saída e SEM o zapping de Tizen, mantendo App.shell
   com a mesma superfície usada pelas telas. */
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
  var stage, warnEl, fitRaf = 0;

  function icon(id) { return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICONS[id] + '</svg>'; }

  /* ---------- dicas do rodapé: traduz as teclas da TV para as do navegador ---------- */
  function webHint(t) {
    return String(t == null ? '' : t)
      .replace(/segurar OK/gi, 'segurar Enter')
      .replace(/AMARELO/g, 'F')
      .replace(/AZUL/g, 'X')
      .replace(/INFO/g, 'I')
      .replace(/VOLTAR/g, 'Esc');
  }
  function hints(list) {
    var h = document.getElementById('hints');
    App.clear(h);
    ['◀▶▲▼ navegar', 'OK selecionar', 'Esc voltar'].concat(list || []).forEach(function (t) {
      h.appendChild(App.el('span', null, webHint(t)));
    });
  }

  /* ---------- menu lateral ---------- */
  function buildMenu() {
    side = document.getElementById('sidebar'); screenEl = document.getElementById('screen');
    MENU.forEach(function (m) {
      if (m.sep) { side.appendChild(App.el('div', 'nav-sep')); return; }
      var n = App.el('div', 'nav-item');
      n.innerHTML = icon(m.id);                       /* SVG estático do próprio app (sem dado remoto) */
      n.appendChild(App.el('span', null, m.label));
      n.setAttribute('tabindex', '-1');
      n.setAttribute('role', 'link');
      side.appendChild(n); nodes.push(n); items.push(m);
    });
  }
  function paintMenu() {
    nodes.forEach(function (n, i) {
      n.classList[i === curIdx ? 'add' : 'remove']('active');
      n.classList[area === 'menu' && i === menuIdx ? 'add' : 'remove']('focused');
      if (i === curIdx) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
    });
  }

  /* A tela de Configurações é compartilhada com a TV e diz que as senhas ficam
     criptografadas. Fora de localhost/https o WebCrypto não existe e o store.js cai em
     p0: (Base64), que NÃO é criptografia. Corrigimos apenas o texto na web. */
  function fixInsecureStorageNote() {
    if (g.isSecureContext !== false) return;
    var about = document.querySelector('#screen .about');
    if (!about) return;
    about.textContent = 'Space IPTV 1.0 • Reprodutor de listas fornecidas por você. O aplicativo não inclui canais nem conteúdo. ' +
      'Nesta conexão HTTP fora de localhost, as senhas ficam apenas codificadas no armazenamento local — isso não é criptografia. ' +
      'Use https:// ou localhost para obter AES-GCM.';
  }

  function show(i) {
    if (cur) { cur.unmount(); App.clear(screenEl); }
    curIdx = i; cur = items[i].make(); cur.mount(screenEl);
    paintMenu();
    fixInsecureStorageNote();
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
      if (cur && cur.enter()) { area = 'screen'; paintMenu(); hints(cur.hints); return true; }
      App.shell.toMenu();
      return false;
    },
    /* ponte de ponteiro: menu lateral (idx < 0 mantém o item atual) */
    hoverMenu: function (idx) {
      if (typeof idx === 'number' && idx >= 0) menuIdx = idx;
      area = 'menu'; paintMenu(); hints(['OK abrir seção']);
      return true;
    },
    /* ponteiro de volta na área da tela */
    hoverScreen: function () {
      if (area === 'screen') return true;
      if (!cur) return false;
      return App.shell.intoScreen();
    }
  };

  /* `exit` não fecha a aba (sem modal): só avisa, como manda o contrato da web. */
  var exitAt = 0;
  function exitHint() {
    var now = Date.now();
    if (now - exitAt < 1500) return;
    exitAt = now;
    App.toast('Feche a aba do navegador para sair do Space IPTV');
  }

  var shellLayer = {
    key: function (a) {
      if (a === 'exit') { exitHint(); return true; }
      /* 1..9: canal favorito correspondente, de qualquer tela (o player trata por cima) */
      if (a && a.length === 2 && a.charAt(0) === 'n' && a !== 'n0') {
        App.actions.playFavNumber(+a.charAt(1));
        return true;
      }
      if (area === 'screen') {
        if (cur && cur.key(a)) return true;
        if (a === 'left' || a === 'back') { App.shell.toMenu(); return true; }
        return true;
      }
      if (a === 'up') { if (menuIdx > 0) { menuIdx--; paintMenu(); } return true; }
      if (a === 'down') { if (menuIdx < items.length - 1) { menuIdx++; paintMenu(); } return true; }
      if (a === 'ok' || a === 'right') { if (menuIdx !== curIdx) show(menuIdx); App.shell.intoScreen(); return true; }
      if (a === 'back') return true;       /* web: nada para "sair" pelo Esc no menu */
      return true;
    }
  };

  /* ---------- HUD ---------- */
  function clock() {
    var d = new Date();
    document.getElementById('hud-clock').textContent = App.pad(d.getHours()) + ':' + App.pad(d.getMinutes());
  }
  function hudStatus(text, cls) {
    var s = document.getElementById('hud-status');
    s.textContent = text || '';
    s.className = 'badge' + (cls ? ' ' + cls : '');
  }
  function hudList() {
    var l = App.lists.active();
    document.getElementById('hud-list').textContent = l ? l.name : 'Sem lista';
  }
  function paintProxy() {
    var el = document.getElementById('hud-proxy');
    if (!el) return;
    var on = !!(App.net && typeof App.net.active === 'function' && App.net.active());
    el.hidden = !on;
    el.title = on ? 'As requisições passam pelo servidor local (proxy)' : '';
  }
  function refreshStatus() {
    if (!App.isOnline()) return hudStatus('Sem internet • dados salvos', 'warn');
    if (App.catalog.isLoading()) return;
    hudStatus('');
  }

  App.bus.on('catalog:loading', function (p) {
    if (p >= 0 && p < 1) hudStatus('Atualizando ' + Math.round(p * 100) + '%');
    else refreshStatus();
  });
  App.bus.on('catalog:error', function (e) {
    hudStatus('Erro ao atualizar', 'warn');
    App.toast(e.message, 4500);
  });
  App.bus.on('catalog:done', function (o) {
    hudStatus('Atualizada', 'ok');
    setTimeout(refreshStatus, 3000);
    if (o.warns && o.warns.length) App.toast(o.warns[0], 4500);
  });
  App.bus.on('catalog', hudList);
  g.addEventListener('online', function () {
    refreshStatus();
    var l = App.lists.active();
    if (l && App.catalog.needsRefresh()) App.catalog.refresh(l);
  });
  g.addEventListener('offline', refreshStatus);

  /* ---------- palco 1920x1080 --> janela ---------- */
  function fitNow() {
    fitRaf = 0;
    if (!stage) return;
    var vw = g.innerWidth || 1920, vh = g.innerHeight || 1080;
    if (g.visualViewport && g.visualViewport.width && g.visualViewport.height) {
      vw = g.visualViewport.width; vh = g.visualViewport.height;
    }
    var s = Math.min(vw / 1920, vh / 1080);
    if (!isFinite(s) || s <= 0) s = 1;
    stage.style.transform = 'translate(' + ((vw - 1920 * s) / 2) + 'px,' + ((vh - 1080 * s) / 2) + 'px) scale(' + s + ')';
    if (warnEl) warnEl.hidden = !(vw < 1024 || vh < 576);
  }
  function scheduleFit() { if (!fitRaf) fitRaf = requestAnimationFrame(fitNow); }

  /* ---------- tela cheia ---------- */
  var fsBtn = null;
  function fullscreenEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function syncFsBtn() {
    if (!fsBtn) return;
    var on = !!fullscreenEl();
    fsBtn.setAttribute('aria-label', on ? 'Sair da tela cheia' : 'Tela cheia');
    fsBtn.title = on ? 'Sair da tela cheia (Esc)' : 'Tela cheia';
    fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function setupFullscreen() {
    fsBtn = document.getElementById('hud-fs');
    var docEl = document.documentElement;
    var can = !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen);
    if (!can) { if (fsBtn) fsBtn.hidden = true; return; }
    if (fsBtn) fsBtn.addEventListener('click', function () {
      try {
        if (fullscreenEl()) {
          if (document.exitFullscreen) document.exitFullscreen();
          else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } else if (docEl.requestFullscreen) {
          var p = docEl.requestFullscreen();
          if (p && p.then) p.then(function () { setTimeout(fitNow, 60); }, function () { /* recusado */ });
        } else {
          docEl.webkitRequestFullscreen();
        }
      } catch (e) { /* navegador bloqueou a tela cheia */ }
    });
    document.addEventListener('fullscreenchange', function () { syncFsBtn(); scheduleFit(); });
    document.addEventListener('webkitfullscreenchange', function () { syncFsBtn(); scheduleFit(); });
    syncFsBtn();
  }

  /* ---------- inicialização (mesma ordem da TV) ---------- */
  function start() {
    stage = document.getElementById('stage');
    warnEl = document.getElementById('stage-warn');
    App.registerKeys();
    buildMenu(); clock(); setInterval(clock, 30000);
    App.nav.push(shellLayer);
    App.starfield.start();
    var l = App.lists.active();
    hudList(); refreshStatus(); paintProxy();
    show(0); App.shell.intoScreen();

    /* App.net SEMPRE antes do primeiro uso do catálogo — inclusive no boot sem lista,
       para o badge "proxy local" aparecer já na tela de Configurações. */
    var netReady;
    try {
      netReady = App.net && typeof App.net.init === 'function'
        ? Promise.resolve(App.net.init()).then(null, function () { return false; })
        : Promise.resolve(false);
    } catch (e) { netReady = Promise.resolve(false); }
    netReady.then(function () { paintProxy(); });

    if (!l) { App.shell.goto('settings'); App.toast('Adicione uma lista para começar'); return; }

    netReady.then(function () {
      return App.catalog.init(l);
    }).then(function (has) {
      /* retomada do último canal: depois do catálogo, uma única vez, nunca adulto */
      var alvo = App.resume.startup();
      if (alvo && App.player && typeof App.player.play === 'function') {
        var itens = App.catalog.items('live', alvo.c);
        App.actions.playLive(alvo, itens && itens.length ? itens : null);
      }
      if (App.isOnline() && (!has || App.catalog.needsRefresh())) App.catalog.refresh(l);
      else if (!App.isOnline()) refreshStatus();
    }).then(null, function (e) { App.log('falha na inicialização web', e && e.message); });
  }

  stage = document.getElementById('stage');
  warnEl = document.getElementById('stage-warn');
  fitNow();
  setupFullscreen();
  g.addEventListener('resize', scheduleFit);
  g.addEventListener('orientationchange', scheduleFit);
  if (g.visualViewport && g.visualViewport.addEventListener) g.visualViewport.addEventListener('resize', scheduleFit);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(window);
