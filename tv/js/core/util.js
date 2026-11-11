/* Nucleo: namespace, helpers, barramento de eventos, logs seguros */
(function (g) {
  'use strict';
  var App = g.App = g.App || {};
  App.screens = App.screens || {};

  App.el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  App.$ = function (sel, root) { return (root || document).querySelector(sel); };
  App.clear = function (node) { while (node.firstChild) node.removeChild(node.firstChild); };
  App.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  App.uid = function () { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); };

  App.hash = function (s) {
    var h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };

  /* minusculas, sem acento, para busca */
  App.norm = function (s) {
    s = String(s == null ? '' : s).toLowerCase();
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* sem normalize */ }
    return s;
  };

  App.pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  App.fmtTime = function (sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + App.pad(m) : m) + ':' + App.pad(s);
  };
  App.fmtDate = function (ts) {
    if (!ts) return 'nunca';
    var d = new Date(ts);
    return App.pad(d.getDate()) + '/' + App.pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + App.pad(d.getHours()) + ':' + App.pad(d.getMinutes());
  };
  App.debounce = function (fn, ms) {
    var t = null;
    var d = function () { var a = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms); };
    d.cancel = function () { clearTimeout(t); };
    return d;
  };
  App.yield = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  /* Remove credenciais de qualquer texto antes de logar ou mostrar */
  App.redact = function (s) {
    s = String(s == null ? '' : s);
    return s
      .replace(/(\/\/)[^\/\s:@]+:[^\/\s@]*@/g, '$1***@')
      .replace(/([?&](?:username|password|user|pass|token|key)=)[^&\s"']*/gi, '$1***')
      .replace(/\/(live|movie|series)\/[^\/\s]+\/[^\/\s]+\//g, '/$1/***/***/')
      .replace(/https?:\/\/[^\s"']+/g, function (u) { return u.replace(/^(https?:\/\/[^\/?#]+).*/, '$1/...'); });
  };
  App.log = function () {
    var out = [], i;
    for (i = 0; i < arguments.length; i++) out.push(typeof arguments[i] === 'string' ? App.redact(arguments[i]) : arguments[i]);
    try { console.log.apply(console, out); } catch (e) { /* ignore */ }
  };

  /* Eventos */
  var subs = {};
  App.bus = {
    on: function (ev, fn) { (subs[ev] = subs[ev] || []).push(fn); },
    off: function (ev, fn) { var a = subs[ev] || [], i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    emit: function (ev, data) { (subs[ev] || []).slice().forEach(function (f) { try { f(data); } catch (e) { App.log('bus erro', ev, e && e.message); } }); }
  };

  /* Toast */
  var toastT = null;
  App.toast = function (msg, ms) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.className = 'show';
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.className = ''; }, ms || 2600);
  };

  /* Mensagens amigaveis para erros de rede/parse */
  App.friendly = function (err) {
    var c = err && err.code;
    if (c === 'offline') return 'Sem conexão com a internet. Verifique a rede da TV.';
    if (c === 'timeout') return 'O servidor demorou demais para responder.';
    if (c === 'auth') return 'Usuário ou senha incorretos.';
    if (c === 'invalid') return 'A lista não é válida ou está vazia.';
    if (c === 'http') return 'O servidor recusou a requisição (código ' + (err.status || '?') + ').';
    if (c === 'network') return 'Não foi possível acessar o servidor. Confira o endereço e se ele está online.';
    if (c === 'parse') return 'O servidor respondeu em um formato inesperado.';
    return 'Não foi possível carregar a lista.';
  };

  App.isOnline = function () { return navigator.onLine !== false; };
})(window);
