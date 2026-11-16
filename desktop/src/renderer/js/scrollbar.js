/* Barra de rolagem das listas virtualizadas (desktop).
 *
 * As listas do app são navegadas por foco (setas/roda) e o container tem
 * `overflow:hidden`; não existe scrollbar nativa. Este módulo adiciona uma
 * barra própria em cada `.vlist` dentro de `#screen` (grade de filmes/séries,
 * categorias, listas de configurações): mostra a posição, permite arrastar o
 * polegar e clicar na trilha.
 *
 * Não reimplementa a lista: usa `root.__vl` (instância exposta pela ponte de
 * ponteiro) para chamar `render()` depois de mudar `scrollTop`, e mantém o
 * índice de foco na primeira linha visível para o teclado continuar dali.
 */
(function (g) {
  'use strict';
  var App = g.App;
  if (!App || !App.isDesktop) return;

  var THUMB_MIN = 32;
  var attached = 0;
  var activeDrag = null;

  /* arrasto em andamento: um único conjunto de listeners no document */
  function onDragMove(e) {
    if (!activeDrag) return;
    var d = activeDrag.drag;
    var ch = activeDrag.root.clientHeight;
    var maxTop = Math.max(1, ch - d.h);
    var next = d.top + (e.clientY - d.y);
    next = Math.max(0, Math.min(maxTop, next));
    activeDrag.scrollToRatio(next / maxTop);
    e.preventDefault();
    e.stopPropagation();
  }
  function onDragEnd() {
    if (!activeDrag) return;
    try { activeDrag.bar.classList.remove('drag'); } catch (err) { /* ignore */ }
    try { activeDrag.thumb.removeAttribute('data-drag'); } catch (err) { /* ignore */ }
    activeDrag = null;
  }
  document.addEventListener('pointermove', onDragMove, true);
  document.addEventListener('pointerup', onDragEnd, true);
  document.addEventListener('pointercancel', onDragEnd, true);

  function init(root) {
    if (!root || root.__sbar) return;
    var vl = root.__vl;
    if (!vl || !vl.items) return;
    var parent = root.parentElement;
    if (!parent) return;
    if (!parent.classList.contains('has-vl-scroll')) parent.classList.add('has-vl-scroll');

    var bar = document.createElement('div');
    bar.className = 'vl-scroll';
    var thumb = document.createElement('div');
    thumb.className = 'vl-scrollthumb';
    thumb.setAttribute('role', 'scrollbar');
    thumb.setAttribute('aria-orientation', 'vertical');
    thumb.setAttribute('aria-label', 'Rolar a lista');
    thumb.setAttribute('aria-valuemin', '0');
    thumb.setAttribute('tabindex', '-1');
    thumb.title = 'Arraste para rolar';
    bar.appendChild(thumb);
    parent.appendChild(bar);
    if (!root.id) root.id = 'vl-list-' + (++attached);
    thumb.setAttribute('aria-controls', root.id);
    root.__sbar = { bar: bar, thumb: thumb, vl: vl };
    attached++;

    function visible() {
      var sh = root.scrollHeight, ch = root.clientHeight;
      return sh > ch + 2 && ch > 40;
    }
    function layout() {
      if (!root.isConnected) { destroy(); return; }
      bar.style.top = (root.offsetTop || 0) + 'px';
      bar.style.height = (root.clientHeight || 0) + 'px';
      if (!visible()) {
        bar.classList.remove('on');
        thumb.setAttribute('aria-hidden', 'true');
        thumb.setAttribute('tabindex', '-1');
        return;
      }
      bar.classList.add('on');
      thumb.setAttribute('aria-hidden', 'false');
      thumb.setAttribute('tabindex', '0');
      var sh = root.scrollHeight, ch = root.clientHeight;
      var maxTop = ch - Math.max(THUMB_MIN, Math.round(ch * ch / sh));
      var thumbH = Math.max(THUMB_MIN, Math.round(ch * ch / sh));
      var ratio = sh > ch ? root.scrollTop / (sh - ch) : 0;
      ratio = Math.max(0, Math.min(1, ratio));
      thumb.style.height = thumbH + 'px';
      thumb.style.top = Math.round(ratio * maxTop) + 'px';
      /* ARIA: anuncia a posição para leitores de tela */
      var pct = Math.round(ratio * 100);
      thumb.setAttribute('aria-valuemax', String(Math.round(sh - ch)));
      thumb.setAttribute('aria-valuenow', String(Math.round(root.scrollTop)));
      thumb.setAttribute('aria-valuetext', pct + '% da lista');
    }
    function rerender() {
      if (vl && typeof vl.render === 'function') vl.render();
      layout();
    }
    function syncIdx() {
      if (!vl || !vl.items || !vl.items.length) return;
      var row = Math.floor((root.scrollTop || 0) / (vl.rowH || 1));
      var i = Math.max(0, Math.min(vl.items.length - 1, row * (vl.cols || 1)));
      if (i !== vl.idx) {
        vl.idx = i;
        vl.render();
        if (vl.has) vl.mark(vl.cellOf(i), true);
      }
    }
    function scrollToRatio(ratio) {
      var sh = root.scrollHeight, ch = root.clientHeight;
      root.scrollTop = Math.max(0, Math.min(sh - ch, Math.round(ratio * (sh - ch))));
      syncIdx();
      rerender();
    }
    function scrollByRows(rows) {
      var rowH = (vl && vl.rowH) || 80;
      var sh = root.scrollHeight, ch = root.clientHeight;
      var target = Math.max(0, Math.min(sh - ch, root.scrollTop + rows * rowH));
      root.scrollTop = target;
      syncIdx();
      rerender();
    }
    /* teclado: a barra é focável (Tab) e rola com setas/PgUp/PgDn/Home/End */
    thumb.addEventListener('keydown', function (e) {
      var pageRows = Math.max(1, Math.floor(root.clientHeight / ((vl && vl.rowH) || 80)) - 1);
      var handled = true;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') scrollByRows(1);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') scrollByRows(-1);
      else if (e.key === 'PageDown') scrollByRows(pageRows);
      else if (e.key === 'PageUp') scrollByRows(-pageRows);
      else if (e.key === 'Home') scrollToRatio(0);
      else if (e.key === 'End') scrollToRatio(1);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    });

    /* arrastar o polegar: listeners no document (pointer capture pode falhar em
       entradas sintéticas/sem foco; no document o arrasto funciona sempre) */
    var drag = null;
    thumb.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      drag = { y: e.clientY, top: parseFloat(thumb.style.top) || 0, h: parseFloat(thumb.style.height) || THUMB_MIN };
      activeDrag = { self: bar, root: root, thumb: thumb, bar: bar, drag: drag, scrollToRatio: scrollToRatio };
      bar.classList.add('drag');
      thumb.setAttribute('data-drag', '1');
      e.preventDefault();
      e.stopPropagation();
    }, true);

    /* clique na trilha = rolar uma "página" proporcional ao ponto clicado */
    bar.addEventListener('pointerdown', function (e) {
      if (e.target !== bar) return;
      var rect = bar.getBoundingClientRect();
      var frac = (e.clientY - rect.top) / Math.max(1, rect.height);
      scrollToRatio(Math.max(0, Math.min(1, frac)));
      e.preventDefault();
      e.stopPropagation();
    }, true);
    /* a ponte de ponteiro não deve tratar a barra como card/lista */
    bar.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); }, true);

    root.addEventListener('scroll', layout, { passive: true });
    if (typeof g.ResizeObserver === 'function') {
      try { new g.ResizeObserver(layout).observe(root); } catch (err) { /* ignore */ }
    }
    if (typeof g.MutationObserver === 'function') {
      try { new g.MutationObserver(layout).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] }); } catch (err) { /* ignore */ }
    }
    layout();

    function destroy() {
      try { parent.removeChild(bar); } catch (err) { /* ignore */ }
      try { delete root.__sbar; } catch (err) { root.__sbar = null; }
      attached--;
    }
  }

  function scan() {
    var list = document.querySelectorAll('#screen .vlist');
    for (var i = 0; i < list.length; i++) init(list[i]);
  }

  if (typeof g.MutationObserver === 'function') {
    try {
      new g.MutationObserver(function () {
        if (attached > 0) {
          var bars = document.querySelectorAll('#screen .vl-scroll');
          for (var b = 0; b < bars.length; b++) {
            var rootEl = bars[b].parentElement && bars[b].parentElement.querySelector('.vlist');
            if (!rootEl || !rootEl.isConnected || !rootEl.__vl) { try { bars[b].remove(); } catch (e) { /* ignore */ } }
          }
        }
        scan();
      }).observe(document.body, { childList: true, subtree: true });
    } catch (err) { /* ignore */ }
  }
  document.addEventListener('DOMContentLoaded', scan);
  if (document.readyState !== 'loading') scan();

  App.scrollbars = { scan: scan, count: function () { return attached; } };
})(window);
