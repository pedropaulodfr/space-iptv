/* Teclas do controle remoto Samsung -> acoes. Pilha de camadas: so a do topo recebe as teclas. */
(function (g) {
  'use strict';
  var App = g.App;
  var MAP = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down',
    10009: 'back', 27: 'back', 8: 'back', 10182: 'exit',
    415: 'play', 19: 'pause', 10252: 'playpause', 413: 'stop', 417: 'ff', 412: 'rw',
    427: 'chup', 428: 'chdown', 457: 'info', 73: 'info',
    403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 89: 'yellow'
  };
  var HOLD_MS = 650, holdT = null, holdFired = false, okDown = false;
  var layers = [];

  function top() { return layers[layers.length - 1]; }
  function dispatch(action, ev) { var l = top(); return l && l.key ? l.key(action, ev) : false; }

  App.nav = {
    push: function (l) { layers.push(l); },
    pop: function (l) { var i = layers.indexOf(l); if (i >= 0) layers.splice(i, 1); },
    top: top,
    dispatch: dispatch
  };

  function editing() { var a = document.activeElement; return a && a.tagName === 'INPUT'; }

  document.addEventListener('keydown', function (e) {
    var c = e.keyCode, act;
    if (editing()) {
      /* teclado virtual aberto: so saimos com OK/Voltar/Cima/Baixo/Done/Cancelar */
      if (c === 13 || c === 10009 || c === 27 || c === 65376 || c === 65385) { document.activeElement.blur(); e.preventDefault(); return; }
      if (c === 38 || c === 40) { document.activeElement.blur(); e.preventDefault(); dispatch(MAP[c], e); }
      return;
    }
    if (c === 13) {
      e.preventDefault();
      if (e.repeat || okDown) return;
      okDown = true; holdFired = false;
      holdT = setTimeout(function () { holdT = null; holdFired = true; dispatch('hold', e); }, HOLD_MS);
      return;
    }
    act = MAP[c];
    if (!act) {
      /* teclas numericas do controle remoto viram acoes n0..n9 (teclado de senha) */
      if (c >= 48 && c <= 57) act = 'n' + (c - 48);
      else if (c >= 96 && c <= 105) act = 'n' + (c - 96);
    }
    if (!act) return;
    e.preventDefault();
    dispatch(act, e);
  }, true);

  document.addEventListener('keyup', function (e) {
    if (e.keyCode !== 13) return;
    if (!okDown) return;
    okDown = false;
    if (holdT) { clearTimeout(holdT); holdT = null; if (!editing()) dispatch('ok', e); }
  }, true);

  /* teclas de midia precisam ser registradas na Tizen */
  App.registerKeys = function () {
    try {
      var names = ['MediaPlay', 'MediaPause', 'MediaStop', 'MediaPlayPause', 'MediaFastForward', 'MediaRewind', 'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info', 'Exit',
        /* numericas: atalho dos 9 primeiros canais favoritos (e teclado da senha) */
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
      names.forEach(function (n) { try { g.tizen.tvinputdevice.registerKey(n); } catch (e) { /* tecla nao suportada */ } });
    } catch (e) { /* fora da TV */ }
  };
})(window);
