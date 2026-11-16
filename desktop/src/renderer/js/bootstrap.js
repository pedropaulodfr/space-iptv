/* Bootstrap do renderer desktop — carregado ANTES de web/js/shell.js.
 *
 * O shell web chama App.session.init() no start dele. Aqui substituímos a sessão
 * por uma versão com semântica de DESKTOP:
 *   - gate: 200 em /api/auth/session entra; 401 manda para /login.html (igual web);
 *   - falha de rede: com usuário em cache -> modo offline de verdade (Baixados e
 *     Configurações funcionam, sem inventar login offline); sem cache -> painel
 *     bloqueante "Sem conexão com o servidor" com "Tentar de novo";
 *   - isAdmin SEMPRE false (o desktop não tem administração);
 *   - papel exibido sempre "usuário";
 *   - logout: API + cookies/cache do main + cache de usuário + /login.html.
 *
 * Também cuida de: HUD (offline/downloads/usuário), cache de usuário, registro de
 * hosts de mídia, atalho G do guia, eventos de bandeja/rede/atualização.
 * Sem jQuery: só DOM e Promise.
 */
(function (g) {
  'use strict';

  var App = g.App;
  if (!App || !App.session) return;

  var space = g.space || null;
  var doc = g.document;
  var originalInit = App.session.init;

  var S = {
    currentUser: null,
    cachedUser: null,
    offline: false,
    gate: null,
    started: false,
    blocking: false,
    downloadItems: {},
    hostsTimer: null
  };

  /* ============================ utilidades ============================ */

  function $(id) { return doc.getElementById(id); }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  }

  function overlaysOpen() {
    var o = $('overlays');
    return !!(o && o.children.length);
  }

  function playerOpen() {
    var p = $('player');
    return !!(p && p.classList.contains('open'));
  }

  function toast(message, ms) {
    try { if (typeof App.toast === 'function') App.toast(message, ms); } catch (e) { /* ignore */ }
  }

  function logSafe() {
    if (typeof App.log !== 'function') return;
    try { App.log.apply(App, arguments); } catch (e) { /* ignore */ }
  }

  function normalizeUser(raw) {
    if (!raw || typeof raw !== 'object' || !raw.email) return null;
    return {
      id: raw.id ? String(raw.id) : '',
      email: String(raw.email),
      name: raw.name ? String(raw.name) : '',
      role: 'user' /* desktop nunca expõe papel administrativo */
    };
  }

  function truncateEmail(email) {
    var e = String(email || '');
    return e.length > 30 ? e.slice(0, 29) + '…' : e;
  }

  function goLogin() {
    var here = String(g.location.pathname || '/') + String(g.location.search || '');
    if (here === '/' || here === '/index.html') here = '/';
    try { g.location.replace('/login.html?next=' + encodeURIComponent(here)); } catch (e) { /* ignore */ }
  }

  /* ============================ sessão ============================ */

  function fetchSession() {
    return fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      return res.text().then(function (raw) {
        var data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function cacheUser(user) {
    S.cachedUser = user;
    if (!space || !space.session || typeof space.session.setCachedUser !== 'function') return Promise.resolve(false);
    try {
      return Promise.resolve(space.session.setCachedUser({
        email: user.email, name: user.name, role: 'user'
      })).then(function () { return true; }, function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function loadCachedUser() {
    S.cachedUser = null;
    if (!space || !space.session || typeof space.session.getCachedUser !== 'function') return Promise.resolve(null);
    try {
      return Promise.resolve(space.session.getCachedUser()).then(function (user) {
        S.cachedUser = normalizeUser(user);
        return S.cachedUser;
      }, function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function registerMediaHostsSoon() {
    if (S.hostsTimer) clearTimeout(S.hostsTimer);
    S.hostsTimer = setTimeout(function () {
      S.hostsTimer = null;
      var reg = App.desktop && typeof App.desktop.registerMediaHosts === 'function'
        ? App.desktop.registerMediaHosts()
        : Promise.resolve(false);
      Promise.resolve(reg).then(null, function () { /* nunca interrompe o boot */ });
    }, 600);
  }

  function applyOffline(on) {
    S.offline = !!on;
    if (App.desktop) App.desktop.offline = S.offline;
    paintOfflineBadge();
    if (App.bus) App.bus.emit('session', S.currentUser);
  }

  function enterOfflineMode(user, reason) {
    S.currentUser = user;
    applyOffline(true);
    logSafe('bootstrap: modo offline (' + (reason || 'rede') + ')');
    toast('Sem conexão com o servidor. Baixados e Configurações continuam funcionando.', 6000);
  }

  /* Painel bloqueante: só quando não há usuário em cache (sem login offline inventado). */
  function showBlockingPanel(detail) {
    if (S.blocking) return;
    S.blocking = true;
    var root = $('overlays') || doc.body;
    var overlay = doc.createElement('div');
    overlay.className = 'overlay';
    overlay.id = 'boot-offline';
    var modal = doc.createElement('div');
    modal.className = 'modal glass-panel boot-block';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'boot-offline-title');

    var title = App.el('h2', 'h2', 'Sem conexão com o servidor');
    title.id = 'boot-offline-title';
    modal.appendChild(title);

    var msg = App.el('div', 'msg',
      detail || 'Não foi possível falar com o servidor do Space IPTV. Verifique sua internet e tente de novo.');
    modal.appendChild(msg);

    var note = App.el('div', 'body-sm',
      'Nada foi apagado: suas listas e favoritos continuam salvos neste computador.');
    modal.appendChild(note);

    var btns = App.el('div', 'btns');
    /* Botões NATIVOS (`<button class="btn">`) para foco/teclado/ARIA corretos. */
    var retry = doc.createElement('button');
    retry.type = 'button';
    retry.className = 'btn primary';
    retry.textContent = 'Tentar de novo';
    retry.setAttribute('aria-label', 'Tentar de novo');

    var quit = doc.createElement('button');
    quit.type = 'button';
    quit.className = 'btn';
    quit.textContent = 'Fechar aplicativo';
    quit.setAttribute('aria-label', 'Fechar aplicativo');

    function doRetry() { try { g.location.reload(); } catch (e) { /* ignore */ } }
    retry.addEventListener('click', doRetry);
    quit.addEventListener('click', function () {
      if (space && space.app && typeof space.app.quit === 'function') { try { space.app.quit(); } catch (e) { /* ignore */ } }
    });

    btns.appendChild(quit);
    btns.appendChild(retry);
    modal.appendChild(btns);
    overlay.appendChild(modal);
    root.appendChild(overlay);
    try { retry.focus(); } catch (e) { /* ignore */ }

    doc.addEventListener('keydown', function onKey(ev) {
      if (!S.blocking) { doc.removeEventListener('keydown', onKey, true); return; }
      if (ev.key === 'Enter') { ev.preventDefault(); doRetry(); }
    }, true);
  }

  function resolveOnline(found) {
    S.currentUser = found;
    applyOffline(false);
    paintUser();
    cacheUser(found);
    registerMediaHostsSoon();
    return true;
  }

  /* Gate real. Memoizado para o shell ver a mesma promessa. */
  function gate() {
    if (S.gate) return S.gate;
    S.gate = loadCachedUser().then(function (cached) {
      return fetchSession().then(function (res) {
        if (res.ok && res.data && res.data.user) return resolveOnline(normalizeUser(res.data.user));
        if (res.status === 401 || res.status === 403) { goLogin(); return false; }
        /* Servidor respondeu mas sem sessão válida (502/503/etc). */
        if (cached) { enterOfflineMode(cached, 'api ' + res.status); return true; }
        showBlockingPanel(res.data && res.data.message ? String(res.data.message) : '');
        return false;
      }, function () {
        /* Falha de rede (fetch rejeitou). */
        if (cached) { enterOfflineMode(cached, 'network'); return true; }
        showBlockingPanel('');
        return false;
      });
    });
    return S.gate;
  }

  /* Substitui a sessão web. As telas continuam chamando App.session.* normalmente. */
  App.session.init = function () { return gate(); };
  App.session.user = function () { return S.currentUser; };
  App.session.ready = function () { return !!S.currentUser; };
  App.session.isAdmin = function () { return false; };
  App.session.email = function () { return S.currentUser ? S.currentUser.email : ''; };
  App.session.roleLabel = function () { return 'usuário'; };

  /* Logout: API (limpa cookies HttpOnly no backend) + cookies/cache locais + login. */
  App.session.logout = function () {
    var apiCall;
    try {
      apiCall = fetch('/api/auth/logout', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store'
      }).then(null, function () { return null; });
    } catch (e) {
      apiCall = Promise.resolve(null);
    }
    return apiCall.then(function () {
      S.currentUser = null;
      S.cachedUser = null;
      applyOffline(false);
      var tasks = [];
      if (space && space.session) {
        if (typeof space.session.clearCachedUser === 'function') {
          tasks.push(Promise.resolve(space.session.clearCachedUser()).then(null, function () { return null; }));
        }
        if (typeof space.session.clearCookies === 'function') {
          tasks.push(Promise.resolve(space.session.clearCookies()).then(null, function () { return null; }));
        }
      }
      return Promise.all(tasks);
    }).then(function () {
      try { g.location.replace('/login.html'); } catch (e) { /* ignore */ }
      return true;
    });
  };

  /* ============================ HUD ============================ */

  function paintUser() {
    var el = $('hud-user');
    if (!el) return;
    if (!S.currentUser) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = truncateEmail(S.currentUser.email);
    el.title = S.currentUser.email + ' • usuário';
    el.setAttribute('aria-label', 'Conta: ' + S.currentUser.email + ', usuário');
  }

  function paintOfflineBadge() {
    var el = $('hud-offline');
    if (!el) return;
    el.hidden = !S.offline;
    if (S.offline) {
      el.title = 'Sem conexão com o servidor. Baixados e Configurações continuam disponíveis.';
      el.textContent = 'Offline';
    }
  }

  function paintDownloadsHud() {
    var el = $('hud-downloads');
    if (!el) return;
    var items = [];
    for (var id in S.downloadItems) if (Object.prototype.hasOwnProperty.call(S.downloadItems, id)) items.push(S.downloadItems[id]);
    var active = 0;
    var sum = 0;
    var counted = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      if (it.status === 'downloading' || it.status === 'queued' || it.status === 'packaging' || it.status === 'paused') {
        active++;
        if (it.status === 'downloading' || it.status === 'paused') {
          var p = Number(it.progress);
          if (isFinite(p)) { sum += p > 1 ? p / 100 : p; counted++; }
        }
      }
    }
    if (!active) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    var text = 'Baixando ' + active;
    if (counted) text += ' · ' + Math.round((sum / counted) * 100) + '%';
    el.hidden = false;
    el.textContent = text;
    el.title = 'Fila de downloads';
  }

  function onDownloadEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    var item = payload.item;
    if (item && item.id) {
      if (payload.type === 'removed') delete S.downloadItems[item.id];
      else S.downloadItems[item.id] = item;
    }
    if (payload.stats && Array.isArray(payload.stats.items)) {
      S.downloadItems = {};
      payload.stats.items.forEach(function (it) { if (it && it.id) S.downloadItems[it.id] = it; });
    }
    paintDownloadsHud();
  }

  /* ============================ eventos externos ============================ */

  function wireSpaceEvents() {
    if (!space) return;
    if (space.downloads && typeof space.downloads.onEvent === 'function') {
      try { space.downloads.onEvent(onDownloadEvent); } catch (e) { /* módulo ainda ausente */ }
    }
    if (space.events && typeof space.events.on === 'function') {
      try {
        space.events.on('tray', function (payload) {
          if (!payload) return;
          if (payload.action === 'downloads') {
            if (App.shell && typeof App.shell.goto === 'function') {
              App.shell.goto('downloads');
            } else {
              toast('Abra a tela Baixados pelo menu.');
            }
          }
        });
      } catch (e) { /* ignore */ }
      try {
        space.events.on('network', function (payload) {
          if (!payload) return;
          if (payload.portFallback) {
            toast('A porta interna padrão estava ocupada; esta execução usa a porta ' + payload.port + '.', 6000);
          }
          if (payload.online === false && S.offline) paintOfflineBadge();
        });
      } catch (e) { /* ignore */ }
      try {
        space.events.on('update', function (payload) {
          if (!payload) return;
          if (payload.state === 'downloaded') {
            toast('Atualização baixada. Ela será aplicada quando você fechar o aplicativo.', 7000);
          } else if (payload.state === 'warning' && payload.message) {
            toast(String(payload.message), 7000);
          }
        });
      } catch (e) { /* ignore */ }
    }
  }

  function wireBrowserEvents() {
    g.addEventListener('offline', function () {
      if (!S.currentUser) return;
      applyOffline(true);
    });
    g.addEventListener('online', function () {
      if (!S.offline) return;
      var reloadAfter = function (ok) {
        if (!ok) return;
        toast('Conexão restabelecida.');
        setTimeout(function () { try { g.location.reload(); } catch (e) { /* ignore */ } }, 900);
      };
      fetchSession().then(function (res) {
        reloadAfter(!!(res.ok && res.data && res.data.user));
      }, function () { /* ainda sem rede */ });
    });
  }

  /* ============================ atalho G (guia) ============================ */

  function wireGuideShortcut() {
    doc.addEventListener('keydown', function (ev) {
      var key = ev.key || '';
      if (key !== 'g' && key !== 'G') return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (isEditable(ev.target || doc.activeElement)) return;
      if (overlaysOpen() || playerOpen()) return;
      var guide = App.desktop && App.desktop.guide;
      if (!guide || typeof guide.open !== 'function') {
        /* Sem módulo de EPG ainda: avisa uma única vez, sem quebrar nada. */
        if (!S.guideWarned) {
          S.guideWarned = true;
          toast('Guia de programação ainda não disponível nesta versão.');
        }
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      try { guide.open(); } catch (e) { logSafe('guia falhou', e && e.message); }
    }, true);
  }

  /* ============================ versão / info ============================ */

  function wireAppInfo() {
    if (!space || !space.app) return;
    if (typeof space.app.version === 'function') {
      try {
        Promise.resolve(space.app.version()).then(function (v) {
          App.desktop.version = String(v || '');
          var el = $('hud-version');
          if (el) el.textContent = App.desktop.version;
        }, function () { /* ignore */ });
      } catch (e) { /* ignore */ }
    }
  }

  /* ============================ start ============================ */

  function start() {
    if (S.started) return;
    S.started = true;
    paintUser();
    paintOfflineBadge();
    paintDownloadsHud();
    wireSpaceEvents();
    wireBrowserEvents();
    wireGuideShortcut();
    wireAppInfo();

    /* Registra hosts de mídia também quando listas/catálogo mudarem. */
    if (App.bus && typeof App.bus.on === 'function') {
      App.bus.on('catalog:done', registerMediaHostsSoon);
      App.bus.on('lists', registerMediaHostsSoon);
      App.bus.on('session', function (user) { if (user) paintUser(); });
    }

    /* Dispara o gate já no boot; o shell vai reaproveitar a mesma promessa. */
    gate().then(function (ok) {
      if (!ok) return;
      paintUser();
      registerMediaHostsSoon();
    }, function (err) {
      logSafe('bootstrap: gate falhou', err && err.message);
    });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
