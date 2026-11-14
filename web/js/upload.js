/* Upload local de listas M3U/M3U8 (web). Lê o arquivo no navegador e guarda o texto
   no IndexedDB; nada é enviado a servidor. A tela de Configurações só mostra a ação
   quando este módulo existe (a TV não o carrega). */
(function (g) {
  'use strict';
  var App = g.App;
  var MAX = 20 * 1024 * 1024;

  function isTyping() {
    var a = document.activeElement;
    if (!a) return false;
    var t = a.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || a.isContentEditable === true;
  }

  function open(opts) {
    opts = opts || {};
    var existing = opts.record || null;
    var text = '', fileInfo = null, valid = false, busy = false, closed = false, closeFn = null;

    var ov = App.el('div', 'overlay');
    var m = App.el('div', 'modal glass-panel upload-modal');
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-label', existing ? 'Substituir arquivo da lista' : 'Adicionar lista por arquivo');
    m.appendChild(App.el('h2', 'h2', existing ? 'Substituir arquivo da lista' : 'Adicionar lista por arquivo'));
    m.appendChild(App.el('div', 'body-sm upload-note',
      'O arquivo é lido e guardado somente neste navegador. Nada é enviado a servidores do app.'));

    var form = App.el('div', 'form');

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

    var fileField = App.el('div', 'field upload-field');
    var fileId = 'upload-file-' + App.uid();
    var fileLabel = App.el('label', null, 'Arquivo .m3u ou .m3u8');
    fileLabel.htmlFor = fileId;
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = fileId;
    fileInput.accept = '.m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl,application/x-mpegURL';
    fileInput.setAttribute('aria-label', 'Escolher arquivo M3U ou M3U8');
    fileField.appendChild(fileLabel);
    fileField.appendChild(fileInput);
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

    var grp = App.ui.group([cancel, save], true);

    function setErr(msg) { err.textContent = msg || ''; }
    function labelSave() { save.textContent = existing ? 'Salvar' : 'Adicionar'; }

    function setCounts(r) {
      var live = r.live.length, movie = r.movie.length, series = r.series.length;
      preview.textContent = 'Arquivo: ' + fileInfo.name + ' • ' + live + ' canal(is), ' +
        movie + ' filme(s), ' + series + ' série(s)';
    }

    function readFile(file) {
      text = ''; fileInfo = null; valid = false;
      setErr('');
      if (!file) { preview.textContent = existing && existing.filename ? 'Arquivo atual: ' + existing.filename : ''; return; }
      if (!/\.m3u8?$/i.test(file.name || '')) return setErr('Escolha um arquivo com extensão .m3u ou .m3u8.');
      if (file.size > MAX) return setErr('O arquivo passa de 20 MB. Use uma lista menor.');
      if (!file.size) return setErr('O arquivo está vazio.');
      if (!nameInput.value.replace(/^\s+|\s+$/g, '')) nameInput.value = String(file.name).replace(/\.m3u8?$/i, '');
      preview.textContent = 'Lendo ' + file.name + '…';
      var reader = new FileReader();
      reader.onload = function () {
        text = String(reader.result || '');
        if (!text.replace(/^\s+|\s+$/g, '')) { setErr('O arquivo está vazio.'); preview.textContent = ''; return; }
        fileInfo = { name: file.name, size: file.size };
        App.m3u.parse(text).then(function (r) {
          valid = true;
          setCounts(r);
        }, function () {
          valid = false;
          preview.textContent = '';
          setErr('Este arquivo não parece uma lista M3U/M3U8 válida (sem canais, filmes ou séries).');
        });
      };
      reader.onerror = function () { setErr('Não foi possível ler o arquivo.'); };
      reader.readAsText(file);
    }
    fileInput.addEventListener('change', function () { readFile(fileInput.files && fileInput.files[0]); });

    function end(rec) {
      if (closed) return;
      closed = true;
      if (closeFn) closeFn();
      if (rec && typeof opts.onSaved === 'function') {
        try { opts.onSaved(rec); } catch (e) { App.log('upload: onSaved falhou', e && e.message); }
      }
    }

    function submit() {
      if (busy) return;
      setErr('');
      var name = nameInput.value.replace(/^\s+|\s+$/g, '');
      if (!name) { setErr('Informe um nome para a lista.'); nameInput.focus(); return; }
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
          ? 'O navegador não conseguiu guardar o arquivo. Verifique o espaço disponível.'
          : 'Não foi possível salvar a lista.');
      });
    }

    save._act = submit;
    cancel._act = function () { if (!busy) end(null); };

    var layer = {
      key: function (a) {
        if (a === 'back') { if (!busy) end(null); return true; }
        if (isTyping()) return false;         /* keys.js cuida de input/arquivo */
        if (a === 'up') { grp.focus(0); return true; }
        if (a === 'down') { grp.focus(1); return true; }
        if (grp.key(a)) return true;
        return true;
      }
    };
    closeFn = App.ui.open(ov, layer);
    grp.blur();
    setTimeout(function () { nameInput.focus(); }, 40);
  }

  App.upload = { open: open, MAX: MAX };
})(window);
