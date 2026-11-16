/* Ações próprias do desktop em Configurações (contrato §3.6).
 *
 * O `tv/js/screens/settings.js` já exibe `App.session.actions()`. Aqui anexamos:
 *   - pasta de downloads (mostrar/alterar; trocar NÃO apaga arquivos);
 *   - cache do guia (12/24/48 h), fonte pública de EPG padrão e "Atualizar guia agora";
 *   - iniciar com o Windows, iniciar minimizado na bandeja e fechar na bandeja;
 *   - Sobre (versão + aviso de build não assinado).
 * Também substituímos a ação de conta da web por uma que mostra papel "usuário"
 * (o desktop não tem administração).
 */
(function (g) {
  'use strict';
  var App = g.App;
  if (!App || !App.session) return;

  var space = typeof g.space !== 'undefined' ? g.space : null;

  var S = {
    cfg: null,
    autostart: null,
    stateLoaded: false
  };

  function toast(msg, ms) {
    try { App.toast(msg, ms); } catch (e) { /* ignore */ }
  }

  function spaceConfig() {
    return space && space.config ? space.config : null;
  }

  function spaceAutostart() {
    return space && space.autostart ? space.autostart : null;
  }

  function refreshState() {
    var cfg = spaceConfig();
    var auto = spaceAutostart();
    var ps = [];
    if (cfg && typeof cfg.get === 'function') {
      ps.push(Promise.resolve(cfg.get()).then(function (c) { S.cfg = c || null; }, function () { /* ignore */ }));
    }
    if (auto && typeof auto.get === 'function') {
      ps.push(Promise.resolve(auto.get()).then(function (a) { S.autostart = a || null; }, function () { /* ignore */ }));
    }
    return Promise.all(ps).then(function () { S.stateLoaded = true; });
  }

  function currentDownloadsDir() {
    if (S.cfg && S.cfg.downloadsDir) return S.cfg.downloadsDir;
    return '';
  }

  function fmtHours(ttl) {
    var n = Number(ttl) || 24;
    return n + ' h';
  }

  function onOff(value) {
    return value === true ? 'ligado' : 'desligado';
  }

  /* ===================== pasta de downloads ===================== */

  /* Modal com o campo da pasta; erro aparece JUNTO do campo (err-line do próprio modal). */
  function downloadsFolderDialog() {
    var current = currentDownloadsDir();
    var chosen = current;
    var busy = false;
    var closed = false;

    var ov = App.el('div', 'overlay');
    var m = App.el('div', 'modal glass-panel folder-modal');
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-label', 'Pasta de downloads');
    m.appendChild(App.el('h2', 'h2', 'Pasta de downloads'));
    m.appendChild(App.el('div', 'body-sm',
      'Os arquivos baixados ficam nesta pasta. Trocar a pasta não apaga nem move os arquivos antigos.'));

    var field = App.el('div', 'field');
    var fieldId = 'dl-dir-' + App.uid();
    var label = App.el('label', null, 'Pasta atual');
    label.htmlFor = fieldId;
    var input = document.createElement('input');
    input.type = 'text';
    input.id = fieldId;
    input.value = current;
    input.placeholder = 'C:\\Users\\você\\Videos\\Space IPTV';
    input.autocomplete = 'off';
    input.spellcheck = false;
    field.appendChild(label);
    field.appendChild(input);
    m.appendChild(field);

    var err = App.el('div', 'err-line');
    err.setAttribute('aria-live', 'polite');
    err.textContent = '';
    m.appendChild(err);

    var btns = App.el('div', 'btns');
    var cancel = App.ui.btn('Cancelar');
    var pick = App.ui.btn('Escolher pasta…');
    var save = App.ui.btn('Usar esta pasta', 'primary');
    btns.appendChild(cancel);
    btns.appendChild(pick);
    btns.appendChild(save);
    m.appendChild(btns);
    ov.appendChild(m);

    var grp = App.ui.group([cancel, pick, save], true);

    function setErr(msg) {
      err.textContent = msg || '';
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }

    function close(rec) {
      if (closed) return;
      closed = true;
      closeFn();
      if (rec) toast(rec, 5000);
    }

    function choose() {
      if (busy) return;
      setErr('');
      var cfg = spaceConfig();
      if (!cfg || typeof cfg.pickFolder !== 'function') { setErr('Não foi possível abrir o seletor de pastas.'); return; }
      Promise.resolve(cfg.pickFolder({ title: 'Escolher pasta de downloads', defaultPath: input.value || undefined })).then(function (dir) {
        if (!dir) return;
        input.value = dir;
        setErr('');
        validateCurrent().then(function (ok) { if (ok) save.focus ? save.focus() : null; });
      }, function () { setErr('Não foi possível abrir o seletor de pastas.'); });
    }

    function validateCurrent() {
      var dir = input.value.replace(/^\s+|\s+$/g, '');
      if (!dir) { setErr('Informe uma pasta para os downloads.'); return Promise.resolve(false); }
      var cfg = spaceConfig();
      if (!cfg || typeof cfg.validateDownloadsDir !== 'function') { setErr('Validação de pasta indisponível.'); return Promise.resolve(false); }
      return Promise.resolve(cfg.validateDownloadsDir(dir)).then(function (res) {
        if (!res || res.ok !== true) { setErr((res && res.error) || 'Pasta inválida. Escolha outra.'); return false; }
        setErr('');
        return true;
      }, function () { setErr('Não foi possível validar a pasta.'); return false; });
    }

    function doSave() {
      if (busy) return;
      var dir = input.value.replace(/^\s+|\s+$/g, '');
      busy = true;
      save.textContent = 'Verificando...';
      validateCurrent().then(function (ok) {
        if (!ok) { busy = false; save.textContent = 'Usar esta pasta'; return; }
        var cfg = spaceConfig();
        return Promise.resolve(cfg.set({ downloadsDir: dir })).then(function (res) {
          busy = false;
          save.textContent = 'Usar esta pasta';
          if (res && res.ok === false) { setErr(res.error || 'Não foi possível usar esta pasta.'); return; }
          S.cfg = res && res.downloadsDir ? res : S.cfg;
          close('Pasta de downloads alterada. Os arquivos baixados antes continuam na pasta antiga.');
        }, function () {
          busy = false;
          save.textContent = 'Usar esta pasta';
          setErr('Não foi possível salvar a pasta.');
        });
      });
    }

    save._act = doSave;
    pick._act = choose;
    cancel._act = function () { if (!busy) close(null); };

    var closeFn = App.ui.open(ov, {
      key: function (a) {
        if (busy) return true;
        if (a === 'back') { close(null); return true; }
        if (a === 'enter' || a === 'ok') { /* deixe o campo/grp tratar */ }
        if (!isTyping()) {
          if (a === 'up') { grp.focus(0); return true; }
          if (a === 'down') { grp.focus(1); return true; }
        }
        if (grp.key(a)) return true;
        return true;
      }
    });
    grp.blur();
    setTimeout(function () { try { input.focus(); input.select(); } catch (e) { /* ignore */ } }, 40);
  }

  function isTyping() {
    var a = g.document.activeElement;
    if (!a) return false;
    var t = a.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || a.isContentEditable === true;
  }

  /* ===================== EPG ===================== */

  /* Mesma URL padrão de `src/main/config.js` (DEFAULT_EPG_URL). O renderer não
     importa o main, então a constante é espelhada aqui — mudar nos dois lugares. */
  var DEFAULT_EPG_URL = 'https://epgshare01.online/epgshare01/epg_ripper_BR1.xml.gz';

  function epgSourceUrl() {
    return S.cfg && typeof S.cfg.epgUrl === 'string' ? S.cfg.epgUrl : '';
  }

  /* Rótulos de ação não quebram linha (`.btn` é nowrap): no menu mostramos só o
     host; a URL completa aparece no formulário. '' = desligada. */
  function epgSourceLabel() {
    var url = epgSourceUrl();
    if (!url) return 'desligada';
    try {
      var host = String(new g.URL(url).hostname || '');
      if (!host) return 'personalizada';
      return host + (url === DEFAULT_EPG_URL ? ' (padrão)' : '');
    } catch (e) {
      return 'personalizada';
    }
  }

  function validEpgUrl(raw) {
    if (!/^https?:\/\/[^\s]+$/i.test(raw)) return false;
    try {
      var u = new g.URL(raw);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
    } catch (e) {
      return false;
    }
  }

  /* Descarta o guia salvo da lista ativa (a fonte mudou): o próximo load baixa de novo. */
  function discardEpgCache() {
    var list = App.lists && typeof App.lists.active === 'function' ? App.lists.active() : null;
    if (!list || !list.id || !App.epg || typeof App.epg.dropCache !== 'function') return Promise.resolve();
    return Promise.resolve(App.epg.dropCache(list.id)).then(function () { }, function () { });
  }

  function epgSourceDialog() {
    var cfg = spaceConfig();
    if (!cfg || typeof cfg.set !== 'function') return toast('Não foi possível abrir as configurações.');
    var current = epgSourceUrl();
    App.ui.form({
      title: 'Fonte de EPG padrão',
      note: 'Usada quando a lista ativa não informa um guia (url-tvg) nem fornece xmltv.php (Xtream). ' +
        'Deixe em branco para desligar. Fonte pública padrão (EPGShare01, Brasil): ' + DEFAULT_EPG_URL,
      fields: [{
        id: 'epgUrl',
        label: 'URL do EPG (XMLTV .xml ou .xml.gz)',
        value: current,
        placeholder: DEFAULT_EPG_URL
      }],
      submit: 'Salvar fonte',
      onSubmit: function (v) {
        var url = String(v && v.epgUrl != null ? v.epgUrl : '').replace(/^\s+|\s+$/g, '');
        if (url && !validEpgUrl(url)) {
          return 'Informe uma URL http:// ou https:// válida (ex.: ' + DEFAULT_EPG_URL + ').';
        }
        return Promise.resolve(cfg.set({ epgUrl: url })).then(function (res) {
          if (res && res.ok === false) return res.error || 'Não foi possível salvar a fonte de EPG.';
          S.cfg = res && typeof res === 'object' ? res : S.cfg;
          return null;
        }, function () { return 'Não foi possível salvar a fonte de EPG.'; });
      }
    }).then(function (saved) {
      if (!saved) return;
      var url = epgSourceUrl();
      toast(url ? 'Fonte de EPG padrão salva.' : 'Fonte de EPG padrão desligada.', 5000);
      discardEpgCache().then(function () {
        return App.ui.confirm({
          title: 'Atualizar o guia agora?',
          msg: url
            ? 'O guia salvo foi descartado. Baixar de novo usando ' + url + '?'
            : 'O guia salvo foi descartado. Atualizar com o guia que a lista fornecer (se houver)?',
          yes: 'Atualizar agora',
          no: 'Depois'
        });
      }).then(function (yes) {
        if (!yes) { toast('O guia será atualizado na próxima vez que você abrir.'); return; }
        refreshEpgNow();
      });
    });
  }

  function epgTtlMenu() {
    var current = S.cfg && S.cfg.epgTtlHours ? Number(S.cfg.epgTtlHours) : 24;
    var options = [12, 24, 48];
    App.ui.menu({
      title: 'Cache do guia de programação',
      msg: 'Por quanto tempo guardar o guia baixado. Atual: ' + fmtHours(current) + '.',
      options: options.map(function (h) {
        return { label: fmtHours(h) + (h === current ? '  (atual)' : '') };
      })
    }).then(function (idx) {
      if (idx == null) return;
      var ttl = options[idx];
      var cfg = spaceConfig();
      if (!cfg) return;
      Promise.resolve(cfg.set({ epgTtlHours: ttl })).then(function (res) {
        if (res && res.ok === false) { toast(res.error || 'Não foi possível salvar.'); return; }
        S.cfg = res || S.cfg;
        toast('Cache do guia: ' + fmtHours(ttl));
      }, function () { toast('Não foi possível salvar o cache do guia.'); });
    });
  }

  function refreshEpgNow() {
    if (!App.epg || typeof App.epg.refresh !== 'function') {
      return toast('O guia de programação ainda não está disponível nesta versão.');
    }
    var list = App.lists && App.lists.active ? App.lists.active() : null;
    if (!list) return toast('Adicione uma lista antes de atualizar o guia.');
    if (App.desktop && App.desktop.offline) return toast('Sem conexão: não é possível atualizar o guia agora.');
    toast('Atualizando o guia...');
    try {
      Promise.resolve(App.epg.refresh(list)).then(function () {
        toast('Guia atualizado.');
      }, function () {
        toast('Não foi possível atualizar o guia agora.');
      });
    } catch (e) {
      toast('Não foi possível atualizar o guia agora.');
    }
  }

  /* ===================== autostart / bandeja ===================== */

  function autostartMenu(which) {
    var auto = spaceAutostart();
    if (!auto) return toast('Recurso indisponível neste ambiente.');
    Promise.resolve(auto.get()).then(function (state) {
      state = state || {};
      S.autostart = state;
      if (state.disabled) {
        return App.ui.alert('Inicialização automática indisponível',
          'Este ambiente está com a inicialização automática desabilitada (modo de teste).');
      }
      if (which === 'window') {
        var open = state.openAtLogin === true;
        return App.ui.menu({
          title: 'Iniciar com o Windows',
          msg: open ? 'Ligado: o Space IPTV abre junto com o Windows.' : 'Desligado (padrão).',
          options: [{ label: open ? 'Desligar' : 'Ligar' }]
        }).then(function (idx) {
          if (idx == null) return;
          return Promise.resolve(auto.set({ openAtLogin: !open })).then(function (res) {
            S.autostart = res && typeof res.openAtLogin === 'boolean' ? res : state;
            toast(!open ? 'O Space IPTV vai iniciar com o Windows.' : 'O Space IPTV não inicia mais com o Windows.');
          }, function () { toast('Não foi possível alterar a inicialização automática.'); });
        });
      }
      var min = state.minimized === true;
      return App.ui.menu({
        title: 'Iniciar minimizado na bandeja',
        msg: min ? 'Ligado: ao iniciar com o Windows, fica na bandeja.' : 'Desligado (padrão): abre a janela normal.',
        options: [{ label: min ? 'Desligar' : 'Ligar' }]
      }).then(function (idx) {
        if (idx == null) return;
        return Promise.resolve(auto.set({ minimized: !min })).then(function (res) {
          S.autostart = res && typeof res.minimized === 'boolean' ? res : state;
          toast(!min ? 'Vai iniciar minimizado na bandeja.' : 'Vai abrir a janela normal ao iniciar.');
        }, function () { toast('Não foi possível salvar essa preferência.'); });
      });
    }, function () { toast('Não foi possível ler a inicialização automática.'); });
  }

  function trayCloseMenu() {
    var cfg = spaceConfig();
    if (!cfg) return toast('Preferência indisponível neste ambiente.');
    var current = S.cfg && S.cfg.minimizeToTrayOnClose === true;
    App.ui.menu({
      title: 'Fechar minimizando para a bandeja',
      msg: current
        ? 'Ligado: fechar a janela mantém o app na bandeja.'
        : 'Desligado (padrão): fechar a janela encerra o aplicativo.',
      options: [{ label: current ? 'Desligar' : 'Ligar' }]
    }).then(function (idx) {
      if (idx == null) return;
      Promise.resolve(cfg.set({ minimizeToTrayOnClose: !current })).then(function (res) {
        if (res && res.ok === false) { toast(res.error || 'Não foi possível salvar.'); return; }
        S.cfg = res || S.cfg;
        toast(!current ? 'Fechar agora minimiza para a bandeja.' : 'Fechar agora encerra o aplicativo.');
      }, function () { toast('Não foi possível salvar essa preferência.'); });
    });
  }

  /* ===================== Sobre ===================== */

  function about() {
    var info = space && space.app && typeof space.app.info === 'function'
      ? Promise.resolve(space.app.info()).catch(function () { return null; })
      : Promise.resolve(null);
    info.then(function (data) {
      data = data || {};
      var version = data.version || App.desktop && App.desktop.version || '';
      var lines = [];
      lines.push('Space IPTV' + (version ? ' ' + version : ''));
      lines.push('Plataforma: Windows (aplicativo desktop)');
      lines.push('');
      lines.push('Reprodutor de listas fornecidas por você. O aplicativo não inclui canais nem conteúdo.');
      lines.push('');
      lines.push('Build não assinado: o Windows pode exibir um aviso do SmartScreen na primeira execução. ' +
        'Isso é esperado; não é possível "desativar" esse aviso sem um certificado de assinatura de código.');
      return App.ui.alert('Sobre o Space IPTV', lines.join('\n'));
    });
  }

  /* ===================== lista de ações ===================== */

  function accountAction() {
    var user = App.session.user ? App.session.user() : null;
    if (!user) return null;
    var email = user.email || '';
    return {
      label: 'Conta: ' + email + ' (usuário)',
      run: function () {
        App.ui.menu({
          title: 'Sua conta',
          msg: email + ' • usuário',
          options: [
            { label: 'Alterar minha senha' },
            { label: 'Sair da conta', danger: true }
          ]
        }).then(function (idx) {
          if (idx === 0) {
            if (typeof App.session.changePassword === 'function') App.session.changePassword();
          } else if (idx === 1) {
            App.ui.confirm({
              title: 'Sair da conta',
              msg: 'Você vai precisar entrar de novo para usar o app. Suas listas e favoritos ficam salvos na sua conta.',
              yes: 'Sair',
              danger: true
            }).then(function (ok) { if (ok) App.session.logout(); });
          }
        });
      }
    };
  }

  function desktopActions() {
    var actions = [];
    actions.push({
      label: 'Pasta de downloads…',
      run: downloadsFolderDialog
    });
    actions.push({
      label: 'Cache do guia: ' + fmtHours(S.cfg && S.cfg.epgTtlHours ? S.cfg.epgTtlHours : 24),
      run: epgTtlMenu
    });
    actions.push({
      label: 'Fonte de EPG padrão: ' + epgSourceLabel(),
      run: epgSourceDialog
    });
    actions.push({
      label: 'Atualizar guia agora',
      run: refreshEpgNow
    });
    actions.push({
      label: 'Iniciar com o Windows: ' + onOff(S.autostart && S.autostart.openAtLogin),
      run: function () { autostartMenu('window'); }
    });
    actions.push({
      label: 'Iniciar minimizado na bandeja: ' + onOff(S.autostart && S.autostart.minimized),
      run: function () { autostartMenu('minimized'); }
    });
    actions.push({
      label: 'Fechar na bandeja: ' + onOff(S.cfg && S.cfg.minimizeToTrayOnClose),
      run: trayCloseMenu
    });
    actions.push({
      label: 'Sobre o Space IPTV',
      run: about
    });
    return actions;
  }

  /* Embrulha a lista da web: tira a ação de conta com papel administrativo e
     acrescenta as ações desktop. Funciona mesmo se App.session.actions mudar. */
  var baseActions = App.session.actions;
  App.session.actions = function () {
    var list = [];
    try {
      list = typeof baseActions === 'function' ? (baseActions() || []) : [];
    } catch (e) {
      list = [];
    }
    list = list.filter(function (a) {
      return !(a && typeof a.label === 'string' && a.label.indexOf('Conta:') === 0);
    });
    var account = accountAction();
    if (account) list.push(account);
    var desktop = desktopActions();
    for (var i = 0; i < desktop.length; i++) list.push(desktop[i]);
    /* Mantém o estado fresco para os rótulos da próxima montagem da tela. */
    refreshState();
    return list;
  };

  /* Estado inicial (rótulos corretos quando Configurações abrir pela primeira vez). */
  refreshState();

  /* Acessibilidade (pendência P1 do ui-ux): quando o foco muda, o item focado
     precisa continuar visível. Cobre teclado (classe `.focused` trocada pelas telas
     da TV) e também mudanças programáticas/ponteiro via MutationObserver.
     `block:'nearest'` evita rolar o palco inteiro e não anima (reduced-motion). */
  (function wireFocusScroll() {
    var doc = g.document;
    var scheduled = false;

    function scrollFocused() {
      var el = doc.querySelector('#screen .focused, #overlays .focused');
      if (!el || typeof el.scrollIntoView !== 'function') return;
      try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* navegador antigo */ }
    }

    function scheduleScroll() {
      if (scheduled) return;
      scheduled = true;
      setTimeout(function () { scheduled = false; scrollFocused(); }, 24);
    }

    var NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab', 'Enter'];
    doc.addEventListener('keydown', function (ev) {
      if (NAV_KEYS.indexOf(ev.key) < 0) return;
      setTimeout(scrollFocused, 0);
    }, true);

    if (typeof g.MutationObserver === 'function') {
      try {
        var obs = new g.MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            if (mutations[i].type === 'attributes' && mutations[i].attributeName === 'class') {
              scheduleScroll();
              return;
            }
          }
        });
        var screenEl = doc.getElementById('screen');
        var overlaysEl = doc.getElementById('overlays');
        if (screenEl) obs.observe(screenEl, { subtree: true, attributes: true, attributeFilter: ['class'] });
        if (overlaysEl) obs.observe(overlaysEl, { subtree: true, attributes: true, attributeFilter: ['class'] });
      } catch (e) { /* observador é melhoria, não requisito */ }
    }
  })();

  App.desktop.settings = {
    refreshState: refreshState,
    downloadsFolderDialog: downloadsFolderDialog,
    epgSourceDialog: epgSourceDialog,
    about: about
  };
})(window);
