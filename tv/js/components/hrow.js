/* Faixa horizontal da Home: poucos itens, imagens carregadas so perto do foco */
(function (g) {
  'use strict';
  var App = g.App;

  function HRow(o) {
    this.o = o; this.items = o.items; this.idx = 0; this.off = 0; this.has = false;
    this.step = o.cardW + 24;
    this.el = App.el('section', 'hrow');
    this.el.appendChild(App.el('h2', 'h2', o.title));
    var view = App.el('div', 'hr-view'); this.track = App.el('div', 'hr-track');
    var self = this;
    this.cards = this.items.map(function (it, i) {
      var w = App.el('div', 'hr-card'); w.style.width = o.cardW + 'px'; w.style.height = o.cardH + 'px';
      w.appendChild(o.render(it, i)); self.track.appendChild(w); return w;
    });
    view.appendChild(this.track); this.el.appendChild(view);
    this.lazy(0);
  }
  var P = HRow.prototype;

  P.lazy = function (i) {
    var a = Math.max(0, i - 2), b = Math.min(this.cards.length - 1, i + 9), k;
    for (k = a; k <= b; k++) App.cards.loadImgs(this.cards[k]);
  };
  P.mark = function (on) { var c = this.cards[this.idx]; if (c && c.firstChild) c.firstChild.classList[on ? 'add' : 'remove']('focused'); };
  P.focus = function (i) {
    if (!this.cards.length) return false;
    this.has = true; this.setIdx(i == null ? this.idx : App.clamp(i, 0, this.cards.length - 1), true);
    return true;
  };
  P.blur = function () { this.has = false; this.mark(false); };
  P.setIdx = function (i, force) {
    if (i === this.idx && !force) return;
    this.mark(false); this.idx = i;
    var viewW = 1560, l = i * this.step, r = l + this.o.cardW + 24;
    if (l < this.off) this.off = l; else if (r > this.off + viewW - 24) this.off = r - viewW + 24;
    this.track.style.transform = 'translate3d(' + (-this.off) + 'px,0,0)';
    this.lazy(i);
    if (this.has) this.mark(true);
  };
  P.key = function (a) {
    if (a === 'left') { if (this.idx > 0) { this.setIdx(this.idx - 1); return true; } return false; }
    if (a === 'right') { if (this.idx < this.cards.length - 1) { this.setIdx(this.idx + 1); return true; } return true; }
    if (a === 'ok') { if (this.o.onSelect) this.o.onSelect(this.items[this.idx], this.idx); return true; }
    if (a === 'hold' || a === 'yellow') { if (this.o.onHold) { this.o.onHold(this.items[this.idx], this.idx); return true; } }
    return false;
  };
  P.refresh = function () {
    var w = this.cards[this.idx];
    if (!w) return;
    App.clear(w); w.appendChild(this.o.render(this.items[this.idx], this.idx)); App.cards.loadImgs(w);
    if (this.has) this.mark(true);
  };

  App.HRow = HRow;
})(window);
