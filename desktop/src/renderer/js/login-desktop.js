/* Ajustes da tela de login reaproveitada (web/js/login.js continua dono do login).
 *
 * Contrato §3 / §2.4:
 *   - versão real do app no rodapé (o HTML traz um texto fixo);
 *   - aviso claro quando a API está indisponível (sem reimplementar o formulário);
 *   - NUNCA mostra dica de conta/administrador nem credenciais de teste.
 *
 * Carregado depois de web/js/login.js; não intercepta o submit, não lê a senha e
 * não guarda nada no navegador.
 */
(function (g) {
  'use strict';

  var doc = g.document;
  var space = g.space || null;
  var warningEl = null;
  var probed = false;

  function $(id) { return doc.getElementById(id); }

  function setVersion() {
    var el = $('login-version');
    if (!el) return;
    var base = 'Space IPTV' +
      ' • Reprodutor de listas fornecidas por você. O aplicativo não inclui canais nem conteúdo.';
    if (!space || !space.app || typeof space.app.version !== 'function') {
      el.textContent = base;
      return;
    }
    try {
      Promise.resolve(space.app.version()).then(function (version) {
        var v = String(version || '').trim();
        el.textContent = (v ? 'Space IPTV ' + v : 'Space IPTV') + base.slice('Space IPTV'.length);
      }, function () { el.textContent = base; });
    } catch (e) {
      el.textContent = base;
    }
  }

  function ensureWarning() {
    if (warningEl) return warningEl;
    var form = $('login-form');
    if (!form || !form.parentNode) return null;
    warningEl = doc.createElement('p');
    warningEl.className = 'login-note login-conn';
    warningEl.id = 'login-conn-warning';
    warningEl.setAttribute('role', 'status');
    warningEl.setAttribute('aria-live', 'polite');
    warningEl.hidden = true;
    form.parentNode.insertBefore(warningEl, form);
    return warningEl;
  }

  function showWarning(message) {
    var el = ensureWarning();
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }

  function hideWarning() {
    var el = ensureWarning();
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }

  /* Sonda barata na rota pública de capacidades: qualquer resposta HTTP significa
     "servidor no ar". Falha de rede / 502 => aviso claro acima do formulário. */
  function probeApi() {
    if (!g.fetch) return;
    if (g.navigator && g.navigator.onLine === false) {
      showWarning('Você está sem conexão com a internet. Verifique a rede e tente de novo.');
      return;
    }
    fetch('/api/auth/capabilities', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        probed = true;
        if (res.status >= 500) {
          showWarning('O servidor está temporariamente indisponível. Tente de novo em alguns instantes.');
        } else {
          hideWarning();
        }
      }, function () {
        probed = true;
        showWarning('Não foi possível falar com o servidor do Space IPTV. Verifique sua internet.');
      });
  }

  function start() {
    setVersion();
    probeApi();
    g.addEventListener('online', function () {
      hideWarning();
      probeApi();
    });
    g.addEventListener('offline', function () {
      showWarning('Você está sem conexão com a internet. Verifique a rede e tente de novo.');
    });
    /* Se a sessão já existir, web/js/login.js redireciona; nada a fazer aqui. */
    if (!probed) { /* probeApi já foi chamado */ }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
