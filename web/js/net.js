/* Ajustes de rede da versao web: mensagens de CORS + proxy local opcional.
 *
 * Contrato congelado (web/NOTES.md §9), sem editar tv/js:
 *   App.net.init()        -> Promise<boolean> idempotente; nunca rejeita
 *   App.net.active()      -> bool (proxy disponivel e ligado)
 *   App.net.proxy(url)    -> /__proxy?url=... (apenas http:// e https://)
 *   App.net.mediaUrl(url) -> reescreve so .m3u8/.ts quando ativo; MP4 intacto
 *   App.net.ready()       -> bool (atalho para a UI)
 *   App.net.reason()      -> motivo do estado ('idle'|'pending'|'ready'|...)
 *   App.net.friendly(err) -> App.friendly estendido (network/opaque/abort)
 *
 * Com o proxy ativo, App.http.get/stream/probe reescrevem URLs http(s)
 * cross-origin para o proxy same-origin. O metodo .abort da promessa de probe
 * e preservado (App.health.cancel depende dele) e os erros continuam no
 * formato {code,status}. Sem proxy, nada e envolvido: o app segue igual.
 * Nao registra URL/credenciais e nao usa telemetria/CDN.
 */
(function (g) {
  'use strict';
  if (!g) return;

  var App = g.App = g.App || {};
  if (App.net && App.net.__webNet) return; /* ja carregado: nao envolve duas vezes */

  var PING_PATH = '/__proxy/ping';
  var PING_TIMEOUT = 1500;
  var loc = (typeof g.location !== 'undefined' && g.location) ? g.location : null;

  var active = false;
  var reason = 'idle';
  var initPromise = null;
  var wrapped = false;

  var originalFriendly = (typeof App.friendly === 'function') ? App.friendly : null;

  function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  function absUrl(url) {
    if (!isHttpUrl(url) || typeof g.URL !== 'function') return null;
    try { return new g.URL(url); } catch (e) { return null; }
  }

  function sameOrigin(u) {
    return !!(loc && loc.origin && u && u.origin === loc.origin);
  }

  function pathnameOf(url) {
    var u = absUrl(url);
    if (u) return u.pathname;
    /* fallback sem URL(): descarta query/hash e pega o caminho */
    var s = String(url).split('#')[0].split('?')[0];
    var m = /^https?:\/\/[^\/]*(\/[^?#]*)?/i.exec(s);
    return (m && m[1]) || '/';
  }

  /* URL same-origin do proxy; entrada nao-http(s) volta intacta. */
  function proxy(url) {
    if (!isHttpUrl(url)) return url;
    return '/__proxy?url=' + encodeURIComponent(url);
  }

  function isMediaUrl(url) {
    if (!isHttpUrl(url)) return false;
    return /\.(m3u8|ts)$/i.test(pathnameOf(url));
  }

  /* get/stream/probe: so http(s) cross-origin precisa do proxy. */
  function shouldProxy(url) {
    if (!active || !isHttpUrl(url)) return false;
    var u = absUrl(url);
    if (!u) return false;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return !sameOrigin(u);
  }

  function mediaUrl(url) {
    if (!active || !isMediaUrl(url)) return url;
    return proxy(url);
  }

  /* Envolve App.http uma unica vez. Delega os erros/formatos originais. */
  function install() {
    if (wrapped) return;
    var http = App.http;
    if (!http) return;

    if (typeof http.get === 'function') {
      var get0 = http.get;
      http.get = function (url, opts) {
        return get0.call(http, shouldProxy(url) ? proxy(url) : url, opts);
      };
    }

    if (typeof http.stream === 'function') {
      var stream0 = http.stream;
      http.stream = function (url, opts) {
        return stream0.call(http, shouldProxy(url) ? proxy(url) : url, opts);
      };
    }

    if (typeof http.probe === 'function') {
      var probe0 = http.probe;
      http.probe = function (url, opts) {
        var p = probe0.call(http, shouldProxy(url) ? proxy(url) : url, opts);
        if (p && typeof p.then === 'function' && typeof p.abort === 'function') {
          var abort0 = p.abort;
          p.abort = function () {
            try { abort0.call(p); } catch (e) { /* ignore */ }
          };
        }
        return p;
      };
    }

    wrapped = true;
  }

  function settle(ok, why) {
    active = !!ok;
    reason = ok ? 'ready' : (why || 'unavailable');
    if (active) {
      try { install(); } catch (e) { /* nunca deixa init rejeitar */ }
    }
  }

  /* Idempotente: uma unica sondagem por sessao; nunca rejeita. */
  function init() {
    if (initPromise) return initPromise;
    reason = 'pending';

    initPromise = new Promise(function (resolve) {
      try {
        if (!loc || !/^https?:$/.test(String(loc.protocol || ''))) {
          settle(false, 'disabled');
          return resolve(false);
        }
        if (typeof g.XMLHttpRequest !== 'function') {
          settle(false, 'unsupported');
          return resolve(false);
        }

        var finished = false;
        var xhr = null;

        function done(ok, why) {
          if (finished) return;
          finished = true;
          if (xhr) { try { xhr.abort(); } catch (e) { /* ignore */ } }
          settle(ok, why);
          resolve(active);
        }

        try {
          xhr = new g.XMLHttpRequest();
          xhr.open('GET', PING_PATH, true);
          xhr.timeout = PING_TIMEOUT;
          xhr.onload = function () {
            if (xhr.status !== 200) return done(false, 'unavailable');
            var data = null;
            try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
            done(!!(data && data.ok === true), data && data.ok === true ? 'ready' : 'unavailable');
          };
          xhr.onerror = function () { done(false, 'unavailable'); };
          xhr.ontimeout = function () { done(false, 'timeout'); };
          xhr.onabort = function () { done(false, 'unavailable'); };
          xhr.send();
        } catch (e) {
          done(false, 'unavailable');
        }
      } catch (e) {
        active = false;
        reason = 'error';
        resolve(false);
      }
    });

    return initPromise;
  }

  function baseFriendly(err) {
    if (originalFriendly) return originalFriendly(err);
    var c = err && err.code;
    if (c === 'offline') return 'Sem conexão com a internet. Verifique a rede.';
    if (c === 'timeout') return 'O servidor demorou demais para responder.';
    if (c === 'auth') return 'Usuário ou senha incorretos.';
    if (c === 'invalid') return 'A lista não é válida ou está vazia.';
    if (c === 'http') return 'O servidor recusou a requisição (código ' + (err.status || '?') + ').';
    if (c === 'network') return 'Não foi possível acessar o servidor. Confira o endereço e se ele está online.';
    if (c === 'parse') return 'O servidor respondeu em um formato inesperado.';
    return 'Não foi possível carregar a lista.';
  }

  /* Estende App.friendly: dica de CORS em 'network' e mensagens em opaque/abort. */
  function friendly(err) {
    var code = err && err.code;
    if (code === 'opaque') {
      return 'O servidor respondeu, mas o navegador não permitiu ler a resposta (CORS). O canal pode funcionar no player; a verificação de saúde fica limitada.';
    }
    if (code === 'abort') return 'Verificação cancelada.';
    var msg = baseFriendly(err);
    if (code === 'network') {
      return msg + ' Verifique também se o servidor permite acesso pelo navegador (CORS).';
    }
    return msg;
  }

  App.net = {
    init: init,
    active: function () { return active; },
    proxy: proxy,
    mediaUrl: mediaUrl,
    ready: function () { return active; },
    reason: function () { return reason; },
    friendly: friendly,
    __webNet: true
  };

  if (originalFriendly) {
    try { App.friendly = friendly; } catch (e) { /* ignore */ }
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
