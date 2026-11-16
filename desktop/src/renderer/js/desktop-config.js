/* Camada desktop do renderer — carregada DEPOIS do núcleo tv/js e ANTES do shell/web.
 *
 * Contrato §3.1:
 *   App.isDesktop = true
 *   App.desktop = { version, offline, platform }
 *   App.desktopMenu() -> [{id:'downloads', label:'Baixados', make()}]
 *   App.desktop.api.registerMediaHosts(hosts)
 *
 * Também concentra dois helpers internos usados pelo bootstrap:
 *   App.desktop.collectMediaHosts()  -> Promise<string[]> (hosts das listas/catálogo)
 *   App.desktop.registerMediaHosts() -> Promise (coleta + registra no main)
 */
(function (g) {
  'use strict';
  var App = g.App;
  if (!App) return;

  var space = g.space || null;

  App.isDesktop = true;
  App.desktop = {
    version: '',
    offline: false,
    platform: 'win32'
  };

  /* Plataforma real (Windows esperado; nunca usado para decisão de segurança). */
  try {
    var ua = String((g.navigator && g.navigator.userAgent) || '');
    if (/Windows/i.test(ua)) App.desktop.platform = 'win32';
    else if (/Mac OS X|Macintosh/i.test(ua)) App.desktop.platform = 'darwin';
    else if (/Linux/i.test(ua)) App.desktop.platform = 'linux';
  } catch (e) { /* mantém win32 do contrato */ }

  /* Tela de emergência: se o módulo de downloads ainda não existir, "Baixados"
     não pode derrubar o shell (make() é chamado antes de qualquer guard). */
  function fallbackDownloadsScreen() {
    return {
      hints: [],
      mount: function (root) {
        App.clear(root);
        var box = App.el('div', 'empty');
        box.appendChild(App.el('h2', 'h2', 'Baixados'));
        box.appendChild(App.el('div', 'body-sm',
          'A área de downloads ainda não está disponível nesta versão. ' +
          'Suas listas continuam funcionando normalmente.'));
        root.appendChild(box);
      },
      unmount: function () {},
      enter: function () { return true; },
      key: function (a) { return a === 'back'; }
    };
  }

  App.desktopMenu = function () {
    return [{
      id: 'downloads',
      label: 'Baixados',
      make: function () {
        if (App.screens && typeof App.screens.downloads === 'function') return App.screens.downloads();
        return fallbackDownloadsScreen();
      }
    }];
  };

  /* ---------- hosts de mídia ---------- */

  function hostOfUrl(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    try {
      var u = new g.URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return String(u.hostname || '').toLowerCase().replace(/\.+$/, '');
    } catch (e) {
      return '';
    }
  }

  function isLoopbackName(host) {
    var h = String(host || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || /^127\./.test(h);
  }

  /* Hosts do EPG declarados no cabeçalho #EXTM3U: `url-tvg`/`x-tvg-url` podem ter
     várias URLs separadas por espaço. Sem isso, EPG Xtream/M3U com servidor
     diferente da mídia cairia em 403 no /_epg/source (a allowlist é do servidor). */
  function addTvgHeader(head, addFn) {
    if (!head || typeof head !== 'object') return;
    for (var key in head) {
      if (!Object.prototype.hasOwnProperty.call(head, key)) continue;
      if (!/^(url-tvg|x-tvg-url)$/i.test(String(key))) continue;
      var value = head[key];
      if (Array.isArray(value)) value = value.join(' ');
      String(value == null ? '' : value)
        .split(/[\s,;]+/)
        .forEach(function (rawUrl) {
          if (!rawUrl) return;
          addFn(hostOfUrl(rawUrl));
          if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) addFn(normalizeBareHost(rawUrl));
        });
    }
  }

  /* Aceita "epg.exemplo.com/guia.xml" (sem esquema) porque há provedores que
     informam o EPG assim no cabeçalho. */
  function normalizeBareHost(raw) {
    var s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) return '';
    s = s.split('/')[0].split('?')[0].split('#')[0];
    var m = /^([a-z0-9._-]+)(?::\d+)?$/.exec(s);
    return m ? m[1] : '';
  }

  /* Junta hosts das listas (M3U/Xtream), das URLs de mídia já carregadas no
     catálogo e das fontes de EPG (cabeçalho M3U + servidor Xtream do xmltv.php).
     Nunca inclui usuário/senha: só o hostname. */
  function collectMediaHosts() {
    var seen = {};
    var out = [];

    function add(host) {
      var h = String(host || '').toLowerCase().replace(/\.+$/, '');
      if (!h || isLoopbackName(h) || seen[h]) return;
      if (out.length >= 200) return;
      seen[h] = true;
      out.push(h);
    }

    var tasks = [];
    try {
      (App.lists.all() || []).forEach(function (l) {
        if (!l) return;
        if (l.type === 'm3u') {
          if (l.source === 'file') return; /* URL só aparece no catálogo, abaixo */
          tasks.push(Promise.resolve(App.lists.creds(l)).then(function (c) {
            add(hostOfUrl(c && c.url));
          }, function () { /* lista sem credencial legível: ignora */ }));
        } else if (l.type === 'xtream') {
          /* Inclui o host do xmltv.php: no Xtream ele é `server + /xmltv.php`. */
          add(hostOfUrl(l.server));
        }
      });
    } catch (e) { /* store indisponível: segue com o catálogo */ }

    try {
      var data = App.catalog && App.catalog.data ? App.catalog.data : null;
      if (data) {
        /* Fontes de EPG do cabeçalho #EXTM3U (mesmo em lista de arquivo local). */
        addTvgHeader(data.head, add);
        ['live', 'movie', 'series'].forEach(function (type) {
          var list = data[type] || [];
          for (var i = 0; i < list.length; i++) {
            add(hostOfUrl(list[i] && list[i].u));
            if (out.length >= 200) break;
          }
        });
      }
    } catch (e) { /* catálogo vazio: ok */ }

    return Promise.all(tasks).then(function () { return out; });
  }

  function registerMediaHosts() {
    return collectMediaHosts().then(function (hosts) {
      if (!hosts.length) return false;
      if (space && typeof space.registerMediaHosts === 'function') {
        return Promise.resolve(space.registerMediaHosts(hosts)).then(function () { return true; }, function () { return false; });
      }
      return false;
    });
  }

  App.desktop.collectMediaHosts = collectMediaHosts;
  App.desktop.registerMediaHosts = registerMediaHosts;

  App.desktop.api = {
    registerMediaHosts: function (hosts) {
      var list = Array.isArray(hosts) ? hosts : [];
      if (!list.length) return Promise.resolve(false);
      if (space && typeof space.registerMediaHosts === 'function') {
        return Promise.resolve(space.registerMediaHosts(list)).then(function () { return true; }, function () { return false; });
      }
      return Promise.resolve(false);
    }
  };
})(window);
