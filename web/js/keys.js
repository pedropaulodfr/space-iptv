/* Teclado da versão web: App.nav (pilha de camadas) + mapeamento das teclas do navegador
   para as ações do controle. Substitui tv/js/navigation/keys.js — não carregue aquele arquivo. */
(function (g) {
  'use strict';
  var App = g.App;
  var HOLD_MS = 650;
  var layers = [];
  var holdT = null, holdFired = false, okDown = false;

  function top() { return layers[layers.length - 1]; }
  /* só a camada do topo recebe a ação (igual à TV) */
  function dispatch(action, ev) { var l = top(); return l && l.key ? l.key(action, ev) : false; }

  App.nav = {
    push: function (l) { layers.push(l); },
    pop: function (l) { var i = layers.indexOf(l); if (i >= 0) layers.splice(i, 1); },
    top: top,
    dispatch: dispatch
  };

  /* A web não tem controle remoto: o main.js da TV não é carregado, mas a função existe
     para que qualquer código chamado por engano não quebre. */
  App.registerKeys = function () { /* sem registro de teclas na web */ };

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var t = el.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
    return el.isContentEditable === true;
  }
  function isNativeControl(el) {
    if (!el || el.nodeType !== 1) return false;
    var t = el.tagName;
    return t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || t === 'LABEL';
  }
  function fullscreenEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function overlaysOpen() { var o = document.getElementById('overlays'); return !!(o && o.children.length); }
  function playerOpen() { var p = document.getElementById('player'); return !!(p && p.classList.contains('open')); }

  /* Modal no topo: usado no Enter dentro de um campo para acionar "Salvar" (uiform). */
  function modalPrimary() {
    var mods = document.querySelectorAll('#overlays .modal'), m, b;
    if (!mods.length) return null;
    m = mods[mods.length - 1];
    if (!m.getClientRects().length) return null;      /* invisível (ex.: player na frente) */
    b = m.querySelector('.btn.primary');
    return b && typeof b._act === 'function' ? b : null;
  }

  function help() {
    App.ui.alert('Controles do teclado',
      '◀▶▲▼  navegar\n' +
      'Enter  selecionar (segure para favoritar)\n' +
      'Esc / Backspace  voltar\n' +
      'Espaço  play/pausa (no player)\n' +
      'PageUp / PageDown  canal anterior / próximo\n' +
      'F  favoritar • X  troca rápida • I  informações\n' +
      '0–9  favoritos • M  mudo (no player) • Home  início\n' +
      '⛶  tela cheia (Esc sai)');
  }

  /* Mapeamento tecla física -> ação. Devolve null quando a tecla não é do app. */
  function actionOf(k, c) {
    if (k === 'ArrowLeft' || c === 37) return 'left';
    if (k === 'ArrowUp' || c === 38) return 'up';
    if (k === 'ArrowRight' || c === 39) return 'right';
    if (k === 'ArrowDown' || c === 40) return 'down';
    if (k === 'Escape' || c === 27) return 'back';
    if (k === 'Backspace' || c === 8) return 'back';
    if (k === ' ' || k === 'Spacebar' || c === 32) return 'playpause';
    if (k === 'PageUp' || c === 33) return 'chup';
    if (k === 'PageDown' || c === 34) return 'chdown';
    if (k === 'f' || k === 'F' || c === 70) return 'yellow';
    if (k === 'x' || k === 'X' || c === 88) return 'blue';
    if (k === 'i' || k === 'I' || c === 73) return 'info';
    if (k === 'm' || k === 'M' || c === 77) return 'mute';
    if (k === 'Home' || c === 36) return 'home';
    if (k === '?') return 'help';
    if (c >= 48 && c <= 57) return 'n' + (c - 48);
    if (c >= 96 && c <= 105) return 'n' + (c - 96);
    return null;
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;     /* deixa os atalhos do navegador */
    var t = e.target || document.activeElement;
    var k = e.key || '', c = e.keyCode || e.which || 0;
    var act;

    /* Em tela cheia o Esc é do navegador: sai da tela cheia sem também fechar o player. */
    if (k === 'Escape' || c === 27) {
      if (fullscreenEl()) {
        try {
          if (document.exitFullscreen) document.exitFullscreen();
          else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } catch (e) { /* sem tela cheia */ }
        return;
      }
    }

    /* ---------- dentro de campo de texto: só as exceções do contrato ---------- */
    if (isEditable(t)) {
      if (k === 'Escape' || c === 27) { e.preventDefault(); t.blur(); dispatch('back', e); return; }
      if (k === 'ArrowUp' || c === 38) { e.preventDefault(); t.blur(); dispatch('up', e); return; }
      if (k === 'ArrowDown' || c === 40) { e.preventDefault(); t.blur(); dispatch('down', e); return; }
      if (k === 'Enter' || c === 13) {
        e.preventDefault();
        var primary = modalPrimary();
        if (primary) { primary._act(); return; }
        t.blur(); dispatch('down', e);
        return;
      }
      return;   /* letras, números, setas horizontais, Backspace e Tab ficam com o campo */
    }

    /* botões e links nativos (ex.: botão de tela cheia) mantêm Enter/Espaço nativos */
    if (isNativeControl(t) && (k === 'Enter' || c === 13 || k === ' ' || c === 32)) return;

    /* ---------- Enter: ok no keyup; segurar 650 ms dispara hold ---------- */
    if (k === 'Enter' || c === 13) {
      e.preventDefault();
      if (e.repeat || okDown) return;
      okDown = true; holdFired = false;
      holdT = setTimeout(function () {
        holdT = null; holdFired = true;
        dispatch('hold', e);
      }, HOLD_MS);
      return;
    }

    act = actionOf(k, c);
    if (!act) return;

    /* eventos repetidos: só navegação pode repetir */
    var nav = act === 'left' || act === 'up' || act === 'right' || act === 'down' || act === 'chup' || act === 'chdown';
    if (e.repeat && !nav) return;

    if (act === 'home') {
      if (overlaysOpen() || playerOpen()) return;
      e.preventDefault();
      if (App.shell && App.shell.goto) App.shell.goto('home');
      return;
    }
    if (act === 'help') {
      e.preventDefault();
      if (overlaysOpen() || playerOpen()) return;
      help();
      return;
    }
    if (act === 'mute') {
      e.preventDefault();
      if (!dispatch('mute', e) && App.player && typeof App.player.toggleMute === 'function') App.player.toggleMute();
      return;
    }

    e.preventDefault();
    dispatch(act, e);
  }, true);

  document.addEventListener('keyup', function (e) {
    var c = e.keyCode || e.which || 0;
    if (c !== 13 && e.key !== 'Enter') return;
    if (!okDown) return;
    okDown = false;
    if (holdT) {
      clearTimeout(holdT); holdT = null;
      if (!isEditable(document.activeElement)) dispatch('ok', e);
    }
  }, true);

  /* Perder o foco da janela não pode deixar o Enter "preso" (hold fantasma). */
  g.addEventListener('blur', function () {
    if (holdT) { clearTimeout(holdT); holdT = null; }
    okDown = false; holdFired = false;
  });
})(window);
