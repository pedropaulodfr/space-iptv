/* Cards visuais (poster, canal) e carregamento de imagens com fallback */
(function (g) {
  'use strict';
  var App = g.App;
  var LABEL = { live: 'TV', movie: 'FILME', series: 'SÉRIE' };

  function okUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u); }
  function initials(n) {
    var w = String(n || '?').replace(/[^A-Za-z0-9À-ſ ]/g, ' ').split(/\s+/).filter(Boolean);
    return ((w[0] || '?').charAt(0) + (w[1] ? w[1].charAt(0) : '')).toUpperCase();
  }

  /* img com data-src carregada sob demanda; falha vira placeholder */
  function loadImg(img) {
    var u = img.getAttribute('data-src');
    if (!u || img.src) return;
    img.src = u;
  }
  function makeImg(url, lazy) {
    if (!okUrl(url)) return null;
    var img = document.createElement('img');
    img.decoding = 'async'; img.alt = '';
    try { img.referrerPolicy = 'no-referrer'; } catch (e) { /* ignore */ }
    img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
    img.setAttribute('data-src', url);
    if (!lazy) loadImg(img);
    return img;
  }

  App.cards = {
    loadImgs: function (root) { var l = root.querySelectorAll('img[data-src]'), i; for (i = 0; i < l.length; i++) loadImg(l[i]); },

    /* poster: filmes, series e (contain) logos de canais */
    poster: function (it, o) {
      o = o || {};
      var c = App.el('div', 'card poster'), box = App.el('div', 'pimg' + (it.t === 'live' ? ' contain' : ''));
      box.appendChild(App.el('div', 'ph', initials(it.n)));
      var img = makeImg(it.l, o.lazy); if (img) box.appendChild(img);
      if (o.tag) box.appendChild(App.el('div', 'tag', LABEL[it.t]));
      if (App.favs.has(it)) box.appendChild(App.el('div', 'favmark', '★'));
      var numFav = App.favs.num(it);
      if (numFav) box.appendChild(App.el('div', 'favnum', String(numFav)));
      if (o.progress != null) { var b = App.el('div', 'pbar'), i = App.el('i'); i.style.width = Math.round(App.clamp(o.progress, 0, 1) * 100) + '%'; b.appendChild(i); box.appendChild(b); }
      /* canal verificado aparece com o ponto tambem no poster (nao polui os nao verificados) */
      if (it.t === 'live' && App.health && App.health.enabled()) {
        var hrec = App.health.state(it);
        if (hrec && hrec.checkedAt) {
          var hp = App.el('div', 'hdot');
          hp.setAttribute('data-hkey', App.health.keyOf(it));
          App.health.paint(hp, it);
          box.appendChild(hp);
        }
      }
      c.appendChild(box);
      c.appendChild(App.el('div', 'ptitle', it.n));
      var sub = o.sub != null ? o.sub : [it.y, it.g].filter(Boolean).join(' • ');
      c.appendChild(App.el('div', 'psub', sub));
      return c;
    },

    /* linha de canal: logo + nome */
    channel: function (it, o) {
      o = o || {};
      var c = App.el('div', 'card chan'), lg = App.el('div', 'logo');
      lg.appendChild(App.el('div', 'ph', initials(it.n)));
      var img = makeImg(it.l, false); if (img) lg.appendChild(img);
      c.appendChild(lg);
      var inf = App.el('div', 'info');
      inf.appendChild(App.el('div', 'nm', it.n));
      if (o.sub) inf.appendChild(App.el('div', 'sb', o.sub));
      c.appendChild(inf);
      if (App.favs.has(it)) c.appendChild(App.el('span', 'fav', '★'));
      var numCanal = App.favs.num(it);
      if (numCanal) c.appendChild(App.el('span', 'favnum sm', String(numCanal)));
      /* saude do canal: ponto no canto do logo (dentro, por causa do overflow:hidden).
         Some quando o monitoramento esta desligado nas configuracoes. */
      if (it.t === 'live' && App.health && App.health.enabled()) {
        var hd = App.el('span', 'hdot');
        hd.setAttribute('data-hkey', App.health.keyOf(it));
        App.health.paint(hd, it);
        lg.appendChild(hd);
      }
      return c;
    },

    /* poster/linha conforme o tipo (busca e favoritos) */
    any: function (it, o) { return App.cards.poster(it, { tag: true, sub: o && o.sub }); }
  };
})(window);
