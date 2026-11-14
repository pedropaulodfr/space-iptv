/* Player web: HTML5 <video>, HLS (nativo no Safari ou hls.js) e MPEG-TS (mpegts.js).
   Mesmo contrato e comportamento visual do player da TV (tv/js/player/player.js),
   com os controles que so fazem sentido no navegador: barra clicavel, mudo,
   tela cheia, Picture-in-Picture e o aviso de autoplay bloqueado.
   Nao usa innerHTML com dados remotos, eval, new Function nem document.write. */
(function (g) {
  'use strict';
  var App = g.App, S = null, built = false, E = {};
  var prevItem = null;                 /* canal anterior da sessao (troca rapida) */
  var layer = { key: onKey };
  var UI_MS = 4000, SAVE_MS = 15000, PREP_MS = 25000, CLICK_MS = 220;
  var vendorP = {};                    /* nome -> Promise (carrega uma unica vez) */
  var tokSeq = 0;                       /* tokens unicos entre sessoes/canais */
  var STYLE_ID = 'player-web-style';

  function mk(tag, cls, text) { return App.el(tag, cls, text); }
  function cls(name, on) { if (E.root) E.root.classList[on ? 'add' : 'remove'](name); }
  function stage() { return document.getElementById('stage') || document.body; }
  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  /* ------------------------------------------------------------------ */
  /* CSS escopado (web-only): o CSS da TV continua valendo como base     */
  /* ------------------------------------------------------------------ */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '#player{position:absolute;left:0;top:0;width:1920px;height:1080px;z-index:60;background:transparent;display:none}',
      '#player.open{display:block}',
      '#player video{position:absolute;left:0;top:0;width:1920px;height:1080px;object-fit:contain;background:#000}',
      '#player .pl-top,#player .pl-bottom{pointer-events:none}',
      '#player .pl-ctl,#player .pl-prog{pointer-events:auto}',
      '#player:not(.ui) .pl-ctl,#player:not(.ui) .pl-prog{pointer-events:none}',
      '#player .pl-ctl{position:absolute;right:var(--safe,48px);top:20px;display:flex;gap:8px;z-index:4}',
      '#player .pl-btn{width:44px;height:44px;min-width:44px;min-height:44px;padding:0;display:flex;align-items:center;justify-content:center;',
      'color:#fff;background:rgba(11,22,56,.78);border:1px solid rgba(255,255,255,.24);border-radius:12px;cursor:pointer;',
      'transition:background 150ms,border-color 150ms}',
      '#player .pl-btn:hover{background:rgba(66,133,255,.3);border-color:rgba(255,255,255,.5)}',
      '#player .pl-btn:focus-visible{outline:3px solid var(--electricBlue,#4285ff);outline-offset:2px}',
      '#player .pl-btn[hidden]{display:none}',
      '#player .pl-btn svg{width:22px;height:22px;display:block;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
      '#player .pl-btn .ico-mute{display:none}',
      '#player.muted .pl-btn .ico-vol{display:none}',
      '#player.muted .pl-btn .ico-mute{display:block}',
      '#player .pl-prog{position:relative;height:44px;background:transparent;overflow:visible;cursor:default;border-radius:6px}',
      '#player .pl-prog[data-seek="1"]{cursor:pointer}',
      '#player .pl-prog::before{content:"";position:absolute;left:0;right:0;top:18px;height:8px;border-radius:4px;background:rgba(255,255,255,.2)}',
      '#player .pl-prog i{position:absolute;left:0;top:18px;height:8px;border-radius:4px;',
      'background:linear-gradient(90deg,var(--electricBlue,#4285ff),var(--cosmicPurple,#8257e5))}',
      '#player .pl-prog:focus-visible{outline:3px solid var(--electricBlue,#4285ff);outline-offset:2px}',
      '#player .pl-start{position:absolute;left:0;top:0;right:0;bottom:0;display:none;align-items:center;justify-content:center;',
      'flex-direction:column;gap:18px;background:rgba(3,5,12,.76);z-index:5;text-align:center;padding:0 40px}',
      '#player .pl-start[hidden]{display:none}',
      '#player .pl-spin{pointer-events:none}',
      '#player.blocked .pl-start{display:flex}',
      '#player .pl-start-title{font-family:var(--font-display,inherit);font-size:28px;font-weight:700;color:#fff}',
      '#player .pl-start-btn{min-height:56px;padding:0 30px;font:inherit;font-size:20px;font-weight:600;color:#fff;',
      'background:rgba(11,22,56,.96);border:2px solid var(--glassFocusBorder,rgba(66,133,255,.55));border-radius:999px;',
      'cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.35)}',
      '#player .pl-start-btn:focus-visible{outline:3px solid var(--electricBlue,#4285ff);outline-offset:3px}',
      '#player .pl-msg{pointer-events:auto;z-index:6}',
      '#player .pl-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
      '@media (prefers-reduced-motion: reduce){',
      '  #player .spinner{animation:none}',
      '  #player .pl-top,#player .pl-bottom,#player .pl-btn{transition:none}',
      '}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  /* ------------------------------------------------------------------ */
  /* DOM                                                                */
  /* ------------------------------------------------------------------ */
  function svgIcon(kind) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    function path(d, fill) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      if (fill) p.setAttribute('fill', 'currentColor');
      svg.appendChild(p);
    }
    if (kind === 'volume') {
      path('M4 9v6h4l5 4V5L8 9H4z');
      path('M16.5 8.5a5 5 0 0 1 0 7');
      path('M19 6a8.5 8.5 0 0 1 0 12');
    } else if (kind === 'mute') {
      path('M4 9v6h4l5 4V5L8 9H4z');
      path('M16 9l5 5');
      path('M21 9l-5 5');
    } else if (kind === 'full') {
      path('M4 9V4h5');
      path('M15 4h5v5');
      path('M20 15v5h-5');
      path('M9 20H4v-5');
    } else if (kind === 'pip') {
      path('M3 5h18v14H3z');
      path('M13 13h5v3h-5z');
    }
    return svg;
  }

  function mkBtn(label, ico, handler) {
    var b = mk('button', 'pl-btn');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', 'false');
    b.appendChild(ico);
    b.addEventListener('click', function (ev) { ev.stopPropagation(); handler(); });
    b.addEventListener('dblclick', function (ev) { ev.stopPropagation(); });
    return b;
  }

  function build() {
    if (built) return;
    built = true;
    injectStyle();

    var r = E.root = mk('div');
    r.id = 'player';
    r.setAttribute('role', 'region');
    r.setAttribute('aria-label', 'Reprodutor de vídeo');

    E.vid = mk('div');
    r.appendChild(E.vid);

    var top = mk('div', 'pl-top');
    top.appendChild(mk('div', 'hud-caption', 'Esc: sair   |   Enter: controles'));
    E.badge = mk('span', 'badge');
    top.appendChild(E.badge);
    E.title = mk('div', 'pl-title');
    E.sub = mk('div', 'pl-sub');
    top.appendChild(E.title);
    top.appendChild(E.sub);
    r.appendChild(top);

    E.spin = mk('div', 'pl-spin');
    E.spin.setAttribute('role', 'status');
    E.spin.setAttribute('aria-live', 'polite');
    E.spin.appendChild(mk('span', 'pl-sr', 'Carregando...'));
    var spinner = mk('div', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    E.spin.appendChild(spinner);
    r.appendChild(E.spin);

    E.start = mk('div', 'pl-start');
    E.start.appendChild(mk('div', 'pl-start-title', 'Reprodução pausada'));
    E.startBtn = mk('button', 'pl-start-btn', 'Enter/clique para iniciar a reprodução');
    E.startBtn.type = 'button';
    E.startBtn.setAttribute('aria-label', 'Iniciar reprodução');
    E.start.appendChild(E.startBtn);
    r.appendChild(E.start);

    var msg = E.msg = mk('div', 'pl-msg glass-panel');
    msg.setAttribute('role', 'alert');
    E.msgT = mk('h2', 'h2');
    E.msgB = mk('div', 'msg');
    E.msgH = mk('div', 'hud-caption');
    msg.appendChild(E.msgT);
    msg.appendChild(E.msgB);
    msg.appendChild(E.msgH);
    r.appendChild(msg);

    var bot = mk('div', 'pl-bottom');
    E.prog = mk('div', 'pl-prog');
    E.bar = mk('i');
    E.prog.appendChild(E.bar);
    var tm = mk('div', 'pl-time');
    E.cur = mk('span');
    E.dur = mk('span');
    tm.appendChild(E.cur);
    tm.appendChild(E.dur);
    E.keys = mk('div', 'pl-keys');
    bot.appendChild(E.prog);
    bot.appendChild(tm);
    bot.appendChild(E.keys);
    E.ctl = mk('div', 'pl-ctl');
    E.ctl.setAttribute('role', 'group');
    E.ctl.setAttribute('aria-label', 'Controles de reprodução');
    E.muteBtn = mkBtn('Silenciar', (function () {
      var wrap = mk('span');
      wrap.style.display = 'contents';
      var v = svgIcon('volume'), m = svgIcon('mute');
      v.setAttribute('class', 'ico-vol');
      m.setAttribute('class', 'ico-mute');
      wrap.appendChild(v); wrap.appendChild(m);
      return wrap;
    })(), toggleMute);
    E.fullBtn = mkBtn('Tela cheia', svgIcon('full'), toggleFullscreen);
    E.pipBtn = mkBtn('Picture-in-Picture', svgIcon('pip'), togglePip);
    E.pipBtn.hidden = true;
    E.ctl.appendChild(E.muteBtn);
    E.ctl.appendChild(E.fullBtn);
    E.ctl.appendChild(E.pipBtn);
    bot.appendChild(E.ctl);
    r.appendChild(bot);

    var pn = E.panel = mk('div', 'pl-panel glass-panel');
    pn.setAttribute('role', 'dialog');
    pn.setAttribute('aria-label', 'Lista de canais');
    E.plist = mk('div');
    E.plist.setAttribute('role', 'listbox');
    E.plist.setAttribute('aria-label', 'Canais');
    pn.appendChild(E.plist);
    r.appendChild(pn);

    stage().appendChild(r);

    E.startBtn.addEventListener('click', function (ev) { ev.stopPropagation(); resumePlayback(); });
    E.prog.addEventListener('click', onProgClick);
    E.prog.addEventListener('keydown', onProgKey);
    E.prog.addEventListener('focus', showUI);
    E.ctl.addEventListener('focusin', showUI);
    E.panel.addEventListener('wheel', onPanelWheel, { passive: false });
    E.plist.addEventListener('click', onPanelClick);
    document.addEventListener('fullscreenchange', syncFullscreen);
    document.addEventListener('webkitfullscreenchange', syncFullscreen);
    syncFullscreen();
    syncMute();
    syncPip();
  }

  /* ------------------------------------------------------------------ */
  /* Estado visual                                                       */
  /* ------------------------------------------------------------------ */
  function busy(on) { cls('busy', on); }
  function showUI() {
    cls('ui', true);
    if (S) clearTimeout(S.uiT);
    if (!S) return;
    S.uiT = setTimeout(function () {
      if (S && !S.paused && !S.panel && !S.blocked && E.root) cls('ui', false);
    }, UI_MS);
  }
  function toggleUI() {
    if (!S) return;
    if (E.root.classList.contains('ui')) { if (!S.panel) cls('ui', false); }
    else showUI();
  }
  function showErr(title, body, hint) {
    busy(false);
    cls('err', true);
    E.msgT.textContent = title;
    E.msgB.textContent = body;
    E.msgH.textContent = hint || '';
  }
  function clearErr() { cls('err', false); }
  function setProgMode(vod) {
    if (!E.prog) return;
    E.prog.setAttribute('data-seek', vod ? '1' : '0');
    if (vod) {
      E.prog.setAttribute('role', 'slider');
      E.prog.setAttribute('tabindex', '0');
      E.prog.removeAttribute('aria-hidden');
      E.prog.setAttribute('aria-label', 'Progresso do vídeo');
      E.prog.setAttribute('aria-valuemin', '0');
    } else {
      E.prog.removeAttribute('role');
      E.prog.removeAttribute('tabindex');
      E.prog.setAttribute('aria-hidden', 'true');
    }
  }
  function setTimes(pos, dur) {
    if (!S) return;
    var sec = pos / 1000, dsec = (dur || 0) / 1000;
    if (S.live) {
      E.cur.textContent = 'AO VIVO';
      E.dur.textContent = '';
      E.bar.style.width = '0%';
      E.prog.setAttribute('aria-hidden', 'true');
      return;
    }
    E.prog.removeAttribute('aria-hidden');
    E.cur.textContent = S.paused ? '❚❚ PAUSADO' : App.fmtTime(sec);
    E.dur.textContent = dur ? App.fmtTime(dsec) : '';
    E.bar.style.width = (dur ? App.clamp(pos / dur * 100, 0, 100) : 0) + '%';
    E.prog.setAttribute('aria-valuemax', String(Math.max(0, Math.floor(dsec))));
    E.prog.setAttribute('aria-valuenow', String(Math.max(0, Math.floor(sec))));
    E.prog.setAttribute('aria-valuetext', App.fmtTime(sec) + (dur ? ' de ' + App.fmtTime(dsec) : ''));
  }
  function setHeader() {
    if (!S) return;
    var title = '';
    try { title = S.title ? S.title(S.item) : (S.item && S.item.n) || ''; } catch (e) { title = (S.item && S.item.n) || ''; }
    var sub = '';
    try { sub = S.sub ? S.sub(S.item) : ''; } catch (e2) { sub = ''; }
    E.title.textContent = title || '';
    E.sub.textContent = sub || '';
    E.badge.textContent = S.live ? '● AO VIVO' : '';
    E.badge.style.display = S.live ? '' : 'none';
    App.clear(E.keys);
    var hints = S.live
      ? ['OK: lista de canais', '▲▼: trocar canal', 'F / segurar Enter: favoritar', 'X: troca rápida']
      : ['◀▶: -10s / +10s', 'OK: pausar', 'clique na barra: avançar'];
    hints.forEach(function (h) { E.keys.appendChild(mk('span', null, h)); });
  }
  function syncMute() {
    if (!E.muteBtn) return;
    var muted = !!(S && S.video && S.video.muted);
    cls('muted', muted);
    var label = muted ? 'Ativar som' : 'Silenciar';
    E.muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    E.muteBtn.setAttribute('aria-label', label);
    E.muteBtn.title = label;
  }
  function syncFullscreen() {
    if (!E.fullBtn) return;
    var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    var label = on ? 'Sair da tela cheia' : 'Tela cheia';
    E.fullBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    E.fullBtn.setAttribute('aria-label', label);
    E.fullBtn.title = label;
  }
  function pipSupported() {
    return !!(document.pictureInPictureEnabled && g.HTMLVideoElement &&
      g.HTMLVideoElement.prototype && g.HTMLVideoElement.prototype.requestPictureInPicture);
  }
  function syncPip() {
    if (!E.pipBtn) return;
    E.pipBtn.hidden = !pipSupported();
    var on = !!(document.pictureInPictureElement && S && S.video && document.pictureInPictureElement === S.video);
    var label = on ? 'Sair do Picture-in-Picture' : 'Picture-in-Picture';
    E.pipBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    E.pipBtn.setAttribute('aria-label', label);
    E.pipBtn.title = label;
  }

  /* ------------------------------------------------------------------ */
  /* Engines                                                             */
  /* ------------------------------------------------------------------ */
  function kindOf(url) {
    var clean = String(url || '').split('#')[0].split('?')[0].toLowerCase();
    var m = /\.([a-z0-9]{1,6})$/.exec(clean);
    var ext = m ? m[1] : '';
    if (ext === 'm3u8' || clean.indexOf('mpegurl') >= 0) return { engine: 'hls', ext: ext };
    if (ext === 'ts' || ext === 'm2ts' || clean.indexOf('mpegts') >= 0) return { engine: 'mpegts', ext: ext };
    return { engine: 'native', ext: ext };
  }
  function isSafari() {
    var ua = (g.navigator && g.navigator.userAgent) || '';
    return /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edg|android|opr/i.test(ua);
  }
  function mediaUrl(url, kind) {
    if (kind.engine !== 'hls' && kind.engine !== 'mpegts') return url;
    if (App.net && typeof App.net.mediaUrl === 'function') {
      try {
        var out = App.net.mediaUrl(url);
        if (typeof out === 'string' && out) return out;
      } catch (e) { App.log('player: mediaUrl falhou'); }
    }
    return url;
  }
  function loadVendor(name) {
    var globalName = name === 'hls' ? 'Hls' : 'mpegts';
    if (g[globalName]) return Promise.resolve(g[globalName]);
    if (vendorP[name]) return vendorP[name];
    vendorP[name] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.async = true;
      s.src = new URL('web/vendor/' + (name === 'hls' ? 'hls.min.js' : 'mpegts.min.js'), document.baseURI).href;
      s.onload = function () {
        if (g[globalName]) resolve(g[globalName]);
        else reject(new Error('global ausente'));
      };
      s.onerror = function () { reject(new Error('falha ao carregar ' + name)); };
      (document.head || document.documentElement).appendChild(s);
    });
    return vendorP[name];
  }
  function ok(tok) { return !!(S && S.tok === tok); }
  function clearPrep() { if (S) clearTimeout(S.prepT); }
  function armPrep(tok) {
    if (!S) return;
    clearTimeout(S.prepT);
    S.prepT = setTimeout(function () { if (ok(tok)) onFail('TIMEOUT'); }, PREP_MS);
  }

  function stopEngine() {
    if (!S) return;
    clearTimeout(S.prepT);
    if (S.hls) {
      try { S.hls.destroy(); } catch (e) { /* ja destruido */ }
      S.hls = null;
    }
    if (S.mpegts) {
      var p = S.mpegts;
      S.mpegts = null;
      try { p.pause(); } catch (e2) { /* ignore */ }
      try { p.unload(); } catch (e3) { /* ignore */ }
      try { p.detachMediaElement(); } catch (e4) { /* ignore */ }
      try { p.destroy(); } catch (e5) { /* ignore */ }
    }
    if (S.video) {
      var v = S.video;
      S.video = null;
      try { v.pause(); } catch (e6) { /* ignore */ }
      try { v.removeAttribute('src'); } catch (e7) { /* ignore */ }
      try { v.load(); } catch (e8) { /* ignore */ }
      if (v.parentNode) v.parentNode.removeChild(v);
    }
  }

  function createVideo(tok) {
    var v = document.createElement('video');
    v.autoplay = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.muted = false;
    v.controls = false;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.style.objectFit = 'contain';
    v.style.background = '#000';
    E.vid.appendChild(v);

    v.addEventListener('waiting', function () { if (ok(tok)) busy(true); });
    v.addEventListener('stalled', function () { if (ok(tok)) busy(true); });
    v.addEventListener('playing', function () {
      if (!ok(tok)) return;
      clearPrep();
      busy(false);
      S.blocked = false;
      cls('blocked', false);
      S.retries = 0;
      S.failed = false;
      syncMute();
      syncPip();
      notePlayback(true);
      setTimes(S.pos, S.dur);
    });
    v.addEventListener('loadedmetadata', function () {
      if (!ok(tok)) return;
      S.dur = S.live || !isFinite(v.duration) ? 0 : v.duration * 1000;
      if (!S.live && S.startAt > 5) applyStart(v);
      setTimes(S.pos, S.dur);
      syncPip();
    });
    v.addEventListener('durationchange', function () {
      if (!ok(tok)) return;
      S.dur = S.live || !isFinite(v.duration) ? 0 : v.duration * 1000;
      if (S.dur) setTimes(S.seeking != null ? S.seeking : S.pos, S.dur);
    });
    v.addEventListener('timeupdate', function () {
      if (!ok(tok)) return;
      tick(v.currentTime * 1000);
    });
    v.addEventListener('seeked', function () {
      if (!ok(tok)) return;
      if (S.seeking == null) { S.pos = v.currentTime * 1000; setTimes(S.pos, S.dur); }
    });
    v.addEventListener('ended', function () { if (ok(tok)) onEnded(); });
    v.addEventListener('error', function () {
      if (!ok(tok)) return;
      onFail('HTML5_' + (v.error ? v.error.code : 0));
    });
    v.addEventListener('volumechange', syncMute);
    v.addEventListener('enterpictureinpicture', syncPip);
    v.addEventListener('leavepictureinpicture', syncPip);
    v.addEventListener('click', onVideoClick);
    v.addEventListener('dblclick', onVideoDblClick);
    syncPip();
    return v;
  }

  function playVideo(v, tok) {
    var p;
    try { p = v.play(); } catch (e) { handlePlayError(e, tok); return; }
    if (p && p.catch) p.catch(function (e) { handlePlayError(e, tok); });
  }

  function startNative(v, tok, url, engineName) {
    if (!ok(tok)) return;
    S.engine = engineName || 'native';
    try { v.src = url; v.load(); } catch (e) { return onFail('SRC'); }
    playVideo(v, tok);
  }

  function startHls(v, tok, url) {
    S.engine = 'hls';
    loadVendor('hls').then(function (Hls) {
      if (!ok(tok)) return;
      if (!Hls) return onFail('HLS_MISSING');
      if (!Hls.isSupported()) {
        if (v.canPlayType('application/vnd.apple.mpegurl')) return startNative(v, tok, url, 'hls-native');
        return onFail('HLS_UNSUPPORTED');
      }
      var cfg = {
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 30,
        liveSyncDurationCount: 3,
        manifestLoadingMaxRetry: 1,
        levelLoadingMaxRetry: 1,
        fragLoadingMaxRetry: 2,
        manifestLoadingRetryDelay: 500,
        levelLoadingRetryDelay: 500,
        fragLoadingRetryDelay: 500
      };
      if (!S.live && S.startAt > 5) cfg.startPosition = S.startAt;
      var hls = S.hls = new Hls(cfg);
      hls.on(Hls.Events.ERROR, function (ev, data) {
        if (!ok(tok) || S.hls !== hls) return;
        if (!data || !data.fatal) return;
        onFail('HLS_' + data.type + '_' + (data.details || ''));
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        if (!ok(tok) || S.hls !== hls) return;
        playVideo(v, tok);
      });
      try {
        hls.attachMedia(v);
        hls.loadSource(url);
      } catch (e) { onFail('HLS_ATTACH'); }
    }).then(null, function () {
      if (ok(tok)) onFail('HLS_LOAD');
    });
  }

  function startMpegts(v, tok, url) {
    S.engine = 'mpegts';
    loadVendor('mpegts').then(function (mpegts) {
      if (!ok(tok)) return;
      if (!mpegts) return onFail('MPEGTS_MISSING');
      if (mpegts.isSupported && !mpegts.isSupported()) return onFail('MPEGTS_UNSUPPORTED');
      var p;
      try {
        p = mpegts.createPlayer({
          type: 'mse',
          isLive: !!S.live,
          url: url
        }, {
          enableWorker: true,
          liveBufferLatencyChasing: true
        });
      } catch (e) { return onFail('MPEGTS_CREATE'); }
      S.mpegts = p;
      p.on(mpegts.Events.ERROR, function (type, detail) {
        if (!ok(tok) || S.mpegts !== p) return;
        onFail('MPEGTS_' + type + '_' + detail);
      });
      try {
        p.attachMediaElement(v);
        p.load();
      } catch (e2) { return onFail('MPEGTS_ATTACH'); }
      var pp;
      try { pp = p.play(); } catch (e3) { /* video.play cobre o autoplay */ }
      if (pp && pp.catch) pp.catch(function (e) { handlePlayError(e, tok); });
      playVideo(v, tok);
    }).then(null, function () {
      if (ok(tok)) onFail('MPEGTS_LOAD');
    });
  }

  function startEngine() {
    if (!S) return;
    var raw = S.urls[S.urlIdx];
    if (!raw) { showNoUrls(); return; }
    var tok = S.tok = ++tokSeq;
    stopEngine();
    S.failed = false;
    S.blocked = false;
    S.paused = false;
    S.pos = 0;
    S.dur = 0;
    S.failTok = 0;
    cls('err', false);
    cls('blocked', false);
    busy(true);
    var kind = kindOf(raw);
    var url = mediaUrl(raw, kind);
    S.engineUrl = raw;
    S.playUrl = url;
    try { App.log('player: abrindo', App.redact ? App.redact(url) : url); } catch (e) { /* sem console */ }
    var v = S.video = createVideo(tok);
    armPrep(tok);
    if (kind.engine === 'hls') {
      if (isSafari()) startNative(v, tok, url, 'hls-native');
      else startHls(v, tok, url);
    } else if (kind.engine === 'mpegts') {
      startMpegts(v, tok, url);
    } else {
      startNative(v, tok, url, 'native');
    }
    setTimes(0, 0);
  }

  function handlePlayError(e, tok) {
    if (!ok(tok)) return;
    if (e && e.name === 'NotAllowedError') { blockAutoplay(); return; }
    if (e && e.name === 'AbortError') return;   /* troca de src/engine, nao e falha real */
    onFail('PLAY_' + ((e && e.name) || 'ERRO'));
  }

  function blockAutoplay() {
    if (!S) return;
    S.blocked = true;
    S.paused = false;
    clearPrep();
    busy(false);
    cls('blocked', true);
    showUI();
    try { E.startBtn.focus({ preventScroll: true }); } catch (e) { try { E.startBtn.focus(); } catch (e2) { /* ignore */ } }
  }

  function resumePlayback() {
    if (!S || !S.blocked) return;
    var tok = S.tok;
    S.blocked = false;
    cls('blocked', false);
    busy(true);
    showUI();
    if (S.mpegts) {
      try {
        var mp = S.mpegts.play();
        if (mp && mp.catch) mp.catch(function (e) { handlePlayError(e, tok); });
      } catch (e) { /* ignore */ }
    }
    if (S.video) playVideo(S.video, tok);
  }

  function onFail(code) {
    if (!S) return;
    var tok = S.tok;
    if (S.failTok === tok) return;   /* uma falha por tentativa */
    S.failTok = tok;
    code = String(code || '');
    try { App.log('player: falha', code); } catch (e) { /* sem console */ }
    stopEngine();
    if (S.urlIdx < S.urls.length - 1) {
      S.urlIdx++;
      startEngine();
      return;
    }
    if (S.live && S.retries < 3) {
      S.retries++;
      S.urlIdx = 0;
      busy(true);
      showUI();
      App.toast('Sem sinal. Reconectando (' + S.retries + '/3)...', 1800);
      var t = tok;
      S.retryT = setTimeout(function () { if (S && S.tok === t) startEngine(); }, 1500 * S.retries);
      return;
    }
    var unsupported = /NOT_SUPPORTED|CODEC|UNSUPPORTED|SRC_NOT|MEDIA_ERR_SRC_NOT_SUPPORTED/i.test(code);
    showErr(
      unsupported ? 'Formato não suportado' : 'Não foi possível reproduzir',
      unsupported
        ? 'Este navegador não consegue reproduzir o formato ou codec deste conteúdo.'
        : 'O conteúdo está indisponível ou a conexão falhou. Tente novamente em instantes.',
      'Enter: tentar novamente    Esc: sair'
    );
    notePlayback(false);
    S.failed = true;
  }

  function showNoUrls() {
    if (!S) return;
    busy(false);
    showErr(
      'Não foi possível reproduzir',
      'Nenhum endereço de reprodução foi encontrado para este conteúdo.',
      'Esc: sair'
    );
    notePlayback(false);
    S.failed = true;
  }

  function retry() {
    if (!S) return;
    if (!S.urls.length) { showNoUrls(); return; }
    S.failed = false;
    S.retries = 0;
    S.urlIdx = 0;
    S.failTok = 0;
    S.blocked = false;
    cls('blocked', false);
    cls('err', false);
    startEngine();
  }

  function onEnded() {
    if (!S) return;
    if (S.live) { stopEngine(); S.urlIdx = 0; startEngine(); return; }
    saveHist(true);
    close();
  }

  function tick(ms) {
    if (!S) return;
    if (S.seeking == null) S.pos = ms;
    if (!S.live && !S.dur && S.video && isFinite(S.video.duration)) S.dur = S.video.duration * 1000;
    busy(false);
    setTimes(S.seeking != null ? S.seeking : S.pos, S.dur);
  }

  function applyStart(v) {
    if (!S || S.live || !(S.startAt > 5)) return;
    var d = isFinite(v.duration) ? v.duration : 0;
    var t = S.startAt;
    if (d && t >= d - 1) t = Math.max(0, d - 1);
    try { v.currentTime = t; } catch (e) { return; }
    S.pos = t * 1000;
    S.startAt = 0;
    setTimes(S.pos, S.dur);
  }

  /* ------------------------------------------------------------------ */
  /* Controles                                                           */
  /* ------------------------------------------------------------------ */
  function toggleMute() {
    if (!S || !S.video) return;
    S.video.muted = !S.video.muted;
    syncMute();
    showUI();
  }

  function toggleFullscreen() {
    try {
      var on = document.fullscreenElement || document.webkitFullscreenElement;
      if (on) {
        var ex = document.exitFullscreen || document.webkitExitFullscreen;
        if (ex) {
          var p = ex.call(document);
          if (p && p.catch) p.catch(function () { /* ignore */ });
        }
      } else {
        var el = document.documentElement;
        var fn = el.requestFullscreen || el.webkitRequestFullscreen;
        if (!fn) { App.toast('Tela cheia não disponível neste navegador', 2200); return; }
        var q = fn.call(el);
        if (q && q.catch) q.catch(function () { App.toast('Tela cheia não disponível neste navegador', 2200); });
      }
    } catch (e) { App.toast('Tela cheia não disponível neste navegador', 2200); }
  }

  function togglePip() {
    if (!S || !S.video || !pipSupported()) return;
    try {
      if (document.pictureInPictureElement) {
        var p = document.exitPictureInPicture();
        if (p && p.catch) p.catch(function () { /* ignore */ });
      } else {
        var q = S.video.requestPictureInPicture();
        if (q && q.catch) q.catch(function () { App.toast('Picture-in-Picture não disponível para este conteúdo', 2400); });
      }
    } catch (e) { App.toast('Picture-in-Picture não disponível neste navegador', 2400); }
  }

  function pauseToggle() {
    if (!S || S.live) return;
    var tok = S.tok;
    S.paused = !S.paused;
    try {
      if (S.paused) {
        if (S.mpegts) S.mpegts.pause();
        if (S.video) S.video.pause();
        saveHist(false);
      } else {
        if (S.mpegts) {
          var mp = S.mpegts.play();
          if (mp && mp.catch) mp.catch(function (e) { handlePlayError(e, tok); });
        }
        if (S.video) playVideo(S.video, tok);
      }
    } catch (e) { S.paused = !S.paused; }
    setTimes(S.pos, S.dur);
    showUI();
  }

  function seekBy(sec) {
    if (!S || S.live || !S.dur) return showUI();
    var base = S.seeking != null ? S.seeking : S.pos;
    seekTo((base + sec * 1000) / 1000);
  }

  function seekTo(sec) {
    if (!S || S.live || !S.dur) return showUI();
    var limit = S.dur > 1500 ? (S.dur - 1500) / 1000 : Math.max(0, S.dur / 1000 - 0.1);
    S.seeking = App.clamp(sec, 0, limit) * 1000;
    setTimes(S.seeking, S.dur);
    showUI();
    busy(false);
    clearTimeout(S.seekT);
    S.seekT = setTimeout(function () {
      if (!S) return;
      var t = S.seeking;
      S.seeking = null;
      if (t == null) return;
      try {
        if (S.video) S.video.currentTime = t / 1000;
        S.pos = t;
      } catch (e) { /* seek nao suportado */ }
      setTimes(S.pos, S.dur);
    }, 350);
  }

  function onProgClick(ev) {
    if (!S || S.live || !S.dur) return;
    ev.stopPropagation();
    var rect = E.prog.getBoundingClientRect();
    if (!rect.width) return;
    var frac = App.clamp((ev.clientX - rect.left) / rect.width, 0, 1);
    seekTo(frac * S.dur / 1000);
    try { E.prog.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  function onProgKey(ev) {
    if (!S || S.live || !S.dur) return;
    if (ev.key !== 'Home' && ev.key !== 'End') return;
    ev.preventDefault();
    ev.stopPropagation();
    seekTo(ev.key === 'Home' ? 0 : S.dur / 1000);
  }

  function onVideoClick(ev) {
    if (!S) return;
    if (S.blocked) { resumePlayback(); return; }
    clearTimeout(S.clickT);
    S.clickT = setTimeout(function () {
      if (!S) return;
      if (!S.live) pauseToggle();
      else toggleUI();
    }, CLICK_MS);
  }

  function onVideoDblClick(ev) {
    if (!S) return;
    if (ev && ev.preventDefault) ev.preventDefault();
    clearTimeout(S.clickT);
    toggleFullscreen();
  }

  function onPanelWheel(ev) {
    if (!S || !S.panel || !S.plist) return;
    ev.preventDefault();
    var now = Date.now();
    if (now - (S.wheelT || 0) < 90) return;
    S.wheelT = now;
    S.plist.key(ev.deltaY > 0 ? 'down' : 'up');
  }

  function onPanelClick(ev) {
    if (!S || !S.panel || !S.plist) return;
    var target = ev.target;
    var cell = target && target.closest ? target.closest('.vl-cell') : null;
    if (!cell || !cell.parentNode) return;
    ev.stopPropagation();
    var row = cell.parentNode;
    var top = parseFloat(row.style.top || '0');
    if (isNaN(top)) top = 0;
    var col = Array.prototype.indexOf.call(row.children, cell);
    var idx = Math.round(top / 72) + (col > 0 ? col : 0);
    if (idx < 0 || idx >= S.chans.items.length) return;
    S.plist.idx = idx;
    zapTo(idx);
    togglePanel(false);
  }

  /* ------------------------------------------------------------------ */
  /* Zap, favoritos, painel                                              */
  /* ------------------------------------------------------------------ */
  function zap(delta) {
    var ch = S && S.chans;
    if (!ch || !ch.items.length) return;
    var i = (ch.index + delta + ch.items.length) % ch.items.length;
    zapTo(i);
  }

  function zapTo(i) {
    if (!S || !S.chans) return;
    var ch = S.chans, it = ch.items[i];
    if (!it || it === S.item) return;
    if (App.parental && App.parental.locked() && App.parental.isAdult(it)) {
      App.toast('Conteúdo adulto bloqueado', 2200);
      return;
    }
    prevItem = S.item;
    ch.index = i;
    saveHist(false);
    if (App.resume) App.resume.set(it);
    var tok = S.zapTok = ++tokSeq;
    stopEngine();
    busy(true);
    cls('err', false);
    if (S.plist) S.plist.idx = i;
    var request;
    try {
      request = App.catalog && App.catalog.urls ? App.catalog.urls(it, S.list) : Promise.reject({ code: 'network' });
    } catch (e) { request = Promise.reject(e); }
    Promise.resolve(request).then(function (urls) {
      if (!S || S.zapTok !== tok) return;
      var arr = [], j;
      urls = urls || [];
      for (j = 0; j < urls.length; j++) if (typeof urls[j] === 'string' && urls[j]) arr.push(urls[j]);
      S.item = it;
      S.urls = arr;
      S.urlIdx = 0;
      S.retries = 0;
      S.failed = false;
      S.failTok = 0;
      S.startAt = 0;
      S.ep = null;
      S.t0 = Date.now();
      S.okLogged = false;
      S.failLogged = false;
      setHeader();
      saveHist(false);
      if (!arr.length) { showNoUrls(); return; }
      startEngine();
      showUI();
    }).then(null, function (e) {
      if (!S || S.zapTok !== tok) return;
      busy(false);
      var msg = App.friendly ? App.friendly(e && e.code ? e : { code: 'network' }) : 'Não foi possível trocar de canal.';
      showErr('Não foi possível trocar de canal', msg, 'Esc: sair');
      S.failed = true;
    });
  }

  function jumpFav(n) {
    if (!S || !S.live || !App.favs) return;
    var it = App.favs.byNumber(n);
    if (!it) return;
    if (S.item && S.item.t === it.t && S.item.id === it.id) {
      App.toast('★ ' + n + ' • ' + it.n, 1600);
      return;
    }
    if (App.parental && App.parental.locked() && App.parental.isAdult(it)) {
      App.toast('Conteúdo adulto bloqueado', 2200);
      return;
    }
    var list = App.catalog ? App.catalog.items('live', it.c) : [it];
    var idx = list.indexOf(it);
    if (idx < 0) { list = [it]; idx = 0; }
    S.chans = { items: list, index: idx };
    if (S.panel) togglePanel(false);
    zapTo(idx);
    App.toast('★ ' + n + ' • ' + it.n, 1800);
  }

  function swapPrev() {
    if (!S || !S.live) return;
    if (!prevItem) { App.toast('Nenhum canal anterior', 1600); return; }
    var alvo = (App.catalog && App.catalog.find('live', prevItem.id)) || prevItem;
    if (!alvo || (S.item && alvo.id === S.item.id)) { App.toast('Nenhum canal anterior', 1600); return; }
    if (App.parental && App.parental.locked() && App.parental.isAdult(alvo)) {
      App.toast('Conteúdo adulto bloqueado', 2200);
      return;
    }
    var list = App.catalog ? App.catalog.items('live', alvo.c) : [alvo];
    var idx = list.indexOf(alvo);
    if (idx < 0) { list = [alvo]; idx = 0; }
    S.chans = { items: list, index: idx };
    if (S.panel) togglePanel(false);
    zapTo(idx);
    App.toast('↔ ' + alvo.n, 1600);
  }

  function toggleFav() {
    if (!S || !S.live || !App.favs) return;
    var on = App.favs.toggle(S.item);
    App.toast(on ? '★ Canal favoritado' : 'Removido dos favoritos');
    if (S.plist) S.plist.refreshAll();
    showUI();
  }

  function togglePanel(on) {
    if (!S || !S.chans || !S.plist) return;
    S.panel = !!on;
    cls('panel', !!on);
    cls('ui', true);
    clearTimeout(S.uiT);
    if (on) {
      S.plist.setItems(S.chans.items);
      S.plist.setIdx(S.chans.index);
      S.plist.scrollTo(S.chans.index);
      S.plist.render();
      S.plist.focus();
    } else {
      S.plist.blur();
      showUI();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Historico e saude                                                   */
  /* ------------------------------------------------------------------ */
  function saveHist(done) {
    if (!S || !App.hist) return;
    var pos = S.pos / 1000, dur = S.dur / 1000;
    if (S.live) return App.hist.record(S.item, null, 0, 0);
    if (pos < 10 && !done) return;
    if (!done && dur > 0 && pos / dur > 0.95) {
      return App.hist.record(S.item, S.ep, dur, dur);
    }
    App.hist.record(S.item, S.ep, done ? dur : pos, dur);
  }

  function notePlayback(okPlay) {
    if (!S || !S.live || !App.health) return;
    var slow = false;
    try { slow = !!(S.t0 && (Date.now() - S.t0) > (App.health.cfg ? App.health.cfg.playbackSlow : 3000)); } catch (e) { slow = false; }
    if (okPlay) {
      if (S.okLogged) return;
      S.okLogged = true;
      try { App.health.playback(S.item, true, slow); } catch (e2) { /* ignore */ }
    } else {
      if (S.failLogged) return;
      S.failLogged = true;
      try { App.health.playback(S.item, false); } catch (e3) { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Teclado (recebido pelo App.nav do shell)                            */
  /* ------------------------------------------------------------------ */
  function onKey(a) {
    if (!S) return true;
    if (a && a.length === 2 && a.charAt(0) === 'n' && a !== 'n0') {
      if (S.live) jumpFav(+a.charAt(1));
      return true;
    }
    if (S.blocked && (a === 'ok' || a === 'play' || a === 'playpause')) { resumePlayback(); return true; }
    if (S.failed && (a === 'ok' || a === 'play')) { retry(); return true; }
    if (S.panel) {
      if (a === 'back' || a === 'left') { togglePanel(false); return true; }
      if (a === 'ok') { zapTo(S.plist.idx); togglePanel(false); return true; }
      if (a === 'up' || a === 'down') { S.plist.key(a); return true; }
      return true;
    }
    switch (a) {
      case 'back': case 'stop': case 'exit': close(); break;
      case 'ok':
        if (S.blocked) { resumePlayback(); }
        else if (S.live) { togglePanel(true); }
        else { pauseToggle(); }
        break;
      case 'play':
        if (S.blocked) resumePlayback();
        else if (S.paused) pauseToggle();
        else showUI();
        break;
      case 'pause': if (!S.paused) pauseToggle(); break;
      case 'playpause':
        if (S.blocked) resumePlayback();
        else pauseToggle();
        break;
      case 'left': if (S.live) showUI(); else seekBy(-10); break;
      case 'right': if (S.live) togglePanel(true); else seekBy(10); break;
      case 'rw': seekBy(-30); break;
      case 'ff': seekBy(30); break;
      case 'up': case 'chdown': if (S.live) zap(-1); else showUI(); break;
      case 'blue': swapPrev(); break;
      case 'down': case 'chup': if (S.live) zap(1); else showUI(); break;
      case 'info': showUI(); break;
      case 'yellow': case 'hold': toggleFav(); break;
      case 'mute': case 'm': toggleMute(); break;
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Ciclo de vida                                                       */
  /* ------------------------------------------------------------------ */
  /* o: {item, list, ep, urls, live, startAt, chans:{items,index}, onClose, title(item), sub(item)} */
  function play(o) {
    build();
    if (S) close(true);
    o = o || {};
    var urls = [], raw = o.urls || [], i;
    if (raw && typeof raw.length === 'number') {
      for (i = 0; i < raw.length; i++) if (typeof raw[i] === 'string' && raw[i]) urls.push(raw[i]);
    }
    S = {
      item: o.item, list: o.list, ep: o.ep || null, urls: urls, urlIdx: 0,
      live: !!o.live, startAt: o.startAt || 0,
      title: o.title || function (it) { return it && it.n; }, sub: o.sub,
      chans: o.chans || null, onClose: o.onClose,
      tok: 0, zapTok: 0, retries: 0, failTok: 0,
      pos: 0, dur: 0, paused: false, panel: false, seeking: null,
      blocked: false, failed: false, engine: null, engineUrl: '', playUrl: '',
      hls: null, mpegts: null, video: null,
      uiT: 0, saveT: 0, retryT: 0, seekT: 0, prepT: 0, clickT: 0, wheelT: 0,
      t0: Date.now(), okLogged: false, failLogged: false, navPushed: false
    };
    if (S.live && App.resume) App.resume.set(S.item);
    if (S.chans && !E.plistObj && App.VList) {
      E.plistObj = new App.VList({
        root: E.plist, cols: 1, rowH: 72, empty: '',
        render: function (it, idx, cell) {
          var d = mk('div', 'pl-chan' + (S && S.item === it ? ' cur' : ''));
          var lg = mk('div', 'logo');
          if (it && /^https?:\/\//i.test(it.l || '')) {
            var im = document.createElement('img');
            im.src = it.l;
            im.alt = '';
            im.onerror = function () { if (im.parentNode) im.parentNode.removeChild(im); };
            lg.appendChild(im);
          }
          d.appendChild(lg);
          d.appendChild(mk('div', 'nm', it && it.n));
          var nf = App.favs ? App.favs.num(it) : 0;
          if (nf) d.appendChild(mk('span', 'favnum sm', String(nf)));
          cell.appendChild(d);
          cell.setAttribute('role', 'option');
          cell.setAttribute('aria-selected', S && S.item === it ? 'true' : 'false');
        },
        onSelect: function (it, idx) { zapTo(idx); togglePanel(false); }
      });
    }
    S.plist = E.plistObj;
    if (S.plist) {
      S.plist.o.onSelect = function (it, idx) { zapTo(idx); togglePanel(false); };
    }
    document.documentElement.classList.add('playing');
    document.body.classList.add('playing');
    cls('open', true);
    cls('panel', false);
    cls('err', false);
    cls('busy', false);
    cls('blocked', false);
    setProgMode(!S.live);
    syncMute();
    syncPip();
    if (App.nav && App.nav.push) { App.nav.push(layer); S.navPushed = true; }
    if (App.health) { try { App.health.pause(); } catch (e) { /* ignore */ } }
    setHeader();
    showUI();
    saveHist(false);
    S.saveT = setInterval(function () { saveHist(false); }, SAVE_MS);
    if (!S.urls.length) { showNoUrls(); return; }
    startEngine();
  }

  function close(silent) {
    if (!S) return;
    var s = S;
    saveHist(false);
    clearInterval(s.saveT);
    clearTimeout(s.uiT);
    clearTimeout(s.retryT);
    clearTimeout(s.seekT);
    clearTimeout(s.prepT);
    clearTimeout(s.clickT);
    s.tok = ++tokSeq;
    stopEngine();
    S = null;
    cls('open', false);
    cls('ui', false);
    cls('busy', false);
    cls('err', false);
    cls('panel', false);
    cls('blocked', false);
    document.documentElement.classList.remove('playing');
    document.body.classList.remove('playing');
    try { E.startBtn.blur(); } catch (e) { /* ignore */ }
    if (!silent) {
      try {
        var on = document.fullscreenElement || document.webkitFullscreenElement;
        var ex = document.exitFullscreen || document.webkitExitFullscreen;
        if (on && ex) {
          var fp = ex.call(document);
          if (fp && fp.catch) fp.catch(function () { /* ignore */ });
        }
      } catch (e2) { /* ignore */ }
    }
    if (document.pictureInPictureElement) {
      try {
        var pp = document.exitPictureInPicture();
        if (pp && pp.catch) pp.catch(function () { /* ignore */ });
      } catch (e3) { /* ignore */ }
    }
    syncMute();
    syncPip();
    syncFullscreen();
    if (App.health) { try { App.health.resume(); } catch (e4) { /* ignore */ } }
    if (s.navPushed && App.nav && App.nav.pop) { try { App.nav.pop(layer); } catch (e5) { /* ignore */ } }
    if (!silent && s.onClose) {
      try { s.onClose(s); } catch (e6) { App.log('player: onClose falhou'); }
    }
  }

  App.player = {
    play: play,
    close: close,
    isOpen: function () { return !!S; }
  };
})(window);
