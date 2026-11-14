/* Configuracoes: gerenciar listas (adicionar M3U/Xtream, editar, excluir, ativar, atualizar) */
(function (g) {
  'use strict';
  var App = g.App;

  /* ---- formularios ---- */
  function validUrl(u) { return /^https?:\/\/[^\s\/]+\.?[^\s]*$/i.test(u); }

  function formM3U(existing) {
    return App.ui.form({
      title: existing ? 'Editar lista M3U' : 'Adicionar lista M3U',
      note: 'Informe o link (URL) da sua lista. Ex.: https://servidor.com/lista.m3u',
      fields: [
        { id: 'name', label: 'Nome da lista', value: existing ? existing.name : '', placeholder: 'Minha lista' },
        { id: 'url', label: 'URL M3U', value: '', placeholder: existing ? '(manter o link atual)' : 'https://servidor.com/lista.m3u' }
      ],
      onSubmit: function (v) {
        if (!v.name) return 'Informe um nome para a lista.';
        if (!existing && !v.url) return 'Informe a URL da lista.';
        if (v.url && !validUrl(v.url)) return 'A URL precisa começar com http:// ou https://';
        return App.lists.save({ name: v.name, type: 'm3u', url: v.url }, existing && existing.id).then(function (rec) { formM3U.saved = rec; return null; });
      }
    }).then(function (ok) { var r = formM3U.saved; formM3U.saved = null; return ok ? r : null; });
  }

  function formXtream(existing) {
    return App.ui.form({
      title: existing ? 'Editar Xtream Codes' : 'Adicionar Xtream Codes',
      note: 'Ex.: servidor http://servidor.com:8080 • usuário e senha fornecidos pelo seu provedor',
      fields: [
        { id: 'name', label: 'Nome da lista', value: existing ? existing.name : '', placeholder: 'Meu provedor' },
        { id: 'server', label: 'Servidor', value: existing ? existing.server : '', placeholder: 'http://servidor.com:8080' },
        { id: 'user', label: 'Usuário', value: existing ? existing.user : '' },
        { id: 'pass', label: 'Senha', type: 'password', value: '', placeholder: existing ? '(manter a atual)' : '' }
      ],
      onSubmit: function (v) {
        if (!v.name) return 'Informe um nome para a lista.';
        if (!v.server) return 'Informe o endereço do servidor.';
        if (!validUrl(/^https?:\/\//i.test(v.server) ? v.server : 'http://' + v.server)) return 'Endereço do servidor inválido.';
        if (!v.user) return 'Informe o usuário.';
        if (!existing && !v.pass) return 'Informe a senha.';
        var credsP = v.pass ? Promise.resolve({ server: v.server, user: v.user, pass: v.pass })
          : App.lists.creds(existing).then(function (c) { return { server: v.server, user: v.user, pass: c.pass }; });
        return credsP.then(function (c) { return App.xtream.auth(c); }).then(function () {
          return App.lists.save({ name: v.name, type: 'xtream', server: App.xtream.server(v.server), user: v.user, pass: v.pass }, existing && existing.id);
        }).then(function (rec) { formXtream.saved = rec; return null; }, function (e) { return App.friendly(e && e.code ? e : { code: 'network' }); });
      }
    }).then(function (ok) { var r = formXtream.saved; formXtream.saved = null; return ok ? r : null; });
  }

  /* ---- controle parental ---- */
  function parentalMenu() {
    var P = App.parental, opts = [];

    if (!P.hasPin()) {
      opts.push({
        label: 'Definir senha', acao: function () {
          return App.ui.pinNew({}).then(function (pin) {
            if (!pin) return;
            return P.setPin(pin).then(function () { App.toast('Senha definida. Conteúdo adulto bloqueado.'); });
          });
        }
      });
    } else {
      opts.push({
        label: 'Alterar senha', acao: function () {
          return App.ui.pinAsk({ title: 'Senha atual', msg: 'Digite a senha atual.' }).then(function (ok) {
            if (!ok) return;
            return App.ui.pinNew({ title: 'Nova senha', msg: 'Escolha a nova senha do controle parental.' }).then(function (pin) {
              if (!pin) return;
              return P.setPin(pin).then(function () { App.toast('Senha alterada.'); });
            });
          });
        }
      });
      opts.push({
        label: P.enabled() ? 'Desativar bloqueio' : 'Ativar bloqueio', acao: function () {
          if (!P.enabled()) { P.enable(true); App.toast('Controle parental ativado.'); return; }
          return App.ui.pinAsk({ title: 'Senha', msg: 'Digite a senha para desativar o controle parental.' }).then(function (ok) {
            if (!ok) return;
            P.enable(false); App.toast('Controle parental desativado.');
          });
        }
      });
    }

    if (P.enabled() && P.locked()) {
      opts.push({
        label: 'Liberar conteúdo adulto agora', acao: function () {
          return App.ui.pinAsk({ title: 'Senha', msg: 'Digite a senha para liberar o conteúdo adulto.' }).then(function (ok) {
            if (!ok) return;
            P.unlock(); App.toast('Conteúdo adulto liberado nesta sessão.');
          });
        }
      });
    }
    if (P.enabled() && !P.locked()) {
      opts.push({ label: 'Bloquear agora', acao: function () { P.lock(); App.toast('Conteúdo adulto bloqueado.'); } });
    }

    App.ui.menu({
      title: 'Controle parental',
      msg: P.enabled()
        ? 'Ativo: o conteúdo adulto fica oculto até alguém digitar a senha.'
        : 'Sem senha definida: todo o conteúdo aparece normalmente.',
      options: opts.map(function (o) { return { label: o.label, danger: /Desativar/.test(o.label) }; })
    }).then(function (i) { if (i != null && opts[i]) opts[i].acao(); });
  }

  App.screens.settings = function () {
    var el, listV, acts, actNodes = [], zone = 'lists', onCat, onLoad, statusEl;

    function sel() { return listV && listV.current(); }
    function activeId() { return (App.lists.active() || {}).id; }

    function rowText(l) {
      var kind = l.type === 'm3u'
        ? (l.source === 'file' ? 'M3U • arquivo: ' + (l.filename || 'local') : 'M3U')
        : 'Xtream • ' + App.lists.hostOf(l);
      return kind + '  •  Atualizada: ' + App.fmtDate(l.updated);
    }

    function load() { listV.setItems(App.lists.all(), true); }

    function activate(l, forceRefresh) {
      App.lists.setActive(l.id);
      return App.catalog.init(l).then(function (has) {
        if (forceRefresh || !has || App.catalog.needsRefresh()) return App.catalog.refresh(l);
      });
    }

    function afterSave(rec, isNew) {
      if (!rec) return;
      load();
      if (isNew || rec.id === activeId()) {
        App.toast('Lista salva. Carregando conteúdo...');
        activate(rec, true).then(function () { if (el) load(); });
      }
    }

    var actions = [
      { label: '+  Adicionar lista M3U (URL)', run: function () { formM3U().then(function (r) { afterSave(r, true); }); } },
      { label: '+  Adicionar Xtream Codes', run: function () { formXtream().then(function (r) { afterSave(r, true); }); } },
      { label: 'Usar esta lista', need: true, run: function (l) { activate(l, false).then(function () { if (el) load(); App.toast('Lista ativa: ' + l.name); }); } },
      { label: 'Atualizar agora', need: true, run: function (l) { App.toast('Atualizando...'); activate(l, true).then(function () { if (el) load(); }); } },
      {
        label: 'Editar', need: true, run: function (l) {
          if (l.source === 'file' && App.upload) return App.upload.open({ record: l, onSaved: function (r) { afterSave(r, false); } });
          (l.type === 'm3u' ? formM3U(l) : formXtream(l)).then(function (r) { afterSave(r, false); });
        }
      },
      {
        label: 'Excluir', need: true, danger: true, run: function (l) {
          App.ui.confirm({ title: 'Excluir lista', msg: 'Excluir "' + l.name + '"? Os favoritos e o histórico dela deixarão de aparecer.', yes: 'Excluir', danger: true }).then(function (ok) {
            if (!ok) return;
            var wasActive = l.id === activeId();
            App.lists.remove(l.id).then(function () {
              load();
              if (wasActive) { var n = App.lists.active(); App.catalog.init(n).then(function (has) { if (n && !has) App.catalog.refresh(n); }); }
              App.toast('Lista excluída');
            });
          });
        }
      },
      {
        label: 'Limpar histórico', run: function () {
          App.ui.confirm({ title: 'Limpar histórico', msg: 'Apagar todo o histórico de reprodução?', yes: 'Limpar' }).then(function (ok) { if (ok) { App.store.set('hist', []); App.toast('Histórico apagado'); } });
        }
      },
      { label: '🔒  Controle parental', run: function () { parentalMenu(); } }
    ];

    /* Upload de arquivo é uma extensão web (o módulo só existe em web/js/upload.js). */
    if (App.upload && typeof App.upload.open === 'function') {
      actions.splice(1, 0, {
        label: '+  Adicionar lista por arquivo (.m3u/.m3u8)',
        run: function () { App.upload.open({ onSaved: function (r) { afterSave(r, true); } }); }
      });
    }

    /* Bloco de conta da versao web. A lista vem de web/js/session.js; no app da
       TV App.session nao existe, entao o menu continua exatamente igual. */
    if (App.session && typeof App.session.actions === 'function') {
      App.session.actions().forEach(function (a) { actions.push(a); });
    }

    function updateStatus() {
      if (!statusEl) return;
      var l = sel(); statusEl.textContent = l && l.error ? 'Último erro: ' + l.error : '';
    }

    return {
      hints: ['OK: selecionar', '▶: ações da lista'],
      mount: function (root) {
        el = root; zone = 'lists'; App.clear(el);
        var wrap = App.el('div', 'settings'), lp = App.el('div', 'lists-pane glass-panel'), lroot = App.el('div'), ap = App.el('div', 'actions-pane');
        lroot.style.height = '100%'; lp.appendChild(lroot);
        listV = new App.VList({
          root: lroot, cols: 1, rowH: 108, empty: 'Nenhuma lista cadastrada.\nUse "Adicionar" ao lado para começar.',
          render: function (l, i, cell) {
            var r = App.el('div', 'list-row' + (l.id === activeId() ? ' sel' : '')), t = App.el('div');
            t.appendChild(App.el('div', 't', l.name));
            t.appendChild(App.el('div', 's', rowText(l)));
            if (l.error) { var e = App.el('div', 's', '⚠ ' + l.error); e.style.color = 'var(--danger)'; t.appendChild(e); }
            r.appendChild(t);
            if (l.id === activeId()) r.appendChild(App.el('span', 'badge ok', 'ATIVA'));
            cell.style.padding = '6px 0'; cell.appendChild(r);
          },
          onSelect: function () { zone = 'acts'; paint(); },
          onFocus: updateStatus
        });
        actNodes = actions.map(function (a) {
          var b = App.ui.btn(a.label, a.danger ? 'danger' : ''); b._act = function () { var l = sel(); if (a.need && !l) return App.toast('Selecione uma lista primeiro.'); a.run(l); }; ap.appendChild(b); return b;
        });

        /* Interruptores de preferencia (ficam antes da acao de "Controle parental"). */
        function toggleRow(titulo, descricao, estaLigado, alternar) {
          var btn = App.ui.btn('', 'toggle'), pintar;
          btn._act = function () { alternar(); pintar(); };
          pintar = function () {
            App.clear(btn);
            var txt = App.el('div', 'tg-text');
            txt.appendChild(App.el('div', 't', titulo));
            txt.appendChild(App.el('div', 's', descricao));
            var sw = App.el('span', 'switch' + (estaLigado() ? ' on' : ''));
            sw.appendChild(App.el('i'));
            btn.appendChild(txt); btn.appendChild(sw);
          };
          pintar();
          return btn;
        }

        var tResume = toggleRow('Iniciar no último canal assistido',
          'Ao abrir o aplicativo, inicia automaticamente o último canal que você assistiu.',
          function () { return App.resume.enabled(); },
          function () {
            var on = !App.resume.enabled();
            App.resume.setEnabled(on);
            App.toast(on ? 'Vai iniciar no último canal assistido' : 'Início normal do aplicativo');
          });

        var tHealth = toggleRow('Monitoramento da saúde dos canais',
          'Verifica automaticamente a disponibilidade e a estabilidade dos canais ao acessar uma categoria da TV ao Vivo.',
          function () { return App.health.enabled(); },
          function () {
            var on = !App.health.enabled();
            App.health.setEnabled(on);
            App.toast(on ? 'Monitoramento da saúde ligado' : 'Monitoramento da saúde desligado');
          });

        var ultimaAcao = actNodes[actNodes.length - 1];
        ap.insertBefore(tResume, ultimaAcao);
        ap.insertBefore(tHealth, ultimaAcao);
        actNodes.splice(actNodes.length - 1, 0, tResume, tHealth);

        acts = App.ui.group(actNodes, false);
        statusEl = App.el('div', 'err-line'); ap.appendChild(statusEl);
        var about = App.el('div', 'about');
        about.textContent = 'Space IPTV 1.0 • Reprodutor de listas fornecidas por você. O aplicativo não inclui canais nem conteúdo. Senhas ficam criptografadas neste aparelho.';
        ap.appendChild(about);
        wrap.appendChild(lp); wrap.appendChild(ap); el.appendChild(wrap);
        load();
        onCat = function () { if (el) { load(); } };
        App.bus.on('catalog', onCat); App.bus.on('catalog:done', onCat); App.bus.on('catalog:error', onCat);
      },
      unmount: function () { App.bus.off('catalog', onCat); App.bus.off('catalog:done', onCat); App.bus.off('catalog:error', onCat); listV = acts = el = null; },
      enter: function () { zone = listV.items.length ? 'lists' : 'acts'; paint(); return true; }
      , key: function (a) {
        if (zone === 'lists') {
          if (listV.key(a)) return true;
          if (a === 'right') { zone = 'acts'; paint(); return true; }
          return false;
        }
        if (acts.key(a)) return true;
        if (a === 'left' || a === 'back') { if (listV.items.length) { zone = 'lists'; paint(); return true; } return false; }
        return true;
      }
    };

    function paint() {
      if (zone === 'lists') { acts.blur(); listV.focus(); } else { listV.blur(); acts.focus(); }
    }
  };
})(window);
