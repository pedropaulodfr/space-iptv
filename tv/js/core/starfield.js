/* Fundo espacial: estrelas cintilantes em canvas (leve: ~90 particulas, ~20 fps, pausa no player) */
(function (g) {
  'use strict';
  var App = g.App, cv = document.getElementById('stars'), ctx = cv.getContext('2d'), stars = [], N = 90, t = null;
  cv.width = 1920; cv.height = 1080;
  var i;
  for (i = 0; i < N; i++) stars.push({ x: Math.random() * 1920, y: Math.random() * 1080, r: 0.2 + Math.random() * 1.8, p: Math.random() * 6.28, v: 0.3 + Math.random() * 1.6 });

  function frame() {
    t = null;
    if (document.hidden || document.body.classList.contains('playing')) return schedule(500);
    ctx.clearRect(0, 0, 1920, 1080);
    var now = Date.now() / 1000, k, s, a;
    for (k = 0; k < N; k++) {
      s = stars[k]; a = 0.5 + 0.5 * Math.sin(s.p + now * s.v);
      ctx.globalAlpha = a; ctx.fillStyle = k % 7 === 0 ? '#8257E5' : (k % 5 === 0 ? '#4285FF' : '#F5F7FF');
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.2832); ctx.fill();
    }
    schedule(50);
  }
  function schedule(ms) { if (!t) t = setTimeout(frame, ms); }
  App.starfield = { start: function () { schedule(0); } };
})(window);
