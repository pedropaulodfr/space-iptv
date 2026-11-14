/* Tela de Administração (só para app_metadata.role = "admin").
 *
 * Segue o contrato de tela do app: { hints, mount, unmount, enter, key }.
 * Duas colunas como Configurações: usuários à esquerda, ações à direita.
 * A API é a fonte da verdade dos guardrails (não desativar a si mesmo, sempre
 * sobrar um admin ativo); aqui só mostramos o motivo em pt-BR. */
(function (g) {
  'use strict';
  var App = g.App;

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

  function messageOf(r, fallback) {
    return (r && r.data && r.data.message) || fallback;
  }

  /* ---------- modais próprios (sem estilo inline: CSP style-src 'self') ---------- */

  function tempPasswordSheet(password) {
    return new Promise(function (resolve) {
      var ov = App.el('div', 'overlay');
      var m = App.el('div', 'modal glass-panel');
      m.appendChild(App.el('h2', 'h2', 'Senha temporária'));
      m.appendChild(App.el('div', 'msg', 'Anote agora. Esta senha não será exibida de novo.'));
      var box = App.el('div', 'temp-pass', password);
      m.appendChild(box);
      var bs = App.el('div', 'btns');
      var copy = App.ui.btn('Copiar', 'primary');
      var closeBtn = App.ui.btn('Fechar');
      bs.appendChild(closeBtn); bs.appendChild(copy);
      m.appendChild(bs); ov.appendChild(m);

      function done() { close(); resolve(); }
      function copyNow() {
        var p = g.navigator && g.navigator.clipboard && g.navigator.clipboard.writeText
          ? g.navigator.clipboard.writeText(password) : Promise.reject(new Error('sem clipboard'));
        p.then(function () { copy.textContent = 'Copiado'; App.toast('Senha copiada'); }, function () {
          App.toast('Não foi possível copiar. Anote a senha da tela.');
        });
      }
      copy._act = copyNow;
      closeBtn._act = done;
      var grp = App.ui.group([closeBtn, copy], true);
      var close = App.ui.open(ov, {
        key: function (a) {
          if (a === 'back') { done(); return true; }
          if (grp.key(a)) return true;
          return true;
        }
      });
      grp.focus(1);
    });
  }

  function auditSheet(events) {
    return new Promise(function (resolve) {
      var ov = App.el('div', 'overlay');
      var m = App.el('div', 'modal glass-panel wide');
      m.appendChild(App.el('h2', 'h2', 'Auditoria'));
      m.appendChild(App.el('div', 'msg', 'Últimos ' + events.length + ' eventos administrativos.'));
      var list = App.el('div', 'audit-list glass-panel');
      if (!events.length) list.appendChild(App.el('div', 'audit-empty', 'Nenhum evento registrado.'));
      events.forEach(function (e) {
        var item = App.el('div', 'audit-item');
        item.appendChild(App.el('div', 't', actionLabel(e.action) + ' • ' + (e.target_email || '—')));
        item.appendChild(App.el('div', 's',
          'por ' + (e.actor_email || '—') + ' • ' + App.fmtDate(Date.parse(e.at)) +
          (e.detail && e.detail.error ? ' • falhou (' + e.detail.error + ')' : '')));
        list.appendChild(item);
      });
      m.appendChild(list);
      var bs = App.el('div', 'btns');
      var ok = App.ui.btn('Fechar', 'primary');
      bs.appendChild(ok); m.appendChild(bs); ov.appendChild(m);
      var close = App.ui.open(ov, {
        key: function (a) {
          if (a === 'back' || a === 'ok') { close(); resolve(); return true; }
          if (a === 'down') { list.scrollTop += 80; return true; }
          if (a === 'up') { list.scrollTop -= 80; return true; }
          return true;
        }
      });
      ok.classList.add('focused');
    });
  }

  function actionLabel(action) {
    var map = {
      'user.create': 'Conta criada',
      'user.role': 'Papel alterado',
      'user.disable': 'Acesso alterado',
      'user.password': 'Senha redefinida',
      'user.delete': 'Conta excluída',
      'user.name': 'Nome alterado'
    };
    return map[action] || action;
  }

  /* ---------- tela ---------- */
  App.screens.admin = function () {
    var el = null, listV = null, acts = null, actNodes = [], ap = null, statusEl = null, footEl = null;
    var zone = 'users';
    var state = { users: [], total: 0, page: 1, per: 25, q: '', loading: false };

    function me() { return (App.session && App.session.user()) || { id: '', email: '', role: 'user' }; }
    function current() { return listV ? listV.current() : null; }

    function setStatus(text, bad) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.className = 'err-line' + (bad ? '' : ' muted-line');
    }

    function fmtAccess(u) {
      var iso = u.lastSeenAt || u.lastSignInAt;
      if (!iso) return 'nunca';
      var ts = Date.parse(iso);
      return Number.isFinite(ts) ? App.fmtDate(ts) : 'nunca';
    }

    function load() {
      if (state.loading) return Promise.resolve();
      state.loading = true;
      setStatus('Carregando usuários...');
      var q = state.q ? '&q=' + encodeURIComponent(state.q) : '';
      return api('/api/admin/users?page=' + state.page + '&perPage=' + state.per + q).then(function (r) {
        state.loading = false;
        if (!r.ok) {
          setStatus(messageOf(r, 'Não foi possível carregar os usuários.'), true);
          return;
        }
        state.users = (r.data && r.data.users) || [];
        state.total = (r.data && r.data.total) || 0;
        setStatus('');
        renderList();
        renderActions();
      }, function () {
        state.loading = false;
        setStatus('Falha de rede ao carregar os usuários.', true);
      });
    }

    function reload() {
      state.page = 1;
      return load();
    }

    function renderList() {
      if (!listV) return;
      listV.setItems(state.users, true);
      if (footEl) {
        var from = state.total ? (state.page - 1) * state.per + 1 : 0;
        var to = Math.min(state.total, state.page * state.per);
        var label = state.total + (state.total === 1 ? ' usuário' : ' usuários');
        if (state.q) label += ' • busca: "' + state.q + '"';
        if (state.total > state.per) label += ' • ' + from + '–' + to;
        footEl.textContent = label;
      }
    }

    /* ---------- ações ---------- */
    function currentActions() {
      var u = current();
      var self = me();
      var actions = [
        { label: '+  Novo usuário', run: function () { newUser(); } },
        { label: 'Editar', need: true, run: function (t) { editUser(t); } },
        { label: 'Redefinir senha', need: true, run: function (t) { resetPassword(t); } },
        {
          label: u && u.disabled ? 'Ativar' : 'Desativar',
          dynamic: 'toggle',
          need: true,
          danger: !(u && u.disabled),
          run: function (t) { toggleDisabled(t); }
        },
        { label: 'Excluir', need: true, danger: true, run: function (t) { removeUser(t); } },
        { label: 'Buscar', run: function () { search(); } }
      ];
      if (state.total > state.per) {
        actions.push({
          label: 'Próxima página',
          run: function () {
            if (state.page * state.per >= state.total) { App.toast('Não há mais páginas.'); return; }
            state.page++;
            load();
          }
        });
      }
      actions.push({ label: 'Auditoria', run: function () { showAudit(); } });
      return actions;
    }

    function renderActions() {
      if (!ap) return;
      App.clear(ap);
      actNodes = [];
      var actions = currentActions();
      actions.forEach(function (a) {
        var b = App.ui.btn(a.label, a.danger ? 'danger' : '');
        b._adminAction = a;
        b._act = function () {
          var target = current();
          if (a.need && !target) { App.toast('Selecione um usuário primeiro.'); return; }
          a.run(target);
        };
        ap.appendChild(b);
        actNodes.push(b);
      });
      var about = App.el('div', 'about');
      about.textContent = 'Space IPTV 1.0 • O administrador não vê listas, favoritos nem histórico de ninguém. ' +
        'Desativar apenas corta o acesso; excluir apaga os dados da conta.';
      ap.appendChild(about);
      statusEl = App.el('div', 'err-line');
      if (statusEl) ap.appendChild(statusEl);
      acts = App.ui.group(actNodes, false);
      if (zone === 'acts') acts.focus(0);
      setStatus('');
      renderList();
    }

    function paint() {
      if (zone === 'users') { if (acts) acts.blur(); if (listV) listV.focus(); }
      else { if (listV) listV.blur(); if (acts) acts.focus(); }
    }

    function refreshSelection() {
      /* o rótulo Desativar/Ativar depende do usuário selecionado */
      if (!actNodes.length) return;
      var u = current();
      var toggle = null;
      for (var i = 0; i < actNodes.length; i++) {
        if (actNodes[i]._adminAction && actNodes[i]._adminAction.dynamic === 'toggle') toggle = actNodes[i];
      }
      if (toggle) {
        toggle.textContent = u && u.disabled ? 'Ativar' : 'Desativar';
        toggle.className = 'btn focusable ' + (u && u.disabled ? '' : 'danger');
      }
    }

    /* ---------- fluxos ---------- */
    function newUser() {
      App.ui.menu({
        title: 'Novo usuário',
        msg: 'Escolha o papel da conta que será criada.',
        options: [
          { label: 'Usuário comum' },
          { label: 'Administrador' }
        ]
      }).then(function (i) {
        if (i == null) return;
        var role = i === 1 ? 'admin' : 'user';
        App.ui.form({
          title: 'Novo usuário',
          note: 'A senha é opcional: se ficar vazia, o sistema gera uma senha temporária de 16 caracteres.',
          fields: [
            { id: 'name', label: 'Nome' },
            { id: 'email', label: 'E-mail', type: 'email' },
            { id: 'password', label: 'Senha (opcional)', type: 'password' }
          ],
          submit: 'Criar conta',
          onSubmit: function (v) {
            if (!v.name) return 'Informe o nome.';
            if (!v.email) return 'Informe o e-mail.';
            if (v.password && v.password.length < 10) return 'A senha precisa ter pelo menos 10 caracteres.';
            return api('/api/admin/users', {
              method: 'POST',
              body: { name: v.name, email: v.email, role: role, password: v.password || '' }
            }).then(function (r) {
              if (!r.ok) return messageOf(r, 'Não foi possível criar a conta.');
              var temp = r.data && r.data.tempPassword;
              App.toast('Conta criada');
              reload();
              if (temp) return tempPasswordSheet(temp).then(function () { return null; });
              return null;
            }, function () { return 'Falha de rede. Tente de novo.'; });
          }
        });
      });
    }

    function editUser(target) {
      if (!target) return;
      var isAdmin = target.role === 'admin';
      App.ui.menu({
        title: 'Editar ' + (target.name || target.email),
        msg: 'E-mail não é editável: ele é o login da conta.',
        options: [
          { label: 'Alterar nome' },
          { label: isAdmin ? 'Rebaixar para usuário' : 'Promover a administrador' }
        ]
      }).then(function (i) {
        if (i == null) return;
        if (i === 0) return renameUser(target);
        return changeRole(target, isAdmin ? 'user' : 'admin');
      });
    }

    function renameUser(target) {
      App.ui.form({
        title: 'Alterar nome',
        fields: [{ id: 'name', label: 'Nome', value: target.name || '' }],
        onSubmit: function (v) {
          if (!v.name) return 'Informe o nome.';
          return api('/api/admin/users/' + encodeURIComponent(target.id), {
            method: 'PATCH',
            body: { name: v.name }
          }).then(function (r) {
            if (!r.ok) return messageOf(r, 'Não foi possível salvar.');
            App.toast('Nome atualizado');
            load();
            return null;
          }, function () { return 'Falha de rede. Tente de novo.'; });
        }
      });
    }

    function changeRole(target, role) {
      var label = role === 'admin' ? 'Promover a administrador' : 'Rebaixar para usuário';
      App.ui.confirm({
        title: label,
        msg: 'Conta: ' + (target.email || '') + '\n\n' +
          (role === 'admin'
            ? 'Esta pessoa passa a poder criar, editar e excluir contas.'
            : 'Esta pessoa deixa de acessar a Administração.'),
        yes: role === 'admin' ? 'Promover' : 'Rebaixar',
        danger: role !== 'admin'
      }).then(function (ok) {
        if (!ok) return;
        api('/api/admin/users/' + encodeURIComponent(target.id), {
          method: 'PATCH',
          body: { role: role }
        }).then(function (r) {
          if (!r.ok) {
            App.ui.alert('Não foi possível alterar', messageOf(r, 'Tente de novo.'));
            return;
          }
          App.toast(role === 'admin' ? 'Agora é administrador' : 'Agora é usuário comum');
          load();
        }, function () { App.ui.alert('Falha de rede', 'Tente de novo.'); });
      });
    }

    function resetPassword(target) {
      if (!target) return;
      if (target.id === me().id) {
        App.ui.alert('Sua própria senha', 'Para trocar a sua senha, use Configurações → "Alterar minha senha" (pede a senha atual).');
        return;
      }
      App.ui.confirm({
        title: 'Redefinir senha',
        msg: 'Gerar uma nova senha temporária para ' + (target.email || '') + '?\n\nA senha atual deixa de funcionar imediatamente.',
        yes: 'Gerar senha'
      }).then(function (ok) {
        if (!ok) return;
        api('/api/admin/users/' + encodeURIComponent(target.id) + '/password', {
          method: 'POST',
          body: {}
        }).then(function (r) {
          if (!r.ok) { App.ui.alert('Não foi possível redefinir', messageOf(r, 'Tente de novo.')); return; }
          var temp = r.data && r.data.tempPassword;
          if (temp) tempPasswordSheet(temp);
          else App.toast('Senha redefinida');
        }, function () { App.ui.alert('Falha de rede', 'Tente de novo.'); });
      });
    }

    function toggleDisabled(target) {
      if (!target) return;
      var willDisable = !target.disabled;
      if (!willDisable) {
        App.ui.confirm({
          title: 'Ativar conta',
          msg: 'Devolver o acesso de ' + (target.email || '') + '?',
          yes: 'Ativar'
        }).then(function (ok) {
          if (!ok) return;
          patchDisabled(target, false);
        });
        return;
      }
      App.ui.confirm({
        title: 'Desativar conta',
        msg: 'Desativar ' + (target.email || '') + '?\n\n' +
          'O acesso é cortado em até 15 minutos e a sessão não pode ser renovada. ' +
          'As listas, favoritos e histórico continuam salvos.',
        yes: 'Desativar',
        danger: true
      }).then(function (ok) { if (ok) patchDisabled(target, true); });
    }

    function patchDisabled(target, disabled) {
      api('/api/admin/users/' + encodeURIComponent(target.id), {
        method: 'PATCH',
        body: { disabled: !!disabled }
      }).then(function (r) {
        if (!r.ok) { App.ui.alert('Não foi possível alterar', messageOf(r, 'Tente de novo.')); return; }
        App.toast(disabled ? 'Conta desativada' : 'Conta ativada');
        load();
      }, function () { App.ui.alert('Falha de rede', 'Tente de novo.'); });
    }

    function removeUser(target) {
      if (!target) return;
      App.ui.form({
        title: 'Excluir conta',
        note: 'As listas, favoritos e histórico dessa conta serão apagados. Esta ação não pode ser desfeita.\n' +
          'Para confirmar, digite o e-mail: ' + (target.email || ''),
        fields: [{ id: 'confirm', label: 'E-mail da conta', placeholder: target.email || '' }],
        submit: 'Excluir definitivamente',
        onSubmit: function (v) {
          if (String(v.confirm || '').toLowerCase() !== String(target.email || '').toLowerCase()) {
            return 'O e-mail não confere.';
          }
          return api('/api/admin/users/' + encodeURIComponent(target.id), { method: 'DELETE' }).then(function (r) {
            if (!r.ok) return messageOf(r, 'Não foi possível excluir a conta.');
            App.toast('Conta excluída');
            load();
            return null;
          }, function () { return 'Falha de rede. Tente de novo.'; });
        }
      });
    }

    function search() {
      App.ui.form({
        title: 'Buscar usuários',
        note: 'Busca por nome ou e-mail. Deixe vazio para ver todos.',
        fields: [{ id: 'q', label: 'Nome ou e-mail', value: state.q }],
        submit: 'Buscar',
        onSubmit: function (v) {
          state.q = String(v.q || '').replace(/^\s+|\s+$/g, '');
          reload();
          return null;
        }
      });
    }

    function showAudit() {
      setStatus('Carregando auditoria...');
      api('/api/admin/audit?limit=50').then(function (r) {
        setStatus('');
        if (!r.ok) { App.ui.alert('Auditoria', messageOf(r, 'Não foi possível carregar a auditoria.')); return; }
        auditSheet((r.data && r.data.events) || []);
      }, function () {
        setStatus('');
        App.ui.alert('Falha de rede', 'Tente de novo.');
      });
    }

    /* ---------- contrato de tela ---------- */
    return {
      hints: ['OK: selecionar', '▶: ações', '◀: voltar aos usuários'],
      mount: function (root) {
        el = root; zone = 'users'; App.clear(el);
        var wrap = App.el('div', 'settings admin');
        var lp = App.el('div', 'lists-pane glass-panel');
        var lroot = App.el('div', 'admin-list');
        lp.appendChild(lroot);
        ap = App.el('div', 'actions-pane');
        wrap.appendChild(lp); wrap.appendChild(ap); el.appendChild(wrap);

        listV = new App.VList({
          root: lroot,
          cols: 1,
          rowH: 104,
          empty: 'Nenhum usuário encontrado.',
          render: function (u, i, cell) {
            var self = me();
            var row = App.el('div', 'admin-row' + (u.id === self.id ? ' sel' : ''));
            var body = App.el('div', 'admin-body');
            body.appendChild(App.el('div', 't', u.name || '(sem nome)'));
            body.appendChild(App.el('div', 's', u.email));
            var meta = App.el('div', 's admin-meta');
            if (u.role === 'admin') meta.appendChild(App.el('span', 'badge admin', 'ADMIN'));
            if (u.disabled) meta.appendChild(App.el('span', 'badge off', 'DESATIVADO'));
            if (u.id === self.id) meta.appendChild(App.el('span', 'badge you', 'VOCÊ'));
            meta.appendChild(App.el('span', 'admin-when',
              (u.disabled ? 'inativo' : 'ativo') + ' • último acesso ' + fmtAccess(u)));
            body.appendChild(meta);
            row.appendChild(body);
            cell.appendChild(row);
          },
          onSelect: function () { zone = 'acts'; refreshSelection(); paint(); },
          onFocus: function () { refreshSelection(); }
        });

        footEl = App.el('div', 'admin-foot');
        lp.appendChild(footEl);

        renderActions();
        load();
      },
      unmount: function () {
        listV = acts = el = ap = statusEl = footEl = null;
        actNodes = [];
      },
      enter: function () {
        zone = state.users.length ? 'users' : 'acts';
        paint();
        return true;
      },
      key: function (a) {
        if (zone === 'users') {
          if (listV && listV.key(a)) { refreshSelection(); return true; }
          if (a === 'right') { zone = 'acts'; paint(); return true; }
          return false;
        }
        if (acts && acts.key(a)) return true;
        if (a === 'left' || a === 'back') {
          if (state.users.length) { zone = 'users'; paint(); return true; }
          return false;
        }
        return true;
      }
    };
  };
})(window);
