/* Reproducao: o video e nativo (ExoPlayer) desenhado ATRAS da pagina; o WebView fica
   transparente e desenha os controles por cima. O JS cuida de URLs, historico,
   retomada, favoritos, controle parental e MultiView - o Java so toca o stream. */
(function (g) {
  'use strict';
  var App = g.App;
  var N = g.SpaceNative;
  var U = App.m.ui;
  App.m = App.m || {};

  var root = document.getElementById('player');
  var stage = root.querySelector('.stage');
  var slotEl = [root.querySelector('[data-slot="0"]'), root.querySelector('[data-slot="1"]')];
  var noteEl = root.querySelector('.p-note');
  var bufEl = root.querySelector('.buffering');
  var T = {
    pos: root.querySelector('[data-t="pos"]'),
    dur: root.querySelector('[data-t="dur"]'),
    seek: root.querySelector('[data-t="seek"]')
  };
  var actionsBox = root.querySelector('.p-actions');

  var S = {
    open: false,
    item: null,
    list: null,
    ep: null,
    urls: [],
    live: true,
    playing: false,
    confirmed: false,
    pos: 0,
    dur: 0,
    startedAt: 0,
    recordedAt: 0,
    chans: [],
    multi: false,
    layoutMode: 'split',
    second: null,
    audio: 0,
    aspect: 0,
    hideT: null,
    dragging: false
  };

  /* ------------------------------------------------------------- helpers --- */
  function call(fn) { try { fn(); } catch (e) { App.native.log('player: ' + (e && e.message)); } }

  function showNote(msg) {
    noteEl.textContent = msg;
    noteEl.className = 'p-note on';
    setTimeout(function () { noteEl.className = 'p-note'; }, 6000);
  }

  function showCtl(sticky) {
    root.classList.add('show-ctl');
    clearTimeout(S.hideT);
    if (!sticky && S.playing) {
      S.hideT = setTimeout(function () { root.classList.remove('show-ctl'); }, 4200);
    }
  }

  function toggleCtl() {
    if (root.classList.contains('show-ctl')) {
      root.classList.remove('show-ctl');
      clearTimeout(S.hideT);
    } else {
      showCtl();
    }
  }

  function catName(t, id) {
    var a = (App.catalog.data.cats || {})[t] || [], i;
    for (i = 0; i < a.length; i++) if (a[i].id === id) return a[i].name;
    return '';
  }

  function subtitle() {
    var it = S.item;
    if (!it) return '';
    if (S.ep) {
      return (S.ep.s ? 'Temporada ' + S.ep.s + ' • ' : '') + (S.ep.e ? 'Episódio ' + S.ep.e : '') +
        (S.ep.title ? ' — ' + S.ep.title : '');
    }
    var bits = [];
    if (it.t === 'live') {
      bits.push('AO VIVO');
      var c = catName('live', it.c);
      if (c) bits.push(c);
    } else {
      if (it.y) bits.push(it.y);
      if (it.r) bits.push('★ ' + it.r);
      if (it.g) bits.push(it.g);
    }
    return bits.join(' • ');
  }

  /* -------------------------------------------------------------- layout --- */
  function applyRect(slot, r) {
    var el = slotEl[slot];
    if (!el) return;
    el.style.left = (r.x || 0) + 'px';
    el.style.top = (r.y || 0) + 'px';
    el.style.width = (r.w || 0) + 'px';
    el.style.height = (r.h || 0) + 'px';
    el.classList.toggle('hide', !(r.w > 0 && r.h > 0));
    if (!N) return;
    var d = g.devicePixelRatio || 1;
    call(function () {
      N.playerBounds(slot, Math.round((r.x || 0) * d), Math.round((r.y || 0) * d),
        Math.round((r.w || 0) * d), Math.round((r.h || 0) * d));
    });
  }

  function layout() {
    var W = g.innerWidth, H = g.innerHeight, r0, r1;
    if (!S.multi) {
      r0 = { x: 0, y: 0, w: W, h: H };
      r1 = { w: 0, h: 0 };
    } else if (S.layoutMode === 'pip') {
      var pw = Math.round(Math.min(W * 0.44, 420));
      var ph = Math.round(pw * 9 / 16);
      r0 = { x: 0, y: 0, w: W, h: H };
      r1 = { x: W - pw - 12, y: Math.max(70, H - ph - 78), w: pw, h: ph };
      slotEl[1].classList.add('pip');
    } else {
      var half = Math.floor(W / 2);
      r0 = { x: 0, y: 0, w: half - 1, h: H };
      r1 = { x: half + 1, y: 0, w: W - half - 1, h: H };
      slotEl[1].classList.remove('pip');
    }
    if (!S.multi) slotEl[1].classList.remove('pip');
    applyRect(0, r0);
    applyRect(1, r1);
  }

  /* ---------------------------------------------------------- controles --- */

  function chipBtn(act, label, on) {
    var b = App.el('button', 'chip' + (on ? ' on' : ''), label);
    b.setAttribute('data-act', act);
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      act_click(act);
    });
    return b;
  }

  function paintActions() {
    App.clear(actionsBox);

    if (S.live) actionsBox.appendChild(chipBtn('list', 'Canais'));

    if (S.live && !S.multi) {
      actionsBox.appendChild(chipBtn('multi', 'MultiView'));
    }

    if (S.multi) {
      actionsBox.appendChild(chipBtn('layout', S.layoutMode === 'pip' ? 'Janela' : 'Tela dividida'));
      actionsBox.appendChild(chipBtn('audio', 'Áudio: ' + (S.audio === 0 ? 'principal' : '2º')));
      actionsBox.appendChild(chipBtn('close2', 'Fechar 2º'));
    }

    actionsBox.appendChild(chipBtn('aspect',
      ['Ajustar', 'Preencher', 'Esticar'][S.aspect] || 'Ajustar'));

    var grow = App.el('span', 'grow');
    actionsBox.appendChild(grow);

    if (S.live) {
      actionsBox.appendChild(chipBtn('prev', '◀ Canal'));
      actionsBox.appendChild(chipBtn('next', 'Canal ▶'));
    }
  }

  function showEl(node, on) {
    if (node) node.style.display = on ? '' : 'none';
  }

  function paintHeader() {
    var it = S.item;
    root.querySelector('.p-top .n').textContent = it ? (it.n || 'Canal') : '';
    root.querySelector('.p-top .s').textContent = subtitle();
    var fav = root.querySelector('[data-act="fav"]');
    fav.innerHTML = U.ico('star');
    fav.classList.toggle('star', true);
    fav.classList.toggle('on', !!(it && App.favs.has(it)));
    fav.style.color = (it && App.favs.has(it)) ? '#ffcf5c' : '';

    /* Só os botoes fixos do meio: o chip "Canais" e criado por paintActions() e pode
       nao existir (filme/serie), por isso a busca fica restrita ao .p-mid. */
    var isLive = !!S.live;
    showEl(root.querySelector('.p-mid [data-act="prev"]'), isLive);
    showEl(root.querySelector('.p-mid [data-act="next"]'), isLive);
    showEl(root.querySelector('.p-mid [data-act="rw"]'), !isLive);
    showEl(root.querySelector('.p-mid [data-act="ff"]'), !isLive);
    showEl(T.seek.parentNode, !isLive);

    root.querySelector('[data-act="toggle"]').innerHTML = U.ico(S.playing ? 'pause' : 'play');

    /* Dica das teclas do controle: muda conforme o tipo de conteudo. */
    var hint = root.querySelector('.p-hint');
    if (hint) {
      hint.textContent = isLive
        ? 'OK mostra os controles · ▲ ▼ troca de canal · ◀ ▶ canal anterior/próximo · Voltar sai'
        : 'OK mostra os controles · ◀ ▶ avança/volta 10s · Voltar sai';
    }
  }

  /* Icones dos botoes fixos (voltar, canal anterior/proximo, ±10s). Eles nasciam
     vazios no HTML: os botoes apareciam como circulos em branco. Uma vez so. */
  function initIcons() {
    ['back', 'prev', 'next', 'rw', 'ff'].forEach(function (act) {
      var b = root.querySelector('[data-act="' + act + '"]');
      if (b) b.innerHTML = U.ico(act);
    });
  }

  /* Preenchimento da barra: a trilha e desenhada pelo CSS com um gradiente que termina
     em --p (0..1). Sai do valor do proprio input, entao acompanha a reproducao, o arrasto
     e os botoes de +/-10s sem tocar no calculo do tempo nem no indicador. */
  function paintFill() {
    var v = Number(T.seek.value) / 1000;
    if (!isFinite(v) || v < 0) v = 0;
    else if (v > 1) v = 1;
    T.seek.style.setProperty('--p', v.toFixed(4));
  }

  function paintTime() {
    T.pos.textContent = App.fmtTime(S.pos / 1000);
    T.dur.textContent = S.dur ? App.fmtTime(S.dur / 1000) : (S.live ? 'AO VIVO' : '--:--');
    if (!S.dragging && S.dur > 0) {
      T.seek.value = String(Math.round((S.pos / S.dur) * 1000));
    }
    paintFill();
  }

  /* ------------------------------------------------------------ fluxo --- */

  function open(item, opts) {
    opts = opts || {};
    if (!item) return;
    var list = opts.list || App.lists.active();
    if (!list) {
      App.toast('Adicione uma lista para começar');
      if (App.m.shell) App.m.shell.go('settings');
      return;
    }
    if (!App.isOnline()) {
      App.toast('Sem conexão com a internet');
      return;
    }

    App.parental.guard(item).then(function (ok) {
      if (!ok) return;
      S.chans = opts.chans || (item.t === 'live' ? App.catalog.items('live', item.c) : []);
      start(item, list, opts.ep || null);
    });
  }

  function start(item, list, ep) {
    S.open = true;
    S.item = item;
    S.list = list;
    S.ep = ep;
    S.live = item.t === 'live';
    S.urls = [];
    S.playing = false;
    S.confirmed = false;
    S.pos = 0;
    S.dur = 0;
    S.startedAt = Date.now();
    S.recordedAt = 0;
    S.multi = false;
    S.second = null;
    S.audio = 0;
    S.layoutMode = 'split';

    root.classList.add('on');
    root.classList.remove('multi');
    document.documentElement.classList.add('playing');
    slotEl[1].classList.add('hide');

    App.native.webTransparent(true);
    App.native.orientation('landscape');
    App.native.immersive(true);
    App.native.keepAwake(true);
    App.health.pause();

    bufEl.classList.add('on');
    noteEl.className = 'p-note';
    paintHeader();
    paintActions();
    paintTime();
    layout();
    showCtl(true);
    /* Com controle remoto o anel nasce no play/pause: sem isso o primeiro OK
       cairia no botao "voltar" (primeiro do DOM) e fecharia o video. */
    if (App.m.focus) {
      App.m.focus.clear();
      if (App.m.tv || document.documentElement.classList.contains('kbd')) {
        setTimeout(function () {
          if (S.open && App.m.focus) App.m.focus.to(root.querySelector('[data-act="toggle"]'));
        }, 280);
      }
    }

    App.catalog.urls(item, list, ep).then(function (urls) {
      if (!S.open || S.item !== item) return;
      S.urls = urls || [];
      if (!S.urls.length) return fail({ code: 'format' }, 0);
      var startMs = 0;
      if (!S.live) {
        var h = App.hist.get(item);
        if (h && h.pos > 10000 && (!h.dur || h.pos / h.dur < 0.95)) startMs = h.pos;
      }
      if (N) call(function () { N.playerOpen(0, JSON.stringify(S.urls), S.live, startMs); });
      layout();
    }, function (e) {
      fail({ code: (e && e.code) || 'network' }, 0);
    });
  }

  function fail(ev, slot) {
    if (slot === 1) {
      closeSecond();
      showNote('Este aparelho não abriu o segundo canal. A reprodução normal continua.');
      return;
    }
    S.playing = false;
    S.confirmed = false;
    bufEl.classList.remove('on');
    if (S.item) App.health.playback(S.item, false);
    root.querySelector('[data-act="toggle"]').innerHTML = U.ico('play');
    showCtl(true);

    var MSG = {
      timeout: 'O servidor demorou demais para responder.',
      http: 'O servidor recusou o pedido (erro HTTP).',
      codec: 'Este aparelho não suporta o formato de vídeo deste arquivo.',
      format: 'O formato deste arquivo não é suportado.',
      network: 'Não foi possível acessar o servidor.',
      play: 'Não foi possível reproduzir.',
      unknown: 'Não foi possível reproduzir.'
    };
    /* Ao vivo e filme falham por motivos diferentes: a dica muda junto. */
    var dica = S.live
      ? 'O canal pode estar offline neste momento.'
      : 'O provedor pode estar com o servidor de filmes fora do ar ou o arquivo ter sido removido.';
    var tecnico = ev && ev.detail ? '\n\nDetalhe técnico: ' + String(ev.detail).replace(/^ERROR_CODE_|^ERROR_CODE_IO_/, '') : '';

    U.dialog({
      title: 'Falha ao reproduzir',
      msg: (MSG[ev.code] || MSG.play) + '\n\n' + dica + tecnico,
      actions: [
        { id: 'close', label: 'Voltar' },
        { id: 'retry', label: 'Tentar de novo', kind: 'primary' }
      ]
    }).then(function (r) {
      if (r.action === 'retry') {
        S.confirmed = false;
        S.startedAt = Date.now();
        bufEl.classList.add('on');
        if (N) call(function () { N.playerOpen(0, JSON.stringify(S.urls), S.live, 0); });
      }
    });
  }

  function close() {
    if (!S.open) return;
    if (S.item && !S.live && S.pos > 0) App.hist.record(S.item, S.ep, S.pos, S.dur);
    S.open = false;
    /* a folha de canais / dialogo de erro do player nao pode sobreviver a saida */
    if (App.m.ui && App.m.ui.closeTop) {
      var guard = 0;
      while (App.m.ui.closeTop() && guard++ < 12) { /* ignore */ }
    }
    if (N) {
      call(function () { N.playerClose(1); });
      call(function () { N.playerClose(0); });
    }
    root.classList.remove('on', 'show-ctl', 'multi');
    document.documentElement.classList.remove('playing');
    App.native.webTransparent(false);
    App.native.orientation('auto');
    App.native.immersive(false);
    App.native.keepAwake(false);
    App.health.resume();
    clearTimeout(S.hideT);
    S.item = null;
    S.ep = null;
    S.urls = [];
    S.chans = [];
    S.multi = false;
    S.second = null;
    if (App.m.focus) App.m.focus.reset(120);
    if (App.m.shell) App.m.shell.refreshTitle();
  }

  function toggle() {
    if (!S.open) return;
    if (N) call(function () { N.playerToggle(0); });
    showCtl();
  }

  function zapTo(item) {
    if (!item || !S.live) return;
    App.parental.guard(item).then(function (ok) {
      if (!ok) return;
      start(item, S.list, null);
    });
  }

  function zap(delta) {
    if (!S.live || !S.chans.length) return;
    var i = S.chans.indexOf(S.item);
    if (i < 0) i = 0;
    i = (i + delta + S.chans.length) % S.chans.length;
    zapTo(S.chans[i]);
  }

  function openSecond(item) {
    if (!item || !S.live) return;
    App.parental.guard(item).then(function (ok) {
      if (!ok) return;
      App.catalog.urls(item, S.list, null).then(function (urls) {
        if (!S.open || !urls || !urls.length) return;
        S.second = item;
        S.multi = true;
        S.layoutMode = 'split';
        root.classList.add('multi');
        paintActions();
        layout();
        if (N) {
          call(function () { N.playerOpen(1, JSON.stringify(urls), true, 0); });
          call(function () { N.playerAudio(0); });
        }
        showNote('Segundo canal: ' + (item.n || '') + '. Toque em Áudio para trocar o som.');
      }, function () {
        showNote('Não foi possível abrir o segundo canal.');
      });
    });
  }

  function closeSecond() {
    S.multi = false;
    S.second = null;
    S.audio = 0;
    root.classList.remove('multi');
    if (N) {
      call(function () { N.playerClose(1); });
      call(function () { N.playerAudio(0); });
    }
    paintActions();
    layout();
  }

  /* ------------------------------------------------------------- acoes --- */
  function act_click(act) {
    if (act === 'list') return openChannelSheet(0);
    if (act === 'multi') return openChannelSheet(1);
    if (act === 'layout') {
      S.layoutMode = S.layoutMode === 'pip' ? 'split' : 'pip';
      layout();
      paintActions();
      return;
    }
    if (act === 'audio') {
      S.audio = S.audio === 0 ? 1 : 0;
      if (N) call(function () { N.playerAudio(S.audio); });
      paintActions();
      return;
    }
    if (act === 'close2') return closeSecond();
    if (act === 'aspect') {
      S.aspect = (S.aspect + 1) % 3;
      if (N) {
        call(function () { N.playerAspect(0, S.aspect); });
        call(function () { N.playerAspect(1, S.aspect); });
      }
      paintActions();
      return;
    }
    if (act === 'prev') return zap(-1);
    if (act === 'next') return zap(1);
    if (act === 'rw') return seekBy(-10);
    if (act === 'ff') return seekBy(10);
  }

  function seekBy(sec) {
    if (S.live) return;
    var to = Math.max(0, S.pos + sec * 1000);
    if (N) call(function () { N.playerSeek(0, to); });
    S.pos = to;
    paintTime();
    showCtl();
  }

  /* ------------------------------------------------- teclas do controle --- */
  /* Chamada pelo focus.js quando o player esta aberto. Com os controles a vista,
     as setas navegam entre os botoes (devolve false e a navegacao generica cuida);
     com os controles escondidos, as setas agem direto, como num controle de TV. */
  function tecla(e) {
    if (!S.open) return false;
    var code = e.keyCode || 0, key = e.key || '';
    var visivel = root.classList.contains('show-ctl');

    var dir = (code === 37 || key === 'ArrowLeft') ? 'left'
      : (code === 39 || key === 'ArrowRight') ? 'right'
        : (code === 38 || key === 'ArrowUp') ? 'up'
          : (code === 40 || key === 'ArrowDown') ? 'down' : null;
    var ok = code === 13 || code === 23 || code === 32 || key === 'Enter' || key === ' ';

    if (visivel) {
      if (dir || ok) showCtl();     /* rearma o tempo de esconder */
      return false;
    }

    if (ok) { showCtl(true); return true; }

    if (dir === 'up' || dir === 'down') {
      if (!S.live) return false;
      zap(dir === 'up' ? -1 : 1);
      return true;
    }
    if (dir === 'left' || dir === 'right') {
      if (!S.live) { seekBy(dir === 'left' ? -10 : 10); return true; }
      zap(dir === 'left' ? -1 : 1);
      return true;
    }
    return false;
  }

  /* Painel de canais (folha inferior) usado para trocar e para o MultiView. */
  function openChannelSheet(target) {
    var cats = App.parental.filterCats('live');
    var cur = '*';
    var sheet = U.sheet({
      title: target === 1 ? 'Escolher o segundo canal' : 'Canais',
      build: function (body, close) {
        var chips = U.chips([{ id: '*', name: 'Todos' }].concat(cats), cur, function (c) {
          cur = c.id;
          repaintChips();
          paint();
        });
        body.appendChild(chips);

        var host = App.el('div');
        host.style.flex = '1';
        host.style.minHeight = '0';
        body.appendChild(host);

        function repaintChips() {
          var on = chips.querySelectorAll('.chip');
          for (var i = 0; i < on.length; i++) {
            var isOn = (i === 0 && cur === '*') || (on[i].textContent === catName('live', cur));
            on[i].classList.toggle('on', isOn);
          }
        }

        function paint() {
          var items = App.catalog.items('live', cur);
          if (!items.length) {
            App.clear(host);
            host.appendChild(U.empty('Nada por aqui', 'Nenhum canal nesta categoria.'));
            return;
          }
          U.vscroll(host, {
            count: items.length,
            rowH: U.rowH(76),
            render: function (i) {
              var it = items[i];
              return U.channelRow(it, {
                list: App.lists.active(),
                category: catName('live', it.c),
                onOpen: function (x) {
                  close();
                  if (target === 1) openSecond(x);
                  else zapTo(x);
                }
              });
            }
          });
        }

        paint();
      }
    });
    return sheet;
  }

  /* ------------------------------------------------------- eventos nativos --- */
  function onEvent(ev) {
    if (!ev || !ev.type) return;
    var slot = ev.slot || 0;

    if (ev.type === 'insets') {
      App.m.applyInsets(ev);
      if (S.open) layout();
      return;
    }

    if (slot === 1 && ev.type !== 'progress') {
      /* erros do segundo canal nao interrompem a reproducao principal */
      if (ev.type === 'error') fail(ev, 1);
      return;
    }

    switch (ev.type) {
      case 'state':
        if (ev.state === 'buffering') {
          bufEl.classList.add('on');
        } else {
          bufEl.classList.remove('on');
        }
        if (ev.state === 'ready' && !S.confirmed) confirmPlayback();
        if (ev.state === 'ended' && !S.live) showCtl(true);
        break;

      case 'playing':
        S.playing = !!ev.playing;
        root.querySelector('[data-act="toggle"]').innerHTML = U.ico(S.playing ? 'pause' : 'play');
        if (S.playing) showCtl();
        break;

      case 'progress':
        S.pos = ev.pos || 0;
        S.dur = ev.dur || 0;
        paintTime();
        if (S.playing && !S.confirmed) confirmPlayback();
        recordProgress();
        break;

      case 'error':
        fail(ev, 0);
        break;

      case 'retry':
        if (slot === 0) showNote(ev.reason === 'reconnect' ? 'Reconectando…' : 'Tentando outra URL do canal…');
        break;

      case 'audio':
        S.audio = ev.audio || 0;
        paintActions();
        break;

      /* teclas de midia que o Android traduziu para acoes (ver MainActivity) */
      case 'key':
        if (ev.key === 'toggle') toggle();
        else if (ev.key === 'play') { if (N) call(function () { N.playerPlay(0); }); }
        else if (ev.key === 'pause') { if (N) call(function () { N.playerPause(0); }); }
        else if (ev.key === 'next' || ev.key === 'zapdown') { if (S.live) zap(1); }
        else if (ev.key === 'prev' || ev.key === 'zapup') { if (S.live) zap(-1); }
        break;
    }
  }

  function confirmPlayback() {
    S.confirmed = true;
    bufEl.classList.remove('on');
    if (!S.item) return;
    var slow = Date.now() - S.startedAt > 4000;
    if (S.live) {
      App.health.playback(S.item, true, slow);
      App.resume.set(S.item);
    }
    S.playing = true;
    root.querySelector('[data-act="toggle"]').innerHTML = U.ico('pause');
    showCtl();
  }

  function recordProgress() {
    if (!S.open || !S.item || S.live) return;
    var now = Date.now();
    if (now - S.recordedAt < 15000) return;
    S.recordedAt = now;
    App.hist.record(S.item, S.ep, S.pos, S.dur);
  }

  /* ------------------------------------------------------------- ligacao --- */
  initIcons();
  g.SpacePlayer = { onEvent: onEvent };

  root.querySelector('[data-act="back"]').addEventListener('click', function (e) {
    e.stopPropagation();
    close();
  });
  root.querySelector('[data-act="fav"]').addEventListener('click', function (e) {
    e.stopPropagation();
    if (!S.item) return;
    var on = App.favs.toggle(S.item);
    this.classList.toggle('on', on);
    this.style.color = on ? '#ffcf5c' : '';
    App.toast(on ? 'Adicionado aos favoritos' : 'Removido dos favoritos', 1500);
    paintActions();
  });
  root.querySelector('[data-act="toggle"]').addEventListener('click', function (e) {
    e.stopPropagation();
    toggle();
  });
  root.querySelector('[data-act="prev"]').addEventListener('click', function (e) { e.stopPropagation(); zap(-1); });
  root.querySelector('[data-act="next"]').addEventListener('click', function (e) { e.stopPropagation(); zap(1); });
  root.querySelector('[data-act="rw"]').addEventListener('click', function (e) { e.stopPropagation(); seekBy(-10); });
  root.querySelector('[data-act="ff"]').addEventListener('click', function (e) { e.stopPropagation(); seekBy(10); });

  T.seek.addEventListener('input', function () {
    S.dragging = true;
    var pct = Number(T.seek.value) / 1000;
    T.pos.textContent = App.fmtTime((S.dur * pct) / 1000);
    paintFill();   // o preenchimento acompanha o dedo durante o arrasto
  });
  T.seek.addEventListener('change', function () {
    S.dragging = false;
    var pct = Number(T.seek.value) / 1000;
    if (N) call(function () { N.playerSeek(0, Math.round(S.dur * pct)); });
  });

  stage.addEventListener('click', function () { toggleCtl(); });
  g.addEventListener('resize', function () { if (S.open) layout(); });
  g.addEventListener('orientationchange', function () {
    setTimeout(function () { if (S.open) layout(); }, 260);
  });

  App.m.player = {
    open: open,
    close: close,
    isOpen: function () { return S.open; },
    key: tecla,
    zap: zap,
    zapTo: zapTo,
    layout: layout,
    state: function () { return S; }
  };
})(window);
