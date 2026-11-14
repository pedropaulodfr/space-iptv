/* Sessao no cliente: quem esta logado, se e admin e como sair.
 *
 * O token vive em cookie HttpOnly: nada aqui le ou guarda token. Este modulo so
 * conversa com /api/auth/* no mesmo dominio e publica App.session para o resto
 * do app. Carregar depois de web/js/net.js e antes de web/js/shell.js. */
(function (g) {
  'use strict';
  var App = g.App;
  var state = { ready: false, user: null, failed: false };
  var initP = null;

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
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function goLogin() {
    var here = String(g.location.pathname || '/') + String(g.location.search || '');
    if (here === '/' || here === '/index.html') here = '/';
    g.location.replace('/login.html?next=' + encodeURIComponent(here));
  }

  function roleLabel() {
    return state.user && state.user.role === 'admin' ? 'administrador' : 'usuário';
  }

  /* Formulario de troca de senha (usado em Configuracoes). */
  function changePassword() {
    return App.ui.form({
      title: 'Alterar minha senha',
      note: 'Confirme a senha atual e escolha uma nova com pelo menos 10 caracteres.',
      fields: [
        { id: 'current', label: 'Senha atual', type: 'password' },
        { id: 'next', label: 'Nova senha', type: 'password' },
        { id: 'confirm', label: 'Confirmar nova senha', type: 'password' }
      ],
      submit: 'Alterar',
      onSubmit: function (v) {
        if (!v.current) return 'Informe a senha atual.';
        if (v.next.length < 10) return 'A nova senha precisa ter pelo menos 10 caracteres.';
        if (v.next !== v.confirm) return 'A confirmação não confere com a nova senha.';
        if (v.next === v.current) return 'A nova senha precisa ser diferente da atual.';
        return api('/api/auth/password', {
          method: 'POST',
          body: { current: v.current, next: v.next }
        }).then(function (r) {
          if (r.ok) { App.toast('Senha alterada'); return null; }
          if (r.status === 429) return 'Muitas tentativas. Aguarde alguns minutos.';
          return (r.data && r.data.message) || 'Não foi possível alterar a senha.';
        }, function () {
          return 'Não foi possível falar com o servidor. Tente de novo.';
        });
      }
    });
  }

  function confirmLogout() {
    return App.ui.confirm({
      title: 'Sair da conta',
      msg: 'Você vai precisar entrar de novo para usar o app. Suas listas e favoritos ficam salvos na sua conta.',
      yes: 'Sair',
      danger: true
    }).then(function (ok) {
      if (!ok) return false;
      App.session.logout();
      return true;
    });
  }

  function accountInfo() {
    if (!state.user) return App.ui.alert('Sua conta', 'Sessão não disponível.');
    return App.ui.alert('Sua conta',
      'E-mail: ' + state.user.email + '\n' +
      'Papel: ' + roleLabel() + '\n\n' +
      'Para trocar a senha, use "Alterar minha senha".');
  }

  /* Uma única entrada no menu de Configurações: cabe na tela sem empurrar as
     outras ações e ainda dá acesso a trocar senha e sair. */
  function accountMenu() {
    if (!state.user) return accountInfo();
    App.ui.menu({
      title: 'Sua conta',
      msg: state.user.email + ' • ' + roleLabel(),
      options: [
        { label: 'Alterar minha senha' },
        { label: 'Sair da conta', danger: true }
      ]
    }).then(function (i) {
      if (i === 0) changePassword();
      else if (i === 1) confirmLogout();
    });
  }

  App.session = {
    /* Busca a sessao no edge. Devolve Promise<bool>; nunca rejeita. */
    init: function () {
      if (initP) return initP;
      initP = api('/api/auth/session').then(function (r) {
        if (r.ok && r.data && r.data.user) {
          state.user = r.data.user;
          state.ready = true;
          App.bus.emit('session', state.user);
          return true;
        }
        state.failed = true;
        if (r.status === 401) goLogin();
        return false;
      }, function () {
        state.failed = true;
        return false;
      });
      return initP;
    },
    user: function () { return state.user; },
    ready: function () { return state.ready; },
    isAdmin: function () { return !!(state.user && state.user.role === 'admin'); },
    email: function () { return state.user ? state.user.email : ''; },
    roleLabel: roleLabel,

    logout: function () {
      return api('/api/auth/logout', { method: 'POST' }).then(function () {
        state.user = null;
        g.location.replace('/login.html');
      }, function () {
        g.location.replace('/login.html');
      });
    },

    changePassword: changePassword,

    /* Ações extras da tela de Configurações (so existem na web). O arquivo
       tv/js/screens/settings.js inclui esta lista quando App.session existe;
       no app da TV ele nao existe e nada muda. */
    actions: function () {
      if (!state.user) return [];
      return [
        {
          label: 'Conta: ' + state.user.email + ' (' + roleLabel() + ')',
          run: function () { accountMenu(); }
        }
      ];
    }
  };
})(window);
