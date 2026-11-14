/* Ponte de ponteiro (mouse, roda e toque) para um app navegado por índice.
   O app não escuta cliques: a tela certa é escolhida movendo o foco e depois despachando
   a ação (`ok`, `hold`) pela pilha de camadas. Nada de tv/js é alterado: as instâncias de
   VList/HRow são registradas nos próprios nós (`root.__vl`, `el.__hrow`). */
(function (g) {
  'use strict';
  var App = g.App;

  /* ---------- 1. ganchos nas listas (embrulho dos construtores, sem tocar em tv/js) ---------- */
  var VList0 = App.VList, HRow0 = App.HRow;
  if (typeof VList0 === 'function') {
    var VListW = function (o) { if (o && o.root) o.root.__vl = this; VList0.call(this, o); };
    VListW.prototype = VList0.prototype;
    App.VList = VListW;
  }
  if (typeof HRow0 === 'function') {
    var HRowW = function (o) { HRow0.call(this, o); if (this.el) this.el.__hrow = this; };
    HRowW.prototype = HRow0.prototype;
    App.HRow = HRowW;
  }

  var HOLD_MS = 650, WHEEL_MS = 90, CURSOR_MS = 2500;
  var hoverMQ = g.matchMedia ? g.matchMedia('(hover: hover) and (pointer: fine)') : null;
  function hoverFine() { return hoverMQ ? hoverMQ.matches : true; }

  /* ---------- 2. escopo: player > modais > palco ---------- */
  function playerEl() { var p = document.getElementById('player'); return p && p.classList.contains('open') ? p : null; }
  function overlaysEl() { var o = document.getElementById('overlays'); return o && o.children.length ? o : null; }
  function scopeEl() { return playerEl() || overlaysEl() || document.getElementById('stage') || document.body; }
  function inside(sc, el) { return !!(sc && el && (el === sc || (sc.contains && sc.contains(el)))); }

  /* ---------- 3. resolução do alvo -> ação indexada ---------- */
  function listIndexOf(row, cell) { return Array.prototype.indexOf.call(row.children, cell); }

  function resolve(el, sc) {
    if (!el) return null;
    if (el.nodeType !== 1) el = el.parentElement;
    if (!inside(sc, el)) return null;

    var n, cell, row, root, inst, col, idx, hcard, sec, hr, ni, navs;

    /* teclas do PIN: cada tecla sabe se pressionar (gancho _press do ui.js) */
    n = el.closest ? el.closest('.pin-key') : null;
    if (n && inside(sc, n)) return { kind: 'pin', node: n };

    /* campo de formulário/busca: clique foca o input (nada de _act) */
    n = el.closest ? el.closest('.field') : null;
    if (n && inside(sc, n)) return { kind: 'field', node: n };

    /* células de lista virtualizada */
    cell = el.closest ? el.closest('.vl-cell') : null;
    if (cell && inside(sc, cell)) {
      row = cell.parentElement;
      root = cell.closest('.vlist');
      inst = root && root.__vl;
      if (inst && row && row.style && row.style.top) {
        col = listIndexOf(row, cell);
        idx = Math.round(parseFloat(row.style.top || '0') / (inst.rowH || 1)) * inst.cols + col;
        if (idx >= 0 && idx < inst.items.length) return { kind: 'vlist', inst: inst, idx: idx, cell: cell };
      }
    }

    /* cartões das faixas horizontais (Home) */
    hcard = el.closest ? el.closest('.hr-card') : null;
    if (hcard && inside(sc, hcard)) {
      sec = hcard.closest('.hrow');
      hr = sec && sec.__hrow;
      if (hr) {
        idx = hr.cards.indexOf(hcard);
        if (idx >= 0) return { kind: 'hrow', inst: hr, idx: idx, card: hcard };
      }
    }

    /* menu lateral */
    navs = null;
    for (n = el; n && n !== sc; n = n.parentElement) {
      if (n.classList && n.classList.contains('nav-item')) {
        navs = document.querySelectorAll('#sidebar .nav-item');
        ni = Array.prototype.indexOf.call(navs, n);
        if (ni >= 0) return { kind: 'menu', idx: ni, node: n };
        break;
      }
    }

    /* botões e itens acionáveis por _act/_press (modais, chips, configurações, detalhes) */
    for (n = el; n && n !== sc; n = n.parentElement) {
      if (typeof n._press === 'function') return { kind: 'press', node: n };
      if (typeof n._act === 'function') return { kind: 'act', node: n };
      if (n.classList && n.classList.contains('btn')) return { kind: 'focusable', node: n };
    }
    return null;
  }

  /* ---------- 4. foco programático (anda com ações para respeitar a tela) ---------- */
  function visibleFocus(sc) {
    var els = sc.querySelectorAll('.focused'), i, el;
    for (i = els.length - 1; i >= 0; i--) {
      el = els[i];
      if (el.getClientRects().length) return el;
    }
    return null;
  }
  function directionTo(a, b) {
    if (!a || !b) return null;
    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    if (!ra.width && !ra.height) return null;
    var dx = (rb.left + rb.width / 2) - (ra.left + ra.width / 2);
    var dy = (rb.top + rb.height / 2) - (ra.top + ra.height / 2);
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return null;
    return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  }
  function walkTo(pred, target, sc, max) {
    max = max || 6;
    for (var i = 0; i < max; i++) {
      if (pred()) return true;
      var dir = directionTo(visibleFocus(sc), target);
      if (!dir) return false;
      App.nav.dispatch(dir);
    }
    return pred();
  }

  /* se nada nesta camada está com foco (ex.: menu lateral), entra na tela antes de andar */
  function ensureSomeFocus(sc) {
    if (visibleFocus(sc)) return true;
    if (sc && sc.id === 'stage') return !!shellCall('hoverScreen');
    return false;
  }

  /* foca a lista/faixa sem mudar o índice (usado pela roda: foca e depois navega) */
  function focusList(d) {
    if (!d) return false;
    var sc = scopeEl();
    if (d.kind === 'vlist') {
      if (!d.inst.has && ensureSomeFocus(sc)) walkTo(function () { return d.inst.has; }, d.cell.firstElementChild || d.cell, sc);
      return d.inst.has;
    }
    if (d.kind === 'hrow') {
      if (!d.inst.has && ensureSomeFocus(sc)) walkTo(function () { return d.inst.has; }, d.card, sc);
      return d.inst.has;
    }
    return false;
  }

  function applyFocus(d) {
    if (!d) return false;
    var sc = scopeEl();
    if (d.kind === 'vlist') {
      if (!d.inst.has && ensureSomeFocus(sc)) walkTo(function () { return d.inst.has; }, d.cell.firstElementChild || d.cell, sc);
      if (d.inst.has) d.inst.setIdx(d.idx);
      return d.inst.has;
    }
    if (d.kind === 'hrow') {
      if (!d.inst.has && ensureSomeFocus(sc)) walkTo(function () { return d.inst.has; }, d.card, sc);
      if (d.inst.has) d.inst.setIdx(d.idx, true);
      return d.inst.has;
    }
    if (d.kind === 'menu') { shellCall('hoverMenu', d.idx); return true; }
    if (d.kind === 'focusable' || d.kind === 'pin') {
      if (!ensureSomeFocus(sc)) return false;
      return walkTo(function () { return d.node.classList.contains('focused'); }, d.node, sc);
    }
    return false;
  }

  /* ---------- 5. ativação ---------- */
  function activate(d) {
    if (!d) return false;
    var ok = false;
    if (d.kind === 'act') { d.node._act(); ok = true; }
    else if (d.kind === 'pin') { applyFocus(d); d.node._press(); ok = true; }
    else if (d.kind === 'press') { applyFocus(d); d.node._press(); ok = true; }
    else if (d.kind === 'field') {
      var inp = d.node.querySelector('input, textarea');
      if (inp) { inp.focus(); ok = true; }
    }
    else if (d.kind === 'menu') {
      shellCall('hoverMenu', d.idx);
      App.nav.dispatch('ok');
      ok = true;
    }
    else if (d.kind === 'vlist') {
      applyFocus(d);
      d.inst.setIdx(d.idx);
      /* categorias e a lista de listas são "só seleção": clicar escolhe a categoria/lista,
         sem pular o foco para a grade (isso continua sendo o OK/→ do teclado). */
      if (d.cell.closest('.cats, .lists-pane')) ok = true;
      else if (d.inst.has) { App.nav.dispatch('ok'); ok = true; }
      else if (d.inst.o && typeof d.inst.o.onSelect === 'function') { d.inst.o.onSelect(d.inst.items[d.idx], d.idx); ok = true; }
      else ok = true;
    }
    else if (d.kind === 'hrow') {
      applyFocus(d);
      d.inst.setIdx(d.idx, true);
      if (d.inst.has) App.nav.dispatch('ok');
      else if (d.inst.o && typeof d.inst.o.onSelect === 'function') d.inst.o.onSelect(d.inst.items[d.idx], d.idx);
      ok = true;
    }
    else if (d.kind === 'focusable') { applyFocus(d); App.nav.dispatch('ok'); ok = true; }
    afterProgrammatic();
    return ok;
  }

  function shellCall(name, arg) {
    if (App.shell && typeof App.shell[name] === 'function') return App.shell[name](arg);
    return false;
  }

  /* ---------- 6. cursor ---------- */
  var cursorT = null;
  function hideCursorNow() { document.documentElement.classList.add('hide-cursor'); }
  function showCursor() {
    document.documentElement.classList.remove('hide-cursor');
    clearTimeout(cursorT);
    if (hoverFine()) cursorT = setTimeout(hideCursorNow, CURSOR_MS);
  }

  /* ---------- 7. anti-foco-fantasma: só há hover com pointermove de verdade ---------- */
  var hoverRaf = 0, hoverPt = null, lastHoverEl = null;
  function afterProgrammatic() { lastHoverEl = null; }

  /* ---------- 8. hover ---------- */
  function onHover(d) {
    if (!d) return;
    if (d.kind === 'menu') { shellCall('hoverMenu', d.idx); afterProgrammatic(); return; }
    if (d.kind === 'vlist' || d.kind === 'hrow') { applyFocus(d); afterProgrammatic(); return; }
    /* botões/campos: o realce de :hover do web.css dá o feedback; o clique ativa */
  }

  /* Resolve o alvo pela posição do ponteiro (elementFromPoint) em vez de pointerover:
     assim o hover só acontece em movimento real — nunca quando a lista se desloca sozinha. */
  function doHover() {
    hoverRaf = 0;
    if (!hoverPt || !hoverFine()) return;
    var sc = scopeEl();
    var el = document.elementFromPoint(hoverPt.x, hoverPt.y);
    if (!el || !inside(sc, el)) return;
    var d = resolve(el, sc);
    if (d) {
      /* alvo dentro da tela com o menu em foco: primeiro volta o foco para a tela */
      var screEl = document.getElementById('screen');
      if (App.shell && typeof App.shell.inScreen === 'function' && !App.shell.inScreen() && inside(screEl, el)) shellCall('hoverScreen');
      var anchor = d.cell || d.card || d.node;
      if (anchor === lastHoverEl) return;
      lastHoverEl = anchor;
      onHover(d);
      return;
    }
    lastHoverEl = null;
    /* ponteiro de volta na área da tela: sai do modo menu (foco reaparece) */
    if (sc === document.getElementById('stage') && inside(document.getElementById('screen'), el)) shellCall('hoverScreen');
  }

  document.addEventListener('pointermove', function (e) {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    showCursor();
    hoverPt = { x: e.clientX, y: e.clientY };
    if (!hoverRaf) hoverRaf = requestAnimationFrame(doHover);
  }, { passive: true });

  /* ---------- 9. clique (mouse) ---------- */
  var suppressClickUntil = 0;
  document.addEventListener('click', function (e) {
    if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.detail === 0) return;                 /* clique sintético de teclado */
    var t = e.target;
    if (!t || t.nodeType !== 1) return;
    if (isNative(t)) return;                    /* <button>, <a>, input: comportamento nativo */
    var sc = scopeEl();
    if (!inside(sc, t)) return;
    var d = resolve(t, sc);
    if (!d) return;
    if (activate(d)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  function isNative(el) {
    var t = el.tagName;
    return t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
  }
  function isTextEntry(el) {
    var t = el && el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || (el && el.isContentEditable === true);
  }

  /* ---------- 10. toque e pressionar-e-segurar (mouse e toque) ---------- */
  var press = null, recentHold = 0;
  function startHold(d, pt, isMouse) {
    press = { d: d, x: pt.clientX, y: pt.clientY, t: Date.now(), fired: false, mouse: isMouse };
    press.timer = setTimeout(function () {
      if (!press) return;
      press.fired = true;
      recentHold = Date.now();
      if (isMouse) applyFocus(d);
      dispatchHold();
      suppressClickUntil = Date.now() + 800;
      afterProgrammatic();
    }, HOLD_MS);
  }
  function dispatchHold() {
    if (App.nav && App.nav.dispatch) App.nav.dispatch('hold');
  }

  document.addEventListener('pointerdown', function (e) {
    showCursor();
    if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return;
    var t = e.target;
    if (!t || t.nodeType !== 1 || isNative(t) || isTextEntry(t)) return;
    var sc = scopeEl();
    if (!inside(sc, t)) return;
    var d = resolve(t, sc);
    if (!d) return;
    /* segurar só faz sentido em item de lista (favoritar); em botão não dispara nada */
    if (d.kind !== 'vlist' && d.kind !== 'hrow' && d.kind !== 'menu') return;
    /* toque: o primeiro toque já move o foco, como passar o mouse */
    if (e.pointerType !== 'mouse') applyFocus(d);
    startHold(d, e, e.pointerType === 'mouse');
  }, { passive: true });

  document.addEventListener('pointerup', function (e) {
    if (!press) return;
    clearTimeout(press.timer);
    var p = press; press = null;
    if (p.fired) return;
    if (e.pointerType === 'mouse') return;      /* mouse: o clique normal ativa */
    var dist = Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y);
    if (dist < 14 && Date.now() - p.t < 900 && activate(p.d)) suppressClickUntil = Date.now() + 600;
  }, { passive: true });

  document.addEventListener('pointercancel', function () {
    if (press) { clearTimeout(press.timer); press = null; }
  }, { passive: true });

  /* menu de contexto: nativo no desktop (colar URL), bloqueado em toque e no player */
  document.addEventListener('contextmenu', function (e) {
    if (isTextEntry(e.target)) return;
    if (playerEl() || !hoverFine() || Date.now() - recentHold < 900) e.preventDefault();
  });

  /* ---------- 11. roda do mouse: navega em vez de rolar ---------- */
  var lastWheel = 0;
  function roving(node) {
    for (var n = node; n && n.nodeType === 1; n = n.parentElement) {
      if (n.id === 'sidebar' || (n.classList && (n.classList.contains('vlist') || n.classList.contains('hrow')))) return n;
    }
    return null;
  }
  document.addEventListener('wheel', function (e) {
    var sc = scopeEl();
    if (!inside(sc, e.target)) return;
    var area = roving(e.target);
    if (!area) return;
    e.preventDefault();                          /* lista virtual não rola nativamente */
    var now = Date.now();
    if (now - lastWheel < WHEEL_MS) return;      /* throttle ~90 ms */
    lastWheel = now;
    /* se a lista sob o ponteiro ainda não está com foco, entra nela antes de navegar */
    var d = resolve(e.target, sc);
    if (d && (d.kind === 'vlist' || d.kind === 'hrow') && !d.inst.has) focusList(d);
    var dir;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) dir = e.deltaX > 0 ? 'right' : 'left';
    else dir = e.deltaY > 0 ? 'down' : 'up';
    if (area.classList && area.classList.contains('hrow') && (dir === 'left' || dir === 'right')) {
      /* faixa horizontal: a própria tela entende left/right */
    } else if (dir === 'left' || dir === 'right') {
      dir = dir === 'left' ? 'up' : 'down';      /* lista vertical não usa horizontal */
    }
    if (area.id === 'sidebar') shellCall('hoverMenu', -1);   /* roda sobre o menu entra no menu */
    App.nav.dispatch(dir);
    afterProgrammatic();
  }, { passive: false });

  /* ---------- 12. teclado invalida o hover pendente; foco muda debaixo do ponteiro ---------- */
  document.addEventListener('keydown', function () { afterProgrammatic(); }, true);

  /* mídia muda de "hover fino": recalcula permissão e cursor */
  if (hoverMQ) {
    var onMQ = function () { if (!hoverFine()) document.documentElement.classList.remove('hide-cursor'); };
    if (hoverMQ.addEventListener) hoverMQ.addEventListener('change', onMQ);
    else if (hoverMQ.addListener) hoverMQ.addListener(onMQ);
  }

  showCursor();
  App.pointers = { scope: scopeEl, hideCursor: hideCursorNow };
})(window);
