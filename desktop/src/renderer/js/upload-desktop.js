/* Upload de lista M3U/M3U8 no desktop.
 *
 * Mesmo contrato de `web/js/upload.js` (a tela de Configurações só mostra a ação se
 * `App.upload.open` existir):
 *   App.upload.open({record?, onSaved?})
 *   App.upload.MAX = 25 MB
 *
 * Diferença: o arquivo é escolhido no dialog NATIVO (`space.files.pickM3u`), que lê
 * no processo principal — o renderer nunca vê caminho de arquivo. Validação/preview
 * é a mesma da web (`App.m3u.parse`, contagens) e o salvamento usa `App.lists.saveFile`.
 * Drag & drop é melhoria: o FileReader roda no renderer, sem expor path.
 */
(function (g) {
  'use strict';
  var App = g.App;
  if (!App) return;

  var MAX = 25 * 1024 * 1024;
  var space = typeof g.space !== 'undefined' ? g.space : null;
  var dropWired = false;

  function isTyping() {
    var a = document.activeElement;
    if (!a) return false;
    var t = a.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || a.isContentEditable === true;
  }

  function fmtBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function pickNative(maxBytes) {
    if (!space || !space.files || typeof space.files.pickM3u !== 'function') {
      return Promise.resolve({ ok: false, error: 'A escolha de arquivo não está disponível neste ambiente.' });
    }
    try {
      return Promise.resolve(space.files.pickM3u({ maxBytes: maxBytes }));
    } catch (e) {
      return Promise.resolve({ ok: false, error: 'Não foi possível abrir o seletor de arquivos.' });
    }
  }

  /* Abertura do modal. `initialFile` permite drag&drop antes/junto do dialog. */
  function open(opts) {
    opts = opts || {};
    var existing = opts.record || null;
    var text = '';
    var fileInfo = null;
    var valid = false;
    var busy = false;
    var closed = false;
    var closeFn = null;

    var ov = App.el('div', 'overlay');
    var m = App.el('div', 'modal glass-panel upload-modal');
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-label', existing ? 'Substituir arquivo da lista' : 'Adicionar lista por arquivo');
    m.appendChild(App.el('h2', 'h2', existing ? 'Substituir arquivo da lista' : 'Adicionar lista por arquivo'));
    m.appendChild(App.el('div', 'body-sm upload-note',
      'O arquivo é lido e guardado somente neste computador. Nada é enviado a servidores do app.'));

    var form = App.el('div', 'form');

    /* Nome da lista */
    var nameField = App.el('div', 'field');
    var nameId = 'upload-name-' + App.uid();
    var nameLabel = App.el('label', null, 'Nome da lista');
    nameLabel.htmlFor = nameId;
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = nameId;
    nameInput.value = existing ? existing.name : '';
    nameInput.placeholder = 'Minha lista';
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameField.appendChild(nameLabel);
    nameField.appendChild(nameInput);
    form.appendChild(nameField);

    /* Arquivo escolhido pelo dialog nativo */
    var fileField = App.el('div', 'field upload-field');
    var fileLabel = App.el('label', null, 'Arquivo .m3u ou .m3u8');
    var fileRow = App.el('div', 'upload-pick-row');
    var pickBtn = App.ui.btn(existing ? 'Escolher novo arquivo…' : 'Escolher arquivo…', '');
    pickBtn.setAttribute('aria-label', 'Escolher arquivo M3U ou M3U8 no computador');
    fileRow.appendChild(pickBtn);
    var helper = App.el('span', 'upload-hint', 'tamanho máximo ' + fmtBytes(MAX));
    fileRow.appendChild(helper);
    fileField.appendChild(fileLabel);
    fileField.appendChild(fileRow);
    form.appendChild(fileField);

    var preview = App.el('div', 'upload-preview');
    preview.setAttribute('aria-live', 'polite');
    if (existing && existing.filename) preview.textContent = 'Arquivo atual: ' + existing.filename;
    form.appendChild(preview);

    var err = App.el('div', 'err-line');
    err.setAttribute('aria-live', 'polite');
    form.appendChild(err);

    var bs = App.el('div', 'btns');
    var cancel = App.ui.btn('Cancelar');
    var save = App.ui.btn(existing ? 'Salvar' : 'Adicionar', 'primary');
    bs.appendChild(cancel);
    bs.appendChild(save);
    form.appendChild(bs);
    m.appendChild(form);
    ov.appendChild(m);

    var grp = App.ui.group([cancel, pickBtn, save], true);

    function setErr(msg) { err.textContent = msg || ''; }
    function labelSave() { save.textContent = existing ? 'Salvar' : 'Adicionar'; }

    function setCounts(result) {
      var live = result.live ? result.live.length : 0;
      var movie = result.movie ? result.movie.length : 0;
      var series = result.series ? result.series.length : 0;
      preview.textContent = 'Arquivo: ' + fileInfo.name + ' (' + fmtBytes(fileInfo.size) + ') • ' +
        live + ' canal(is), ' + movie + ' filme(s), ' + series + ' série(s)';
    }

    function resetFile() {
      text = '';
      fileInfo = null;
      valid = false;
      setErr('');
      preview.textContent = existing && existing.filename ? 'Arquivo atual: ' + existing.filename : '';
    }

    /* Aplica o texto (vindo do dialog nativo ou do drag&drop). */
    function applyText(raw, info) {
      text = String(raw == null ? '' : raw);
      fileInfo = { name: String(info && info.name || 'lista.m3u'), size: Number(info && info.size) || text.length };
      valid = false;
      setErr('');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      if (!text.replace(/^\s+|\s+$/g, '')) {
        text = '';
        setErr('O arquivo está vazio.');
        preview.textContent = '';
        return;
      }
      if (fileInfo.size > MAX) {
        text = '';
        setErr('O arquivo tem ' + fmtBytes(fileInfo.size) + ' e o limite é ' + fmtBytes(MAX) + '. Use uma lista menor.');
        return;
      }
      if (!/\.m3u8?$/i.test(fileInfo.name)) {
        /* O dialog nativo já filtra; aqui cobre drag&drop de outro tipo de arquivo. */
        text = '';
        setErr('Escolha um arquivo com extensão .m3u ou .m3u8.');
        return;
      }
      if (!nameInput.value.replace(/^\s+|\s+$/g, '')) {
        nameInput.value = String(fileInfo.name).replace(/\.m3u8?$/i, '');
      }
      preview.textContent = 'Lendo ' + fileInfo.name + '…';
      Promise.resolve(App.m3u.parse(text)).then(function (r) {
        valid = true;
        setCounts(r || {});
      }, function () {
        valid = false;
        text = '';
        preview.textContent = '';
        setErr('Este arquivo não parece uma lista M3U/M3U8 válida (sem canais, filmes ou séries).');
      });
    }

    function chooseNative() {
      if (busy) return;
      setErr('');
      pickNative(MAX).then(function (res) {
        if (!res || res.canceled) return;
        if (!res.ok) { setErr(res.error || 'Não foi possível ler o arquivo.'); return; }
        applyText(res.text, { name: res.name, size: res.size });
      });
    }

    /* Drag & drop (FileReader no renderer; nenhum caminho exposto). */
    function readDroppedFile(file) {
      if (!file) return;
      if (!/\.m3u8?$/i.test(file.name || '')) {
        setErr('Escolha um arquivo com extensão .m3u ou .m3u8.');
        return;
      }
      if (file.size > MAX) {
        setErr('O arquivo tem ' + fmtBytes(file.size) + ' e o limite é ' + fmtBytes(MAX) + '. Use uma lista menor.');
        return;
      }
      if (!file.size) { setErr('O arquivo está vazio.'); return; }
      preview.textContent = 'Lendo ' + file.name + '…';
      var reader = new FileReader();
      reader.onload = function () {
        applyText(String(reader.result || ''), { name: file.name, size: file.size });
      };
      reader.onerror = function () { setErr('Não foi possível ler o arquivo.'); };
      reader.readAsText(file);
    }

    function onDragOver(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.dataTransfer) { try { ev.dataTransfer.dropEffect = 'copy'; } catch (e) { /* ignore */ } }
      m.classList.add('drop-target');
    }
    function onDragLeave(ev) {
      ev.preventDefault();
      if (ev.target === m || (ev.target && ev.target.contains && !m.contains(ev.relatedTarget))) m.classList.remove('drop-target');
    }
    function onDrop(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      m.classList.remove('drop-target');
      if (busy) return;
      var files = ev.dataTransfer ? ev.dataTransfer.files : null;
      if (!files || !files.length) return;
      readDroppedFile(files[0]);
    }
    ov.addEventListener('dragover', onDragOver);
    ov.addEventListener('dragleave', onDragLeave);
    ov.addEventListener('drop', onDrop);

    function end(rec) {
      if (closed) return;
      closed = true;
      if (closeFn) closeFn();
      if (rec && typeof opts.onSaved === 'function') {
        try { opts.onSaved(rec); } catch (e) { logSafe('upload-desktop: onSaved falhou', e && e.message); }
      }
    }

    function submit() {
      if (busy) return;
      setErr('');
      var name = nameInput.value.replace(/^\s+|\s+$/g, '');
      if (!name) { setErr('Informe um nome para a lista.'); try { nameInput.focus(); } catch (e) { /* ignore */ } return; }
      if (!text) {
        if (existing) {
          /* Sem novo arquivo: só renomeia, preservando o conteúdo atual. */
          App.lists.patch(existing.id, { name: name });
          return end(App.lists.get(existing.id) || existing);
        }
        return setErr('Selecione um arquivo .m3u ou .m3u8.');
      }
      if (!valid) return setErr('Corrija o arquivo antes de salvar.');
      busy = true;
      save.textContent = 'Salvando...';
      App.lists.saveFile({
        name: name,
        filename: fileInfo ? fileInfo.name : (existing && existing.filename) || '',
        size: fileInfo ? fileInfo.size : (existing && existing.size) || text.length,
        text: text
      }, existing ? existing.id : null).then(function (rec) {
        busy = false;
        labelSave();
        end(rec);
      }, function (e) {
        busy = false;
        labelSave();
        setErr(e && e.code === 'storage'
          ? 'Não foi possível guardar o arquivo neste computador. Verifique o espaço disponível.'
          : 'Não foi possível salvar a lista.');
      });
    }

    save._act = submit;
    cancel._act = function () { if (!busy) end(null); };
    pickBtn._act = chooseNative;

    var layer = {
      key: function (a) {
        if (a === 'back') { if (!busy) end(null); return true; }
        if (isTyping()) return false;         /* keys.js cuida do campo de texto */
        if (a === 'up') { grp.focus(0); return true; }
        if (a === 'down') { grp.focus(2); return true; }
        if (grp.key(a)) return true;
        return true;
      }
    };
    closeFn = App.ui.open(ov, layer);
    grp.blur();
    setTimeout(function () { try { nameInput.focus(); } catch (e) { /* ignore */ } }, 40);

    if (opts._initialFile) readDroppedFile(opts._initialFile);
  }

  App.upload = { open: open, MAX: MAX };

  /* Drag&drop na janela: se o modal já está aberto, ele mesmo trata o drop;
     senão, abre o modal já com o arquivo (FileReader no renderer). */
  (function patchGlobalDrop() {
    if (dropWired) return;
    dropWired = true;
    function hasFiles(ev) {
      var types = ev.dataTransfer && ev.dataTransfer.types;
      if (!types) return false;
      for (var i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
      return false;
    }
    g.addEventListener('dragover', function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      try { if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'; } catch (e) { /* ignore */ }
    }, true);
    g.addEventListener('drop', function (ev) {
      if (!hasFiles(ev)) return;
      var overlays = g.document.getElementById('overlays');
      if (overlays && overlays.children.length) return; /* modal já aberto trata o drop */
      ev.preventDefault();
      var file = ev.dataTransfer && ev.dataTransfer.files ? ev.dataTransfer.files[0] : null;
      if (!file) return;
      open({ _initialFile: file });
    }, true);
  })();

  function logSafe() {
    if (typeof App.log !== 'function') return;
    try { App.log.apply(App, arguments); } catch (e) { /* ignore */ }
  }
})(window);
