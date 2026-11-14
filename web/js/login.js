/* Tela de login: chama /api/auth/* e redireciona para o app.
   ES5, sem dependencias e sem guardar nada no navegador (nem e-mail, nem senha).
   O token de sessao vive em cookies HttpOnly: este arquivo nunca o ve. */
(function (g) {
  'use strict';

  var doc = g.document;
  var next = '/';
  var busy = false;

  function $(id) { return doc.getElementById(id); }

  function api(path, opts) {
    var o = opts || {};
    var init = {
      method: o.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {}
    };
    if (o.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(o.body);
    }
    return fetch(path, init).then(function (res) {
      return res.text().then(function (raw) {
        var data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
        return {
          ok: res.ok,
          status: res.status,
          data: data,
          retryAfter: Number(res.headers.get('Retry-After')) || 0
        };
      });
    });
  }

  /* `next` validado tambem no cliente: nada de redirecionar para outro site. */
  function readNext() {
    var search = String(g.location.search || '');
    var m = /(?:^|[?&])next=([^&]*)/.exec(search);
    if (!m) return '/';
    var raw;
    try { raw = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return '/'; }
    if (!raw || raw.length > 300) return '/';
    if (raw.charAt(0) !== '/' || raw.indexOf('//') === 0) return '/';
    if (raw.indexOf('\\') >= 0) return '/';
    return raw;
  }

  function showError(message) {
    var el = $('login-error');
    el.textContent = message || '';
  }

  function setBusy(on) {
    busy = !!on;
    var btn = $('login-submit');
    btn.disabled = !!on;
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
    btn.textContent = on ? 'Entrando...' : 'Entrar';
    var email = $('email');
    var pass = $('password');
    email.readOnly = !!on;
    pass.readOnly = !!on;
  }

  function go() {
    g.location.replace(next);
  }

  /* ---------- mostrar/ocultar senha ---------- */
  function setupEye() {
    var btn = $('toggle-password');
    var input = $('password');
    btn.addEventListener('click', function () {
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.setAttribute('aria-pressed', showing ? 'false' : 'true');
      btn.setAttribute('aria-label', showing ? 'Mostrar senha' : 'Ocultar senha');
      btn.title = showing ? 'Mostrar senha' : 'Ocultar senha';
      input.focus();
    });
  }

  /* ---------- login ---------- */
  function setupLogin() {
    var form = $('login-form');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (busy) return;
      showError('');
      var email = $('email').value.replace(/^\s+|\s+$/g, '');
      var password = $('password').value;
      if (!email || !password) {
        showError('Informe e-mail e senha.');
        (!email ? $('email') : $('password')).focus();
        return;
      }
      setBusy(true);
      api('/api/auth/login', { method: 'POST', body: { email: email, password: password } })
        .then(function (r) {
          if (r.ok && r.data && r.data.user) { go(); return; }
          setBusy(false);
          if (r.status === 429) {
            showError('Muitas tentativas. Aguarde alguns minutos e tente de novo.');
          } else if (r.status === 503) {
            showError((r.data && r.data.message) || 'Login indisponível neste servidor.');
          } else {
            showError((r.data && r.data.message) || 'E-mail ou senha inválidos.');
          }
          $('password').value = '';
          $('password').focus();
        }, function () {
          setBusy(false);
          showError('Não foi possível falar com o servidor. Verifique sua conexão.');
        });
    });
  }

  /* ---------- esqueci minha senha ---------- */
  function setupForgot() {
    var toggle = $('forgot-toggle');
    var form = $('forgot-form');
    var loginForm = $('login-form');
    var status = $('forgot-status');

    toggle.addEventListener('click', function () {
      showError('');
      loginForm.hidden = true;
      form.hidden = false;
      status.textContent = '';
      $('forgot-email').value = $('email').value;
      $('forgot-email').focus();
    });

    $('forgot-cancel').addEventListener('click', function () {
      form.hidden = true;
      loginForm.hidden = false;
      $('email').focus();
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = $('forgot-email').value.replace(/^\s+|\s+$/g, '');
      var btn = $('forgot-submit');
      if (!email) { status.textContent = 'Informe o e-mail da sua conta.'; return; }
      btn.disabled = true;
      btn.textContent = 'Enviando...';
      status.textContent = '';
      api('/api/auth/forgot', { method: 'POST', body: { email: email } }).then(function (r) {
        btn.disabled = false;
        btn.textContent = 'Enviar instruções';
        if (r.status === 503) {
          status.textContent = (r.data && r.data.message) || 'Recuperação por e-mail indisponível. Peça ao administrador.';
          return;
        }
        if (r.status === 429) {
          status.textContent = 'Muitas tentativas. Aguarde alguns minutos.';
          return;
        }
        /* Sempre a mesma frase: nao revela se o e-mail existe. */
        status.textContent = 'Se este e-mail existir, enviamos as instruções.';
      }, function () {
        btn.disabled = false;
        btn.textContent = 'Enviar instruções';
        status.textContent = 'Não foi possível falar com o servidor. Tente de novo.';
      });
    });
  }

  function start() {
    next = readNext();
    setupEye();
    setupLogin();
    setupForgot();

    /* Se ja existe sessao, entra direto (o middleware tambem redireciona). */
    api('/api/auth/session').then(function (r) {
      if (r.ok && r.data && r.data.user) { go(); return; }
      var email = $('email');
      if (email && !email.value) email.focus();
    }, function () {
      var email = $('email');
      if (email) email.focus();
    });

    /* "Esqueci minha senha" so aparece quando o servidor tem recuperacao. */
    api('/api/auth/capabilities').then(function (r) {
      if (r.ok && r.data && r.data.recovery === true) $('forgot-toggle').hidden = false;
    }, function () { /* sem capabilities: mantem escondido */ });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
