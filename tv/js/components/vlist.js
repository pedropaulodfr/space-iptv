/* Lista/grade virtualizada: so as linhas visiveis existem no DOM (memoria e CPU baixos).
   Navegacao por indice. handleKey devolve false quando o foco precisa sair da lista. */
(function (g) {
  'use strict';
  var App = g.App;

  function VList(o) {
    this.o = o; this.root = o.root; this.cols = o.cols || 1; this.rowH = o.rowH;
    this.items = []; this.idx = 0; this.rows = {}; this.has = false; this.nRows = 0;
    this.root.classList.add('vlist');
    this.inner = App.el('div', 'vl-inner');
    this.empty = App.el('div', 'vl-empty'); this.empty.style.display = 'none';
    this.root.appendChild(this.inner); this.root.appendChild(this.empty);
  }
  var P = VList.prototype;

  P.setItems = function (items, keep) {
    var oldIdx = this.idx;
    this.items = items || [];
    this.idx = keep ? App.clamp(oldIdx, 0, Math.max(0, this.items.length - 1)) : 0;
    this.clearRows();
    this.nRows = Math.ceil(this.items.length / this.cols);
    this.inner.style.height = (this.nRows * this.rowH) + 'px';
    this.root.scrollTop = 0;
    this.empty.style.display = this.items.length ? 'none' : 'block';
    if (!this.items.length) this.empty.textContent = this.o.empty || '';
    this.scrollTo(this.idx, true);
    this.render();
  };

  P.clearRows = function () { var r; for (r in this.rows) this.inner.removeChild(this.rows[r]); this.rows = {}; };

  P.render = function () {
    var vh = this.root.clientHeight || 800, st = this.root.scrollTop;
    var first = Math.max(0, Math.floor(st / this.rowH) - 1), last = Math.min(this.nRows - 1, Math.ceil((st + vh) / this.rowH) + 1), r;
    for (r in this.rows) if (+r < first || +r > last) { this.inner.removeChild(this.rows[r]); delete this.rows[r]; }
    for (r = first; r <= last; r++) if (!this.rows[r]) this.makeRow(r);
  };

  P.makeRow = function (r) {
    var row = App.el('div', 'vl-row'), c, i, cell, n = this.items.length;
    row.style.top = (r * this.rowH) + 'px'; row.style.height = this.rowH + 'px';
    row.style.gridTemplateColumns = 'repeat(' + this.cols + ',1fr)';
    for (c = 0; c < this.cols; c++) {
      i = r * this.cols + c;
      if (i >= n) break;
      cell = App.el('div', 'vl-cell'); cell.style.gridColumn = (c + 1);
      this.o.render(this.items[i], i, cell);
      if (this.has && i === this.idx) this.mark(cell, true);
      row.appendChild(cell);
    }
    this.inner.appendChild(row); this.rows[r] = row;
  };

  P.cellOf = function (i) {
    var row = this.rows[Math.floor(i / this.cols)];
    return row ? row.children[i % this.cols] : null;
  };
  P.mark = function (cell, on) {
    var t = cell && cell.firstChild;
    if (t) { if (on) t.classList.add('focused'); else t.classList.remove('focused'); }
  };
  P.refreshItem = function (i) {
    var cell = this.cellOf(i);
    if (!cell) return;
    App.clear(cell); this.o.render(this.items[i], i, cell);
    if (this.has && i === this.idx) this.mark(cell, true);
  };
  P.refreshAll = function () { var i; for (i in this.rows) { this.clearRows(); break; } this.render(); };

  /* mantem a linha em foco visivel, com uma linha de folga acima */
  P.scrollTo = function (i, instant) {
    var r = Math.floor(i / this.cols), top = r * this.rowH, vh = this.root.clientHeight || 800, st = this.root.scrollTop;
    if (top - this.rowH < st) st = Math.max(0, top - this.rowH);
    else if (top + this.rowH * 2 > st + vh) st = top + this.rowH * 2 - vh;
    if (st !== this.root.scrollTop) this.root.scrollTop = st;
  };

  P.setIdx = function (i) {
    if (i === this.idx && this.cellOf(i) && this.has) return;
    this.mark(this.cellOf(this.idx), false);
    this.idx = i;
    this.scrollTo(i); this.render();
    if (this.has) this.mark(this.cellOf(i), true);
    if (this.o.onFocus) this.o.onFocus(this.items[i], i);
  };

  P.focus = function () {
    if (!this.items.length) { this.has = false; return false; }
    this.has = true; this.scrollTo(this.idx); this.render(); this.mark(this.cellOf(this.idx), true);
    if (this.o.onFocus) this.o.onFocus(this.items[this.idx], this.idx);
    return true;
  };
  P.blur = function () { this.has = false; this.mark(this.cellOf(this.idx), false); };
  P.current = function () { return this.items[this.idx] || null; };

  P.key = function (a) {
    var n = this.items.length, i = this.idx, cols = this.cols;
    if (!n) return false;
    if (a === 'up') { if (i - cols >= 0) { this.setIdx(i - cols); return true; } return false; }
    if (a === 'down') {
      if (i + cols < n) { this.setIdx(i + cols); return true; }
      if (Math.floor(i / cols) < this.nRows - 1) { this.setIdx(n - 1); return true; }
      return false;
    }
    if (a === 'left') { if (i % cols > 0) { this.setIdx(i - 1); return true; } return false; }
    if (a === 'right') { if (i % cols < cols - 1 && i + 1 < n) { this.setIdx(i + 1); return true; } return false; }
    if (a === 'ok') { if (this.o.onSelect) this.o.onSelect(this.items[i], i); return true; }
    if (a === 'hold' || a === 'yellow') { if (this.o.onHold) { this.o.onHold(this.items[i], i); return true; } }
    return false;
  };
  P.destroy = function () { this.clearRows(); App.clear(this.root); this.root.classList.remove('vlist'); };

  App.VList = VList;
})(window);
