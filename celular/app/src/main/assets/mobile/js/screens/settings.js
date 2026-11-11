/* Configurações: listas (M3U / Xtream), reprodução, controle parental e sobre. */
(function (g) {
  'use strict';
  var App = g.App;
  var U = App.m.ui;
  App.m.screens = App.m.screens || {};

  function actionRow(title, sub, onClick, danger) {
    var row = App.el('div', 'row');
    var tx = App.el('div', 'txt');
    tx.appendChild(App.el('div', 't', title));
    if (sub) tx.appendChild(App.el('div', 's', sub));
    row.appendChild(tx);
    var chev = App.el('span');
    chev.innerHTML = U.ico('chevron');
    chev.style.cssText = 'width:20px;height:20px;color:rgba(245,247,255,.35);flex:none';
    chev.querySelector('svg').style.width = '20px';
    chev.querySelector('svg').style.height = '20px';
    row.appendChild(chev);
    if (danger) {
      row.querySelector('.t').style.color = '#ff8fa0';
    }
    row.addEventListener('click', onClick);
    return row;
  }

  App.m.screens.settings = function () {
    var root = App.el('div');
    root.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var scroll = App.el('div', 'scroll narrow');
    root.appendChild(scroll);

    /* ------------------------------------------------------------- listas --- */

    function listCard(list) {
      var card = App.el('div', 'card');
      card.style.cssText = 'padding:12px;margin-bottom:8px;display:flex;align-items:center';

      var ic = App.el('div', 'thumb');
      ic.style.cssText = 'width:44px;height:44px;border-radius:12px;background:rgba(66,133,255,.16);'
        + 'display:flex;align-items:center;justify-content:center;flex:none;color:var(--electricBlue)';
      ic.innerHTML = U.ico(list.type === 'm3u' ? 'globe' : 'folder');
      ic.querySelector('svg').style.width = '22px';
      ic.querySelector('svg').style.height = '22px';
      card.appendChild(ic);

      var tx = App.el('div');
      tx.style.cssText = 'flex:1;min-width:0;margin-left:10px';
      var nameRow = App.el('div');
      nameRow.style.cssText = 'display:flex;align-items:center';
      nameRow.appendChild(App.el('div', 'trunc', list.name || 'Lista'));
      if (App.lists.activeId() === list.id) {
        var b = App.el('span', 'badge', 'ativa');
        b.style.cssText = 'font-size:10px;margin-left:6px;padding:2px 7px;border-radius:8px;background:rgba(61,220,151,.18);'
          + 'border:1px solid rgba(61,220,151,.5);color:#9ef0c8;flex:none';
        nameRow.appendChild(b);
      }
      tx.appendChild(nameRow);

      var sub = list.type === 'm3u'
        ? (App.lists.hostOf({ server: (list.urlHost || '') }) || 'M3U')
        : (list.server || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      var st = App.el('div', 's');
      if (list.error) st.textContent = list.error;
      else if (list.updated) st.textContent = 'Atualizada em ' + App.fmtDate(list.updated);
      else st.textContent = 'Nunca atualizada';
      if (list.error) st.style.color = '#ff9aa8';
      tx.appendChild(st);
      if (sub) tx.appendChild(App.el('div', 's dim', sub));
      card.appendChild(tx);

      card.addEventListener('click', function () { listMenu(list); });
      return card;
    }

    function listMenu(list) {
      var sheet = U.sheet({
        title: list.name || 'Lista',
        build: function (body, close) {
          var box = App.el('div');
          box.style.cssText = 'padding:0 16px 18px;overflow-y:auto';

          if (App.lists.activeId() !== list.id) {
            box.appendChild(U.btn('Usar esta lista', 'primary', function () {
              close();
              App.m.shell.activate(list.id);
            }));
          }

          var b2 = U.btn('Atualizar agora', null, function () {
            close();
            App.m.shell.refreshList(list);
          });
          box.appendChild(b2);

          var b3 = U.btn('Editar', null, function () {
            close();
            form(list);
          });
          box.appendChild(b3);

          var b4 = U.btn('Excluir lista', 'danger', function () {
            close();
            App.ui.confirm({
              title: 'Excluir lista',
              msg: 'A lista "' + (list.name || '') + '" e os itens salvos dela serão removidos. Favoritos e histórico desta lista também.\n\nContinuar?',
              yes: 'Excluir',
              no: 'Cancelar'
            }).then(function (ok) {
              if (!ok) return;
              App.lists.remove(list.id).then(function () {
                App.toast('Lista excluída');
                paint();
              });
            });
          });
          box.appendChild(b4);

          body.appendChild(box);
        }
      });
      return sheet;
    }

    function form(list) {
      var editing = !!list;
      var vals = {
        name: list ? list.name : '',
        url: '',
        server: list ? list.server : '',
        user: list ? list.user : '',
        pass: ''
      };
      var type = list ? list.type : 'm3u';

      /* Nome sugerido a partir do link: evita obrigar o usuario a digitar duas
         vezes quando ele acabou de colar a URL. */
      function hostDoLink(u) {
        var m = /^https?:\/\/([^\/:?#]+)/i.exec(String(u || '').trim());
        return m ? m[1].replace(/^www\./i, '') : '';
      }

      U.sheet({
        title: editing ? 'Editar lista' : 'Nova lista',
        build: function (body, close) {
          var box = App.el('div');
          box.style.cssText = 'padding:0 16px 20px;overflow-y:auto';

          var typeChips = U.chips([
            { id: 'm3u', name: 'Lista M3U' },
            { id: 'xtream', name: 'Xtream Codes' }
          ], type, function (c) {
            type = c.id;
            render();
          });
          box.appendChild(typeChips);

          var fields = App.el('div');
          box.appendChild(fields);

          var nameInput = null;

          function inputField(label, key, opts) {
            opts = opts || {};
            var f = U.textField(label, {
              value: vals[key] || '',
              placeholder: opts.placeholder,
              inputMode: opts.inputMode,
              autocap: opts.autocap,
              password: opts.password,
              paste: opts.paste,
              onPaste: opts.onPaste,
              onInput: function (v) { vals[key] = v; }
            });
            fields.appendChild(f.el);
            return f.input;
          }

          function render() {
            App.clear(fields);

            var chips = fields.parentNode.querySelector('.chips');
            var on = chips.querySelectorAll('.chip');
            for (var i = 0; i < on.length; i++) {
              on[i].classList.toggle('on', (i === 0 && type === 'm3u') || (i === 1 && type === 'xtream'));
            }

            nameInput = inputField('Nome da lista', 'name', { placeholder: 'Ex.: Minha TV' });

            if (type === 'm3u') {
              inputField(editing ? 'Link da lista (deixe vazio para manter)' : 'Link da lista (.m3u / .m3u8)',
                'url', {
                  placeholder: 'https://servidor.com/lista.m3u',
                  inputMode: 'url',
                  autocap: false,
                  paste: true,
                  onPaste: function (texto) {
                    if (nameInput && !nameInput.value.trim()) {
                      var sug = hostDoLink(texto);
                      if (sug) { nameInput.value = sug; vals.name = sug; }
                    }
                  }
                });
              var dica = App.el('div', 'small dim');
              dica.style.cssText = 'margin:-4px 2px 12px;line-height:1.45';
              dica.textContent = 'Dica: no projetor é mais fácil copiar o link no celular e usar o botão Colar.';
              fields.appendChild(dica);
            } else {
              inputField('Servidor (URL)', 'server', {
                placeholder: 'http://servidor.com:8080',
                inputMode: 'url',
                autocap: false,
                paste: true
              });
              inputField('Usuário', 'user', { autocap: false, paste: true });
              inputField(editing ? 'Senha (deixe vazio para manter)' : 'Senha', 'pass', {
                password: true,
                autocap: false,
                paste: true
              });
            }

            var save = U.btn(editing ? 'Salvar alterações' : 'Adicionar lista', 'primary', function () {
              var f = { name: (vals.name || '').trim() || 'Minha lista', type: type };
              if (type === 'm3u') {
                if (!vals.url.trim() && !editing) return App.toast('Informe o link da lista');
                f.url = vals.url.trim();
              } else {
                if (!vals.server.trim() || !vals.user.trim()) return App.toast('Informe servidor e usuário');
                if (!vals.pass && !editing) return App.toast('Informe a senha');
                f.server = vals.server.trim();
                f.user = vals.user.trim();
                f.pass = vals.pass;
              }
              save.disabled = true;
              App.lists.save(f, editing ? list.id : null).then(function (rec) {
                close();
                if (!App.lists.activeId() || editing) App.lists.setActive(rec.id);
                App.toast(editing ? 'Lista atualizada' : 'Lista adicionada');
                App.m.shell.refreshList(App.lists.get(rec.id));
                paint();
                /* primeira lista: leva direto para a tela inicial, senao o usuario
                   fica parado em Configuracoes sem saber que ja pode assistir. */
                if (!editing && App.m.shell) App.m.shell.go('home');
              }, function () {
                save.disabled = false;
                App.toast('Não foi possível salvar a lista');
              });
            });
            save.style.marginTop = '8px';
            fields.appendChild(save);
          }

          render();
          body.appendChild(box);
        }
      });
    }

    /* ---------------------------------------------------------- secoes --- */

    function sectionLists() {
      var box = App.el('div');
      box.appendChild(U.sectionTitle('Listas', null, null));

      var all = App.lists.all();
      if (!all.length) {
        box.appendChild(U.empty('Nenhuma lista', 'Adicione um link M3U ou os dados do Xtream Codes.'));
      }
      all.forEach(function (l) { box.appendChild(listCard(l)); });

      var add = U.btn('Adicionar lista', 'primary', function () { form(null); });
      add.style.marginTop = '10px';
      box.appendChild(add);
      return box;
    }

    function sectionPlayback() {
      var box = App.el('div');
      box.appendChild(U.sectionTitle('Reprodução', null, null));

      box.appendChild(U.toggleRow(
        'Iniciar no último canal assistido',
        'Ao abrir o app, volta ao último canal visto (nunca em conteúdo adulto).',
        App.resume.enabled(),
        function (on) {
          App.resume.setEnabled(on);
          App.toast(on ? 'Vai iniciar no último canal' : 'Início normal');
        }
      ));

      box.appendChild(U.toggleRow(
        'Monitoramento da saúde dos canais',
        'Verifica se o canal responde e mostra um indicador colorido.',
        App.health.enabled(),
        function (on) {
          App.health.setEnabled(on);
          App.toast(on ? 'Monitoramento ligado' : 'Monitoramento desligado');
        }
      ));

      box.appendChild(actionRow('Limpar histórico', 'Remove o progresso de filmes e séries e o último canal.', function () {
        App.ui.confirm({
          title: 'Limpar histórico',
          msg: 'O progresso salvo de filmes e séries será apagado.',
          yes: 'Limpar',
          no: 'Cancelar'
        }).then(function (ok) {
          if (!ok) return;
          App.store.set('hist', []);
          App.resume.clear();
          App.toast('Histórico limpo');
          paint();
        });
      }));
      return box;
    }

    function sectionDisplay() {
      var box = App.el('div');
      box.appendChild(U.sectionTitle('Tela', null, null));

      var pref = App.m.modePref || 'auto';
      box.appendChild(U.chips([
        { id: 'auto', name: 'Automático' },
        { id: 'phone', name: 'Celular' },
        { id: 'tv', name: 'Projetor / TV' }
      ], pref, function (c) {
        App.m.setMode(c.id);
        App.toast(c.id === 'tv' ? 'Modo projetor ativado'
          : (c.id === 'phone' ? 'Modo celular ativado' : 'Modo automático'), 1800);
        if (App.m.shell && App.m.shell.reflow) App.m.shell.reflow();
        else paint();
      }));

      var hint = App.el('div', 'small dim');
      hint.style.cssText = 'line-height:1.5';
      hint.textContent = 'No modo projetor o app usa a trilha lateral, alvos maiores e as setas do controle '
        + '(OK confirma, Voltar sai). Automático reconhece telas largas — esta é '
        + g.innerWidth + '×' + g.innerHeight + '.';
      box.appendChild(hint);
      return box;
    }

    function sectionParental() {
      var box = App.el('div');
      box.appendChild(U.sectionTitle('Controle parental', null, null));

      var has = App.parental.hasPin();
      var on = App.parental.enabled();

      if (!has) {
        box.appendChild(actionRow('Definir senha', 'Oculta canais e filmes para adultos e pede a senha para liberar.',
          function () {
            App.ui.pinNew({ title: 'Definir senha' }).then(function (pin) {
              if (!pin) return;
              App.parental.setPin(pin).then(function () {
                App.toast('Senha definida — conteúdo adulto bloqueado');
                paint();
              });
            });
          }));
        return box;
      }

      var status = App.el('div', 'card');
      status.style.cssText = 'padding:12px;margin-bottom:10px;display:flex;align-items:center';
      var dot = App.el('i', 'hdot ' + (on ? 'green' : 'gray'));
      status.appendChild(dot);
      var stTxt = App.el('div', null, on
        ? (App.parental.unlocked() ? 'Bloqueio ativo — liberado nesta sessão' : 'Bloqueio ativo')
        : 'Bloqueio desativado');
      stTxt.style.marginLeft = '10px';
      status.appendChild(stTxt);
      box.appendChild(status);

      box.appendChild(actionRow('Alterar senha', null, function () {
        App.ui.pinAsk({ title: 'Senha atual', msg: 'Digite a senha atual para alterar.' }).then(function (ok) {
          if (!ok) return;
          return App.ui.pinNew({ title: 'Nova senha' }).then(function (pin) {
            if (!pin) return;
            App.parental.setPin(pin).then(function () {
              App.toast('Senha alterada');
              paint();
            });
          });
        });
      }));

      if (on) {
        box.appendChild(actionRow('Desativar bloqueio', 'Pede a senha atual.', function () {
          App.ui.pinAsk({ title: 'Desativar', msg: 'Digite a senha para desativar o controle parental.' }).then(function (ok) {
            if (!ok) return;
            App.parental.enable(false);
            App.toast('Controle parental desativado');
            paint();
          });
        }, true));
      } else {
        box.appendChild(actionRow('Ativar bloqueio', 'Volta a ocultar conteúdo adulto.', function () {
          App.parental.enable(true);
          App.toast('Controle parental ativado');
          paint();
        }));
      }

      if (App.parental.locked()) {
        box.appendChild(actionRow('Liberar agora', 'Mostra o conteúdo adulto até fechar o app.', function () {
          App.ui.pinAsk({ title: 'Liberar', msg: 'Digite a senha para liberar o conteúdo adulto.' }).then(function (ok) {
            if (!ok) return;
            App.parental.unlock();
            App.toast('Conteúdo adulto liberado');
            paint();
          });
        }));
      } else if (on) {
        box.appendChild(actionRow('Bloquear agora', 'Esconde o conteúdo adulto de novo.', function () {
          App.parental.lock();
          App.toast('Conteúdo adulto bloqueado');
          paint();
        }));
      }
      return box;
    }

    function sectionAbout() {
      var box = App.el('div');
      box.appendChild(U.sectionTitle('Sobre', null, null));

      var info = App.native.info() || {};
      var card = App.el('div', 'card');
      card.style.cssText = 'padding:14px';
      card.appendChild(App.el('div', 'h1', 'Space IPTV'));
      var v = App.el('div', 'small muted');
      v.style.marginTop = '4px';
      v.textContent = 'Versão ' + (info.version || '1.0.0') + ' • Android ' + (info.sdk || '')
        + (info.model ? ' • ' + info.model : '');
      card.appendChild(v);

      var st = App.el('div', 'small dim');
      st.style.cssText = 'margin-top:10px;line-height:1.5';
      st.textContent = 'Reprodutor IPTV para listas M3U e Xtream Codes. '
        + 'O app não fornece, hospeda nem distribui conteúdo: tudo vem da lista que você configurar.';
      card.appendChild(st);

      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(function (e) {
          var mb = ((e.usage || 0) / 1048576).toFixed(1);
          var line = App.el('div', 'small dim');
          line.style.marginTop = '8px';
          line.textContent = 'Dados salvos no aparelho: ' + mb + ' MB';
          card.appendChild(line);
        }).catch(function () { });
      }

      box.appendChild(card);

      box.appendChild(actionRow('Sair do app', 'Fecha o Space IPTV.', function () {
        App.ui.confirm({ title: 'Sair', msg: 'Deseja fechar o Space IPTV?', yes: 'Sair', no: 'Ficar' })
          .then(function (ok) { if (ok) App.native.exit(); });
      }, true));

      return box;
    }

    function paint() {
      App.clear(scroll);
      scroll.appendChild(sectionLists());
      scroll.appendChild(sectionPlayback());
      scroll.appendChild(sectionDisplay());
      scroll.appendChild(sectionParental());
      scroll.appendChild(sectionAbout());
    }

    paint();
    App.bus.on('catalog:done', paint);
    App.bus.on('catalog:error', paint);

    return {
      el: root,
      destroy: function () {
        App.bus.off('catalog:done', paint);
        App.bus.off('catalog:error', paint);
      },
      refresh: paint
    };
  };
})(window);
