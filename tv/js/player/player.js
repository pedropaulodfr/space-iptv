/* Player: AVPlay (Samsung) quando disponivel, HTML5 <video> como alternativa.
   Live: troca de canal, painel lateral, reconexao. VOD: seek, retomar de onde parou. */
(function (g) {
  'use strict';
  var App = g.App, S = null, built = false, E = {};
  var prevItem = null;   /* canal anterior da sessao: base da troca rapida (tecla AZUL) */
  var layer = { key: onKey };
  var UI_MS = 4000, SAVE_MS = 15000, PREP_MS = 25000;

  function av() { return g.webapis && g.webapis.avplay ? g.webapis.avplay : null; }

  function build() {
    if (built) return; built = true;
    var r = E.root = App.el('div'); r.id = 'player';
    E.vid = App.el('div'); r.appendChild(E.vid);
    var top = App.el('div', 'pl-top');
    E.badge = App.el('span', 'badge'); top.appendChild(App.el('div', 'hud-caption', '◀ VOLTAR   |   OK: controles'));
    top.appendChild(E.badge);
    E.title = App.el('div', 'pl-title'); E.sub = App.el('div', 'pl-sub');
    top.appendChild(E.title); top.appendChild(E.sub); r.appendChild(top);
    var sp = App.el('div', 'pl-spin'); sp.appendChild(App.el('div', 'spinner')); r.appendChild(sp);
    var msg = E.msg = App.el('div', 'pl-msg glass-panel');
    E.msgT = App.el('h2', 'h2'); E.msgB = App.el('div', 'msg'); E.msgH = App.el('div', 'hud-caption');
    msg.appendChild(E.msgT); msg.appendChild(E.msgB); msg.appendChild(E.msgH); r.appendChild(msg);
    var bot = App.el('div', 'pl-bottom');
    E.prog = App.el('div', 'pl-prog'); E.bar = App.el('i'); E.prog.appendChild(E.bar);
    var tm = App.el('div', 'pl-time'); E.cur = App.el('span'); E.dur = App.el('span'); tm.appendChild(E.cur); tm.appendChild(E.dur);
    E.keys = App.el('div', 'pl-keys');
    bot.appendChild(E.prog); bot.appendChild(tm); bot.appendChild(E.keys); r.appendChild(bot);
    var pn = E.panel = App.el('div', 'pl-panel glass-panel'); E.plist = App.el('div'); pn.appendChild(E.plist); r.appendChild(pn);
    document.body.appendChild(r);
    document.addEventListener('visibilitychange', onVisibility);
  }

  /* ---------- estado visual ---------- */
  function cls(name, on) { E.root.classList[on ? 'add' : 'remove'](name); }
  function busy(on) { cls('busy', on); }
  function showUI() {
    cls('ui', true); clearTimeout(S && S.uiT);
    if (!S) return;
    S.uiT = setTimeout(function () { if (S && !S.paused && !S.panel) cls('ui', false); }, UI_MS);
  }
  function showErr(title, body, hint) {
    busy(false); cls('err', true); E.msgT.textContent = title; E.msgB.textContent = body; E.msgH.textContent = hint || '';
  }
  function setTimes(pos, dur) {
    E.cur.textContent = S.live ? 'AO VIVO' : App.fmtTime(pos / 1000);
    E.dur.textContent = S.live || !dur ? '' : App.fmtTime(dur / 1000);
    E.bar.style.width = (!S.live && dur ? App.clamp(pos / dur * 100, 0, 100) : 0) + '%';
  }

  /* ---------- engine ---------- */
  function stopEngine() {
    var a = av();
    clearTimeout(S.prepT);
    if (S.engine === 'avplay' && a) {
      try { a.stop(); } catch (e) { /* ja parado */ }
      try { a.close(); } catch (e2) { /* ja fechado */ }
    } else if (S.video) {
      try { S.video.pause(); S.video.removeAttribute('src'); S.video.load(); } catch (e3) { /* ignore */ }
      if (S.video.parentNode) S.video.parentNode.removeChild(S.video);
      S.video = null;
    }
  }

  function startEngine() {
    var url = S.urls[S.urlIdx], tok = ++S.tok, a = av();
    S.pos = 0; S.dur = 0; S.paused = false; cls('err', false); busy(true);
    App.log('player: abrindo', url);
    S.engine = a ? 'avplay' : 'html5';
    if (S.engine === 'avplay') {
      try {
        try { a.close(); } catch (e0) { /* nada aberto */ }
        a.open(url);
        a.setDisplayRect(0, 0, 1920, 1080);
        try { a.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e1) { /* opcional */ }
        a.setListener({
          onbufferingstart: function () { if (tok === S.tok) busy(true); },
          onbufferingcomplete: function () { if (tok === S.tok) busy(false); },
          oncurrentplaytime: function (ms) { if (tok === S.tok) tick(ms); },
          onevent: function () { },
          onerror: function (type) { if (tok === S.tok) onFail(type); },
          onstreamcompleted: function () { if (tok === S.tok) onEnded(); }
        });
        S.prepT = setTimeout(function () { if (tok === S.tok) onFail('TIMEOUT'); }, PREP_MS);
        a.prepareAsync(function () {
          if (tok !== S.tok) return;
          clearTimeout(S.prepT);
          try { S.dur = S.live ? 0 : a.getDuration(); } catch (e) { S.dur = 0; }
          if (S.startAt > 5 && !S.live) { try { a.seekTo(S.startAt * 1000); } catch (e2) { /* ignora */ } S.startAt = 0; }
          try { a.play(); } catch (e3) { return onFail('PLAYER_ERROR_INVALID_OPERATION'); }
          S.retries = 0; busy(false);
          notePlayback(true);
        }, function (e) { if (tok === S.tok) onFail(e && (e.name || e.message) || 'PREPARE'); });
      } catch (e) { onFail(e && (e.name || e.message) || 'OPEN'); }
    } else {
      var v = S.video = document.createElement('video');
      v.autoplay = true;
      E.vid.appendChild(v);
      v.addEventListener('waiting', function () { if (tok === S.tok) busy(true); });
      v.addEventListener('playing', function () { if (tok === S.tok) { busy(false); S.retries = 0; notePlayback(true); } });
      v.addEventListener('loadedmetadata', function () {
        if (tok !== S.tok) return;
        S.dur = S.live || !isFinite(v.duration) ? 0 : v.duration * 1000;
        if (S.startAt > 5 && !S.live) { v.currentTime = S.startAt; S.startAt = 0; }
      });
      v.addEventListener('timeupdate', function () { if (tok === S.tok) tick(v.currentTime * 1000); });
      v.addEventListener('ended', function () { if (tok === S.tok) onEnded(); });
      v.addEventListener('error', function () { if (tok === S.tok) onFail('HTML5_' + (v.error ? v.error.code : 0)); });
      v.src = url; v.play();
    }
  }

  function tick(ms) {
    if (!S) return;
    if (S.seeking == null) { S.pos = ms; }
    if (S.dur === 0 && !S.live && S.engine === 'avplay') { try { S.dur = av().getDuration(); } catch (e) { /* ignora */ } }
    busy(false);
    setTimes(S.seeking != null ? S.seeking : S.pos, S.dur);
  }

  function onFail(code) {
    if (!S) return;
    code = String(code || '');
    App.log('player: falha', code);
    stopEngine();
    if (S.urlIdx < S.urls.length - 1) { S.urlIdx++; return startEngine(); }
    if (S.live && S.retries < 3) {
      S.retries++; S.urlIdx = 0; busy(true); showUI();
      App.toast('Sem sinal. Reconectando (' + S.retries + '/3)...', 1800);
      var tok = S.tok;
      S.retryT = setTimeout(function () { if (S && tok === S.tok) startEngine(); }, 1500 * S.retries);
      return;
    }
    var unsupported = /NOT_SUPPORTED_FILE|CODEC/i.test(code);
    showErr(unsupported ? 'Formato não suportado' : 'Não foi possível reproduzir',
      unsupported ? 'Esta TV não consegue reproduzir o formato ou codec deste conteúdo.' : 'O conteúdo está indisponível ou a conexão falhou. Tente novamente em instantes.',
      'OK: tentar novamente    VOLTAR: sair');
    notePlayback(false);
    S.failed = true;
  }

  function onEnded() {
    if (!S) return;
    if (S.live) { stopEngine(); S.urlIdx = 0; return startEngine(); }
    saveHist(true); close();
  }

  /* ---------- controles ---------- */
  function pauseToggle() {
    if (S.live && S.engine !== 'avplay') return;
    var a = av();
    S.paused = !S.paused;
    try {
      if (S.engine === 'avplay') { if (S.paused) a.pause(); else a.play(); }
      else if (S.paused) S.video.pause(); else S.video.play();
    } catch (e) { S.paused = !S.paused; }
    E.cur.textContent = S.paused ? '❚❚ PAUSADO' : (S.live ? 'AO VIVO' : App.fmtTime(S.pos / 1000));
    showUI();
  }

  function seekBy(sec) {
    if (S.live || !S.dur) return showUI();
    var base = S.seeking != null ? S.seeking : S.pos;
    S.seeking = App.clamp(base + sec * 1000, 0, S.dur - 1500);
    setTimes(S.seeking, S.dur); showUI(); busy(false);
    clearTimeout(S.seekT);
    S.seekT = setTimeout(function () {
      var t = S.seeking; S.seeking = null;
      try {
        if (S.engine === 'avplay') av().seekTo(Math.floor(t), function () { }, function () { onFail('SEEK'); });
        else S.video.currentTime = t / 1000;
        S.pos = t;
      } catch (e) { /* seek nao suportado */ }
    }, 400);
  }

  function zap(delta) {
    var ch = S.chans; if (!ch || !ch.items.length) return;
    var i = (ch.index + delta + ch.items.length) % ch.items.length;
    zapTo(i);
  }
  function zapTo(i) {
    var ch = S.chans, it = ch.items[i];
    if (!it || it === S.item) return;
    if (App.parental && App.parental.locked() && App.parental.isAdult(it)) { App.toast('Conteúdo adulto bloqueado', 2200); return; }
    prevItem = S.item;   /* guarda de onde viemos, para a troca rapida (tecla AZUL) */
    ch.index = i;
    saveHist(false);
    App.resume.set(it);   /* troca de canal tambem atualiza o ultimo assistido */
    stopEngine();
    App.catalog.urls(it, S.list).then(function (urls) {
      if (!S) return;
      S.item = it; S.urls = urls; S.urlIdx = 0; S.retries = 0; S.failed = false;
      S.t0 = Date.now(); S.okLogged = false; S.failLogged = false;
      setHeader();
      saveHist(false);
      startEngine(); showUI();
    });
    if (S.plist) { S.plist.idx = i; }
  }

  /* Atalho: tecla 1..9 abre o canal favorito correspondente, sem sair da reproducao. */
  function jumpFav(n) {
    var it = App.favs.byNumber(n);
    if (!it) return;                        /* tecla sem favorito associado: nao faz nada */
    if (S.item && S.item.t === it.t && S.item.id === it.id) { App.toast('★ ' + n + ' • ' + it.n, 1600); return; }
    if (App.parental && App.parental.locked() && App.parental.isAdult(it)) { App.toast('Conteúdo adulto bloqueado', 2200); return; }
    /* mantem o zap (▲▼/CH+−) navegando nos canais da categoria do favorito */
    var list = App.catalog.items('live', it.c), idx = list.indexOf(it);
    if (idx < 0) { list = [it]; idx = 0; }
    S.chans = { items: list, index: idx };
    if (S.panel) togglePanel(false);
    zapTo(idx);
    App.toast('★ ' + n + ' • ' + it.n, 1800);
  }

  /* Troca rapida (tecla AZUL): alterna entre o canal atual e o anterior, sem sair do player. */
  function swapPrev() {
    if (!S.live) return;
    if (!prevItem) return App.toast('Nenhum canal anterior', 1600);
    var alvo = App.catalog.find('live', prevItem.id) || prevItem;
    if (!alvo || (S.item && alvo.id === S.item.id)) return App.toast('Nenhum canal anterior', 1600);
    if (App.parental && App.parental.locked() && App.parental.isAdult(alvo)) { App.toast('Conteúdo adulto bloqueado', 2200); return; }
    var list = App.catalog.items('live', alvo.c), idx = list.indexOf(alvo);
    if (idx < 0) { list = [alvo]; idx = 0; }
    S.chans = { items: list, index: idx };
    if (S.panel) togglePanel(false);
    zapTo(idx);
    App.toast('↔ ' + alvo.n, 1600);
  }

  function togglePanel(on) {
    if (!S.chans) return;
    S.panel = on; cls('panel', on); cls('ui', true);
    if (on) { S.plist.setItems(S.chans.items); S.plist.setIdx(S.chans.index); S.plist.scrollTo(S.chans.index); S.plist.render(); S.plist.focus(); }
    else { S.plist.blur(); showUI(); }
  }

  function setHeader() {
    E.title.textContent = S.title(S.item); E.sub.textContent = S.sub ? S.sub(S.item) : '';
    E.badge.textContent = S.live ? '● AO VIVO' : '';
    E.keys.textContent = '';
    var hints = S.live ? ['OK: lista de canais', '▲▼: trocar canal', 'AMARELO / segurar OK: favoritar', 'AZUL: troca rápida'] : ['◀▶: -10s / +10s', 'OK: pausar', 'FF/RW: ±30s'];
    hints.forEach(function (h) { E.keys.appendChild(App.el('span', null, h)); });
  }

  /* Leva o resultado real da reproducao para o monitor de saude (uma vez por canal). */
  function notePlayback(ok) {
    if (!S || !S.live || !App.health) return;
    if (ok) {
      if (S.okLogged) return;
      S.okLogged = true;
      App.health.playback(S.item, true, S.t0 ? (Date.now() - S.t0) > App.health.cfg.playbackSlow : false);
    } else {
      if (S.failLogged) return;
      S.failLogged = true;
      App.health.playback(S.item, false);
    }
  }

  function saveHist(done) {
    if (!S) return;
    var pos = S.pos / 1000, dur = S.dur / 1000;
    if (S.live) return App.hist.record(S.item, null, 0, 0);
    if (pos < 10 && !done) return;
    App.hist.record(S.item, S.ep, done ? dur : pos, dur);
  }

  function onKey(a) {
    if (!S) return true;
    /* atalho numerico 1..9: abre o canal favorito correspondente (apenas ao vivo) */
    if (a && a.length === 2 && a.charAt(0) === 'n' && a !== 'n0') {
      if (S.live) jumpFav(+a.charAt(1));
      return true;
    }
    if (S.failed && (a === 'ok' || a === 'play')) { S.failed = false; S.retries = 0; S.urlIdx = 0; startEngine(); return true; }
    if (S.panel) {
      if (a === 'back' || a === 'left') { togglePanel(false); return true; }
      if (a === 'ok') { zapTo(S.plist.idx); togglePanel(false); return true; }
      if (a === 'up' || a === 'down') { S.plist.key(a); return true; }
      return true;
    }
    switch (a) {
      case 'back': case 'stop': case 'exit': close(); break;
      case 'ok': if (S.live) { togglePanel(true); } else pauseToggle(); break;
      case 'play': if (S.paused) pauseToggle(); else showUI(); break;
      case 'pause': if (!S.paused) pauseToggle(); break;
      case 'playpause': pauseToggle(); break;
      case 'left': S.live ? showUI() : seekBy(-10); break;
      case 'right': S.live ? togglePanel(true) : seekBy(10); break;
      case 'rw': seekBy(-30); break;
      case 'ff': seekBy(30); break;
      case 'up': case 'chdown': S.live ? zap(-1) : showUI(); break;
      case 'blue': swapPrev(); break;
      case 'down': case 'chup': S.live ? zap(1) : showUI(); break;
      case 'info': showUI(); break;
      case 'yellow': case 'hold':
        if (S.live) { var on = App.favs.toggle(S.item); App.toast(on ? '★ Canal favoritado' : 'Removido dos favoritos'); showUI(); }
        break;
    }
    return true;
  }

  function onVisibility() {
    if (!S || S.engine !== 'avplay') return;
    var a = av();
    try { if (document.hidden) a.suspend(); else a.restore(); } catch (e) { /* ignora */ }
  }

  /* ---------- ciclo de vida ---------- */
  /* o: {item, list, ep, title(item), sub(item), urls, live, startAt, chans:{items,index}, onClose} */
  function play(o) {
    build();
    if (S) close(true);
    S = {
      item: o.item, list: o.list, ep: o.ep || null, urls: o.urls, urlIdx: 0, live: !!o.live, startAt: o.startAt || 0,
      title: o.title || function (i) { return i.n; }, sub: o.sub, chans: o.chans || null, onClose: o.onClose,
      tok: 0, retries: 0, pos: 0, dur: 0, paused: false, panel: false, seeking: null
    };
    if (S.live) App.resume.set(S.item);   /* guarda o ultimo canal assistido (id + lista) */
    S.t0 = Date.now(); S.okLogged = false; S.failLogged = false;
    if (S.chans && !E.plistObj) {
      E.plistObj = new App.VList({
        root: E.plist, cols: 1, rowH: 72, empty: '',
        render: function (it, i, cell) {
          var d = App.el('div', 'pl-chan' + (S && S.item === it ? ' cur' : '')), lg = App.el('div', 'logo');
          if (/^https?:\/\//i.test(it.l || '')) { var im = document.createElement('img'); im.src = it.l; im.onerror = function () { if (im.parentNode) im.parentNode.removeChild(im); }; lg.appendChild(im); }
          d.appendChild(lg); d.appendChild(App.el('div', 'nm', it.n));
          var nf = App.favs.num(it);
          if (nf) d.appendChild(App.el('span', 'favnum sm', String(nf)));
          cell.appendChild(d);
        },
        onSelect: function (it, i) { zapTo(i); togglePanel(false); }
      });
    }
    S.plist = E.plistObj;
    if (S.plist) S.plist.o.onSelect = function (it, i) { zapTo(i); togglePanel(false); };
    document.documentElement.classList.add('playing'); document.body.classList.add('playing'); cls('open', true); cls('panel', false); cls('err', false);
    App.nav.push(layer);
    /* durante a reproducao o monitor de saude para de abrir conexoes: nao rouba banda do stream */
    if (App.health) App.health.pause();
    setHeader(); showUI(); saveHist(false);
    S.saveT = setInterval(function () { saveHist(false); }, SAVE_MS);
    startEngine();
  }

  function close(silent) {
    if (!S) return;
    var s = S;
    saveHist(false);
    clearInterval(s.saveT); clearTimeout(s.uiT); clearTimeout(s.retryT); clearTimeout(s.seekT);
    s.tok++;
    stopEngine();
    S = null;
    cls('open', false); cls('ui', false); cls('busy', false); cls('err', false); cls('panel', false);
    document.documentElement.classList.remove('playing'); document.body.classList.remove('playing');
    if (App.health) App.health.resume();   /* voltou para as telas: retoma a fila de verificacao */
    App.nav.pop(layer);
    if (!silent && s.onClose) s.onClose(s);
  }

  App.player = { play: play, close: close, isOpen: function () { return !!S; } };
})(window);
