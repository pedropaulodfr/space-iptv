/* Overlays, modais, botoes e formularios controlados por D-Pad */
(function (g) {
  'use strict';
  var App = g.App;
  var root = function () { return document.getElementById('overlays'); };

  var ui = App.ui = {};

  /* Abre uma camada em tela cheia. layer.key(action) recebe as teclas. Devolve close(). */
  ui.open = function (el, layer) {
    root().appendChild(el);
    App.nav.push(layer);
    var closed = false;
    return function () {
      if (closed) return; closed = true;
      App.nav.pop(layer);
      if (el.parentNode) el.parentNode.removeChild(el);
    };
  };

  ui.btn = function (label, cls) { var b = App.el('div', 'btn focusable ' + (cls || ''), label); return b; };

  /* grupo linear de botoes/itens (h = horizontal) */
  ui.group = function (nodes, horizontal) {
    var g2 = { nodes: nodes, i: 0, has: false };
    g2.set = function (i) {
      if (g2.has && nodes[g2.i]) nodes[g2.i].classList.remove('focused');
      g2.i = i;
      if (g2.has && nodes[i]) nodes[i].classList.add('focused');
    };
    g2.focus = function (i) { g2.has = true; g2.set(i == null ? g2.i : i); nodes[g2.i].classList.add('focused'); };
    g2.blur = function () { g2.has = false; if (nodes[g2.i]) nodes[g2.i].classList.remove('focused'); };
    g2.key = function (a) {
      var prev = horizontal ? 'left' : 'up', next = horizontal ? 'right' : 'down';
      if (a === prev) { if (g2.i > 0) { g2.set(g2.i - 1); return true; } return false; }
      if (a === next) { if (g2.i < nodes.length - 1) { g2.set(g2.i + 1); return true; } return false; }
      if (a === 'ok') { var n = nodes[g2.i]; if (n && n._act) n._act(); return true; }
      return false;
    };
    return g2;
  };

  /* modal de confirmacao -> Promise<bool> */
  ui.confirm = function (o) {
    return new Promise(function (res) {
      var ov = App.el('div', 'overlay'), m = App.el('div', 'modal glass-panel');
      m.appendChild(App.el('h2', 'h2', o.title));
      m.appendChild(App.el('div', 'msg', o.msg || ''));
      var bs = App.el('div', 'btns'), yes = ui.btn(o.yes || 'Confirmar', 'primary ' + (o.danger ? 'danger' : '')), no = ui.btn(o.no || 'Cancelar');
      bs.appendChild(no); bs.appendChild(yes); m.appendChild(bs); ov.appendChild(m);
      var grp = ui.group([no, yes], true), close;
      function end(v) { close(); res(v); }
      yes._act = function () { end(true); }; no._act = function () { end(false); };
      close = ui.open(ov, { key: function (a) { if (a === 'back') { end(false); return true; } grp.key(a); return true; } });
      grp.focus(o.danger ? 0 : 1);
    });
  };

  ui.alert = function (title, msg) {
    return new Promise(function (res) {
      var ov = App.el('div', 'overlay'), m = App.el('div', 'modal glass-panel');
      m.appendChild(App.el('h2', 'h2', title)); m.appendChild(App.el('div', 'msg', msg));
      var bs = App.el('div', 'btns'), ok = ui.btn('OK', 'primary'); bs.appendChild(ok); m.appendChild(bs); ov.appendChild(m);
      var close = ui.open(ov, { key: function (a) { if (a === 'ok' || a === 'back') { close(); res(); } return true; } });
      ok.classList.add('focused');
    });
  };

  /* Formulario. o: {title, fields:[{id,label,type,value,placeholder}], submit, onSubmit(values)->Promise<null|string erro>} */
  ui.form = function (o) {
    return new Promise(function (res) {
      var ov = App.el('div', 'overlay'), m = App.el('div', 'modal glass-panel'), form = App.el('div', 'form');
      m.appendChild(App.el('h2', 'h2', o.title));
      if (o.note) m.appendChild(App.el('div', 'body-sm', o.note));
      var inputs = {}, rows = [];
      o.fields.forEach(function (f) {
        var d = App.el('div', 'field focusable'), lb = App.el('label', null, f.label), inp = document.createElement('input');
        inp.type = f.type || 'text'; inp.value = f.value || ''; inp.placeholder = f.placeholder || '';
        inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('autocapitalize', 'off');
        d.appendChild(lb); d.appendChild(inp); form.appendChild(d);
        inputs[f.id] = inp; d._input = inp; rows.push(d);
      });
      var err = App.el('div', 'err-line'); form.appendChild(err);
      var save = ui.btn(o.submit || 'Salvar', 'primary'), cancel = ui.btn('Cancelar');
      var bs = App.el('div', 'btns'); bs.appendChild(cancel); bs.appendChild(save); form.appendChild(bs);
      m.appendChild(form); ov.appendChild(m);
      var row = 0, col = 1, busy = false, close;   /* row == rows.length -> linha de botoes */
      var btnGrp = ui.group([cancel, save], true);
      function paint() {
        rows.forEach(function (r, i) { r.classList[i === row ? 'add' : 'remove']('focused'); });
        if (row === rows.length) btnGrp.focus(col); else btnGrp.blur();
      }
      function end(v) { close(); res(v); }
      function submit() {
        if (busy) return;
        var vals = {}, k; for (k in inputs) vals[k] = inputs[k].value.replace(/^\s+|\s+$/g, '');
        busy = true; err.textContent = ''; save.textContent = 'Verificando...';
        Promise.resolve(o.onSubmit(vals)).then(function (e) {
          busy = false; save.textContent = o.submit || 'Salvar';
          if (e) err.textContent = e; else end(true);
        }, function (e) { busy = false; save.textContent = o.submit || 'Salvar'; err.textContent = (e && e.message) || 'Erro inesperado.'; });
      }
      save._act = submit; cancel._act = function () { if (!busy) end(false); };
      close = ui.open(ov, {
        key: function (a) {
          if (busy) return true;
          if (a === 'back') { end(false); return true; }
          if (a === 'up') { if (row > 0) { row--; paint(); } return true; }
          if (a === 'down') { if (row < rows.length) { row++; paint(); } return true; }
          if (row === rows.length) { btnGrp.key(a); col = btnGrp.i; return true; }
          if (a === 'ok') { rows[row]._input.focus(); return true; }
          return true;
        }
      });
      paint();
    });
  };

  ui.loading = function (text) {
    var b = App.el('div', 'loading-box'); b.appendChild(App.el('div', 'spinner')); b.appendChild(App.el('div', null, text || 'Carregando...'));
    return b;
  };

  /* ---------- teclado numerico (senha / controle parental) ---------- */

  /* o: {title, msg, verify(pin)->Promise<bool>}. Resolve a senha digitada ou null se voltar. */
  function pinPad(o) {
    return new Promise(function (res) {
      var LEN = App.parental.LEN || 4, val = '', busy = false, dots = [], keys = [], i;
      var ov = App.el('div', 'overlay'), m = App.el('div', 'modal glass-panel pin');
      m.appendChild(App.el('h2', 'h2', o.title || 'Senha'));
      if (o.msg) m.appendChild(App.el('div', 'body-sm', o.msg));

      var dotsEl = App.el('div', 'pin-dots');
      for (i = 0; i < LEN; i++) { var d = App.el('div', 'pin-dot'); dots.push(d); dotsEl.appendChild(d); }
      m.appendChild(dotsEl);
      var msgEl = App.el('div', 'pin-msg'); m.appendChild(msgEl);

      var grid = App.el('div', 'pin-grid');
      [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['apagar', '0', 'ok']].forEach(function (line) {
        var row = App.el('div', 'pin-row');
        line.forEach(function (v) {
          var b = App.el('div', 'pin-key' + (v.length > 1 ? ' small' : ''), v === 'apagar' ? 'Apagar' : (v === 'ok' ? 'OK' : v));
          b._v = v; row.appendChild(b); keys.push(b);
        });
        grid.appendChild(row);
      });
      m.appendChild(grid); ov.appendChild(m);

      var idx = keys.length - 1, close;   /* comeca no OK: digitando pelos numeros do controle, OK ja confirma */
      function paint() { for (var k = 0; k < keys.length; k++) keys[k].classList[k === idx ? 'add' : 'remove']('focused'); }
      function draw() {
        for (var k = 0; k < dots.length; k++) dots[k].classList[k < val.length ? 'add' : 'remove']('on');
        msgEl.className = 'pin-msg';
      }
      function alerta(t) { msgEl.className = 'pin-msg err'; msgEl.textContent = t; }
      function end(pin) { close(); res(pin); }
      function submit() {
        if (busy) return;
        if (val.length < LEN) return alerta('Digite os ' + LEN + ' dígitos.');
        if (!o.verify) return end(val);
        busy = true;
        Promise.resolve(o.verify(val)).then(function (ok) {
          busy = false;
          if (ok) return end(val);
          val = ''; draw(); alerta('Senha incorreta. Tente de novo.');
        }, function () { busy = false; alerta('Não foi possível conferir a senha.'); });
      }
      function press(v) {
        if (v === 'apagar') { val = val.slice(0, -1); draw(); return; }
        if (v === 'ok') return submit();
        if (val.length < LEN) { val += v; draw(); }
      }

      close = ui.open(ov, {
        key: function (a) {
          if (busy) return true;
          if (a === 'back' || a === 'red') { end(null); return true; }
          if (a === 'left') { if (idx % 3) { idx--; paint(); } return true; }
          if (a === 'right') { if (idx % 3 < 2) { idx++; paint(); } return true; }
          if (a === 'up') { if (idx >= 3) { idx -= 3; paint(); } return true; }
          if (a === 'down') { if (idx < 9) { idx += 3; paint(); } return true; }
          if (a === 'ok') { press(keys[idx]._v); return true; }
          if (a && a.length === 2 && a.charAt(0) === 'n') { press(a.charAt(1)); return true; }
          return true;
        }
      });
      paint(); draw();
    });
  }

  /* Confere a senha salva -> Promise<bool> (false se cancelar). */
  ui.pinAsk = function (o) {
    o = o || {};
    return pinPad({ title: o.title || 'Senha', msg: o.msg, verify: function (pin) { return App.parental.check(pin); } })
      .then(function (pin) { return pin != null; });
  };

  /* Pede uma senha nova duas vezes -> Promise<string|null>. */
  ui.pinNew = function (o) {
    o = o || {};
    return pinPad({ title: o.title || 'Definir senha', msg: o.msg || ('Escolha ' + (App.parental.LEN || 4) + ' dígitos para o controle parental.') })
      .then(function (p1) {
        if (p1 == null) return null;
        return pinPad({ title: 'Confirme a senha', msg: 'Digite a mesma senha outra vez.' }).then(function (p2) {
          if (p2 == null) return null;
          if (p2 === p1) return p1;
          return ui.alert('As senhas não conferem', 'Vamos começar de novo.').then(function () { return ui.pinNew(o); });
        });
      });
  };

  /* Menu vertical de opcoes -> Promise<indice|null>. */
  ui.menu = function (o) {
    return new Promise(function (res) {
      var ov = App.el('div', 'overlay'), m = App.el('div', 'modal glass-panel pin'), nodes = [], close;
      m.appendChild(App.el('h2', 'h2', o.title || ''));
      if (o.msg) m.appendChild(App.el('div', 'body-sm', o.msg));
      var list = App.el('div', 'menu-list');
      (o.options || []).forEach(function (opt, i) {
        var b = ui.btn(opt.label, 'menu-item ' + (opt.danger ? 'danger' : ''));
        b._act = function () { end(i); };
        list.appendChild(b); nodes.push(b);
      });
      m.appendChild(list); ov.appendChild(m);
      var grp = ui.group(nodes, false);
      function end(i) { close(); res(i == null ? null : i); }
      close = ui.open(ov, { key: function (a) { if (a === 'back') { end(null); return true; } grp.key(a); return true; } });
      if (nodes.length) grp.focus(0);
    });
  };
})(window);
