/* Tela Guia do Space IPTV Desktop: overlay em tela cheia com timeline por canal/horário.
 *
 * Contrato: App.desktop.guide = { open(list?), close(), isOpen() }.
 * - Grade virtualizada: so as linhas de canais visiveis existem no DOM; os programas de uma
 *   linha sao carregados sob demanda de epg.js (blocos do IndexedDB), nunca o XMLTV inteiro.
 * - Teclado: setas (canal/tempo), Enter = detalhe do programa, Esc/back = fecha.
 * - Mouse: roda/arrasto rolam a grade; clique no programa abre o detalhe.
 * - aria (grid/gridcell, dialog, status), foco visivel, prefers-reduced-motion no CSS.
 */
(function (g) {
  'use strict';
  var App = g.App;
  if (!App || !App.epg) return;
  var doc = g.document;
  if (!doc) return;
  App.desktop = App.desktop || {};
  if (App.desktop.guide && App.desktop.guide.__guideV1) return;

  var MIN = 30 * 60 * 1000;          /* coluna = 30 minutos */
  var COLS = 24;                     /* janela = 12 horas */
  var COL_W = 180;
  var ROW_H = 72;
  var HEAD_H = 52;
  var CHAN_W = 300;
  var RANGE = COLS * MIN;
  var PX_PER_MS = COL_W / MIN;
  var VIS_BUFFER = 2;

  var gd = null;

  /* --------------------------------------------------------------- helpers */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmm(ts) { var d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function dayLabel(ts) {
    var txt;
    try {
      txt = new Date(ts).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
    } catch (e) {
      var d = new Date(ts);
      txt = pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
    }
    return txt.charAt(0).toUpperCase() + txt.slice(1);   /* "sábado..." -> "Sábado..." */
  }
  function shortDay(ts) { var d = new Date(ts); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1); }
  function floor30(ts) {
    var d = new Date(ts);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() < 30 ? 0 : 30);
    return d.getTime();
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function durMin(pr) { return Math.max(1, Math.round((pr.e - pr.s) / 60000)); }
  function activeList() { return App.lists && typeof App.lists.active === 'function' ? App.lists.active() : null; }
  function stateOf() { return App.epg.state(); }

  function button(label, cls, onClick) {
    var b = doc.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + (cls || '');
    b.textContent = label;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  /* ------------------------------------------------------------- estado UI */
  function guideState() {
    return {
      list: null, overlay: null, panel: null, body: null, statusEl: null,
      closeFn: null, opener: null,
      scroll: null, timeTrack: null, chanInner: null, rowsInner: null, nowLine: null,
      rows: [], rowData: {}, rowP: {}, rowEls: {}, chanEls: {},
      focusRow: 0, focusTs: 0,
      rangeStart: 0, rangeEnd: 0,
      sig: '', view: '',
      detailClose: null, detailEl: null,
      timer: null, raf: 0, subs: [], drag: null
    };
  }

  /* --------------------------------------------------------------- acesso */
  function open(list) {
    if (gd) {
      if (!list || !gd.list || list.id === gd.list.id) { focusScroll(); return true; }
      close();
    }
    var target = list || activeList();
    var st = guideState();
    st.list = target;
    st.opener = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;

    var ov = App.el('div', 'overlay guide-overlay');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'guide-title');
    var panel = App.el('div', 'guide-panel glass-panel');
    var head = App.el('div', 'guide-head');
    var titleBox = App.el('div', 'guide-title-box');
    var h1 = App.el('h1', 'h1 guide-title', 'Guia de programação');
    h1.id = 'guide-title';
    var sub = App.el('div', 'guide-sub');
    sub.textContent = target ? (target.name || 'Lista') + ' · ' + dayLabel(Date.now()) : 'Nenhuma lista ativa';
    titleBox.appendChild(h1); titleBox.appendChild(sub);

    var actions = App.el('div', 'guide-actions');
    var status = App.el('span', 'guide-status hud-caption');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    var refresh = button('Atualizar', 'guide-refresh', function () {
      if (st.list) App.epg.refresh(st.list).then(null, function () { /* status/erro chegam por evento */ });
    });
    refresh.title = 'Atualizar o guia de programação agora';
    var closeBtn = button('Fechar (Esc)', 'primary guide-close', function () { close(); });
    actions.appendChild(status); actions.appendChild(refresh); actions.appendChild(closeBtn);
    head.appendChild(titleBox); head.appendChild(actions);

    var body = App.el('div', 'guide-body');
    var hints = App.el('div', 'guide-hints hud-caption', HINTS_GRID);
    panel.appendChild(head); panel.appendChild(body); panel.appendChild(hints);
    ov.appendChild(panel);

    var layer = { key: function (a) { return key(a); } };
    var closeFn = App.ui.open(ov, layer);
    st.overlay = ov; st.panel = panel; st.body = body; st.hintsEl = hints; st.statusEl = status; st.closeFn = closeFn;
    gd = st;

    subscribe();
    st.timer = setInterval(function () {
      if (!gd) return;
      paintNow();
    }, 60000);

    showForState(stateOf());
    /* carrega/atualiza: usa cache valido na hora e dispara refresh em background se vencido */
    if (target) {
      App.epg.load(target).then(function (s) { if (gd === st) showForState(s); },
        function () { if (gd === st) showForState(stateOf()); });
    }
    return true;
  }

  function close() {
    if (!gd) return false;
    var st = gd;
    gd = null;
    closeDetail();
    clearInterval(st.timer);
    unsubscribe(st);
    try { st.closeFn(); } catch (e) { /* overlay ja removido */ }
    if (st.opener && st.opener.isConnected && typeof st.opener.focus === 'function') {
      try { st.opener.focus(); } catch (e2) { /* ignore */ }
    }
    return true;
  }

  function isOpen() { return !!gd; }

  function focusScroll() {
    if (!gd || !gd.scroll) return;
    try { gd.scroll.focus(); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------- eventos */
  function subscribe() {
    if (!App.bus || typeof App.bus.on !== 'function' || !gd) return;
    var onEpg = function () { if (gd) showForState(stateOf()); };
    var onChunk = function () { if (gd && gd.rows.length) { paintVisibleRows(true); } };
    var onCatalog = function () { if (gd) { gd.sig = ''; showForState(stateOf()); } };
    var onLoading = function () { if (gd) updateStatus(); };
    var subs = gd.subs;
    subs.push(['epg', onEpg], ['epg:done', onEpg], ['epg:error', onEpg],
      ['epg:chunk', onChunk], ['catalog', onCatalog], ['catalog:done', onCatalog], ['epg:loading', onLoading]);
    subs.forEach(function (p) { App.bus.on(p[0], p[1]); });
  }
  function unsubscribe(st) {
    if (!App.bus || typeof App.bus.off !== 'function') return;
    (st.subs || []).forEach(function (p) { App.bus.off(p[0], p[1]); });
    st.subs = [];
  }

  /* ------------------------------------------------------------- estados */
  function clearBody() { if (gd && gd.body) App.clear(gd.body); }

  function setHints(text) {
    if (gd && gd.hintsEl) gd.hintsEl.textContent = text;
  }
  var HINTS_GRID = '◀ ▶ trocar de programa  ·  ▲ ▼ trocar de canal  ·  Enter detalhes  ·  Esc fechar  ·  arraste ou use a roda para rolar';
  var HINTS_MESSAGE = 'Tab navega nos botões  ·  Esc fechar';

  function showMessage(kind, title, msg, opts) {
    if (!gd) return;
    opts = opts || {};
    setHints(HINTS_MESSAGE);
    gd.scroll = null; gd.timeTrack = null; gd.chanInner = null; gd.rowsInner = null;
    gd.rowEls = {}; gd.chanEls = {}; gd.rows = []; gd.rowData = {}; gd.rowP = {};
    clearBody();
    var box = App.el('div', 'guide-empty kind-' + kind);
    box.setAttribute('role', 'group');
    if (kind === 'loading') {
      box.appendChild(App.ui.loading(msg || 'Carregando guia de programação…'));
      gd.body.appendChild(box);
      return;
    }
    if (kind === 'none') box.appendChild(App.el('div', 'guide-empty-badge', 'EPG'));
    box.appendChild(App.el('h2', 'h2 guide-empty-title', title));
    var p = App.el('div', 'guide-empty-msg', msg || '');
    box.appendChild(p);
    if (opts.extra) box.appendChild(App.el('div', 'guide-empty-note body-sm', opts.extra));
    var btns = App.el('div', 'guide-empty-actions');
    if (opts.retry) btns.appendChild(button('Tentar de novo', 'primary', function () { if (gd && gd.list) App.epg.refresh(gd.list).then(null, function () { }); }));
    if (opts.refresh) btns.appendChild(button('Atualizar guia', 'primary', function () { if (gd && gd.list) App.epg.refresh(gd.list).then(null, function () { }); }));
    btns.appendChild(button('Fechar', opts.retry || opts.refresh ? '' : 'primary', function () { close(); }));
    box.appendChild(btns);
    gd.body.appendChild(box);
  }

  function showForState(s) {
    if (!gd) return;
    updateStatus(s);
    if (!s) return;
    if (s.status === 'none') {
      if (gd.view === 'message:none:' + s.listId) return;
      gd.view = 'message:none:' + s.listId;
      showMessage('none', 'Sem guia de programação nesta lista',
        'Esta lista não fornece EPG. Adicione url-tvg ou use Xtream com xmltv.php.',
        { extra: 'No cabeçalho #EXTM3U, use url-tvg="https://…/guia.xml". Em listas Xtream, o guia vem do servidor (xmltv.php).' });
      return;
    }
    if (s.status === 'error') {
      if (gd.view === 'message:error:' + s.listId + ':' + s.error) return;
      gd.view = 'message:error:' + s.listId + ':' + s.error;
      showMessage('error', 'Não foi possível carregar o guia', s.error || 'Tente de novo em instantes.', { retry: true });
      return;
    }
    if (s.status === 'idle' || (s.status === 'loading' && !s.programmeCount)) {
      if (gd.view === 'message:loading') return;
      gd.view = 'message:loading';
      showMessage('loading');
      return;
    }
    if (s.status === 'ready') {
      if (!s.programmeCount) {
        if (gd.view === 'message:nodata:' + s.listId) return;
        gd.view = 'message:nodata:' + s.listId;
        showMessage('nodata', 'Guia sem programas', 'A lista tem EPG configurado, mas nenhum programa foi encontrado no XMLTV.', { refresh: true });
        return;
      }
      var sig = [s.listId, s.fetchedAt, s.programmeCount, s.channelCount, s.from, s.to].join('|');
      if (gd.sig !== sig || !gd.scroll) {
        gd.sig = sig;
        buildGrid(s);
      }
      return;
    }
  }

  function updateStatus(s) {
    if (!gd || !gd.statusEl) return;
    s = s || stateOf();
    var txt = '';
    if (s.status === 'loading' || s.refreshing) {
      txt = s.progress > 0 ? 'Carregando guia… ' + Math.round(s.progress * 100) + '%' : 'Carregando guia…';
    } else if (s.status === 'none') txt = 'Sem EPG nesta lista';
    else if (s.status === 'error') txt = 'Guia indisponível';
    else if (s.status === 'ready') {
      txt = s.channelCount + (s.channelCount === 1 ? ' canal' : ' canais') + ' · ' + s.programmeCount + ' programas';
      if (s.fetchedAt) txt += ' · atualizado ' + hhmm(s.fetchedAt) + ' de ' + shortDay(s.fetchedAt);
      if (s.stale) txt += ' (salvo)';
      if (s.error) txt += ' · última atualização falhou';
    }
    gd.statusEl.textContent = txt;
    gd.statusEl.title = s.error || (s.source ? 'Fonte: ' + s.source : '');
  }

  /* ----------------------------------------------------------- montar grade */
  function buildRows() {
    var out = [];
    var live = (App.catalog && App.catalog.items) ? App.catalog.items('live', '*') : [];
    var listId = stateOf().listId;
    var i, it, ch;
    for (i = 0; i < live.length; i++) {
      it = live[i];
      ch = null;
      try { ch = App.epg.channelOf(it); } catch (e) { ch = null; }
      if (ch && ch.count > 0) out.push({ item: it, id: it.id || ('live-' + i), name: it.n || 'Sem nome', cat: it.c });
    }
    if (!out.length && stateOf().listId === listId) {
      var chans = App.epg.channels();
      for (i = 0; i < chans.length; i++) {
        ch = chans[i];
        out.push({ item: { t: 'live', n: ch.name, ti: ch.id, id: 'epg:' + ch.id }, id: 'epg:' + ch.id, name: ch.name, cat: '' });
      }
    }
    return out;
  }

  function computeRange(s) {
    var now = Date.now();
    var from = s.from || 0, to = s.to || 0;
    var ref = now;
    if (from && to) {
      if (now < from + 5 * 60000) ref = from + 60 * 60000;
      else if (now > to - 10 * 60000) ref = Math.max(from, to - 4 * 3600000);
    } else if (from) ref = Math.max(now, from);
    var start = floor30(ref) - 60 * 60000;
    return { start: start, end: start + RANGE, nowOutside: !!(from && (now < from - 5 * 60000 || now > to + 5 * 60000)) };
  }

  function buildGrid(s) {
    if (!gd) return;
    var rows = buildRows();
    if (!rows.length) {
      showMessage('nodata', 'Nenhum canal com programação', 'O guia tem programas, mas nenhum canal da lista corresponde aos canais do XMLTV (verifique o tvg-id).', { refresh: true });
      return;
    }
    gd.rows = rows;
    gd.rowData = {}; gd.rowP = {}; gd.rowEls = {}; gd.chanEls = {};
    var rg = computeRange(s);
    gd.rangeStart = rg.start; gd.rangeEnd = rg.end;
    var now = Date.now();
    gd.focusTs = clamp(now, rg.start + 1000, rg.end - 1000);
    gd.focusRow = clamp(gd.focusRow, 0, rows.length - 1);

    gd.view = 'grid';
    clearBody();
    setHints(HINTS_GRID);

    var grid = App.el('div', 'guide-grid');
    /* coluna dos canais (sincronizada com o scroll vertical) */
    var chanCol = App.el('div', 'guide-chancol');
    chanCol.style.width = CHAN_W + 'px';
    var chanHead = App.el('div', 'guide-chanhead', 'Canal');
    chanHead.style.height = HEAD_H + 'px';
    chanHead.setAttribute('role', 'columnheader');
    var chanBox = App.el('div', 'guide-chanbox');
    var chanInner = App.el('div', 'guide-chan-inner');
    chanInner.style.height = (rows.length * ROW_H) + 'px';
    chanBox.appendChild(chanInner);
    chanCol.appendChild(chanHead); chanCol.appendChild(chanBox);

    /* area de tempo */
    var timeArea = App.el('div', 'guide-timearea');
    var timeHead = App.el('div', 'guide-timehead');
    timeHead.style.height = HEAD_H + 'px';
    var timeTrack = App.el('div', 'guide-time-track');
    timeTrack.style.width = (COLS * COL_W) + 'px';
    var col;
    for (col = 0; col < COLS; col++) {
      var ts = gd.rangeStart + col * MIN;
      var tick = App.el('div', 'guide-tick');
      tick.style.left = (col * COL_W) + 'px';
      tick.style.width = COL_W + 'px';
      tick.setAttribute('role', 'columnheader');
      tick.setAttribute('aria-label', hhmm(ts));
      var d = new Date(ts);
      var label = hhmm(ts);
      if (d.getHours() === 0 && d.getMinutes() === 0) label = shortDay(ts) + ' ' + label;
      tick.appendChild(App.el('span', 'guide-tick-label', label));
      timeTrack.appendChild(tick);
    }
    timeHead.appendChild(timeTrack);
    var nowFlag = App.el('span', 'guide-now-flag', 'Agora');
    timeTrack.appendChild(nowFlag);

    var scroll = App.el('div', 'guide-scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'grid');
    scroll.setAttribute('aria-label', 'Programação por canal e horário. Use as setas para navegar e Enter para ver detalhes.');
    var inner = App.el('div', 'guide-inner');
    inner.style.width = (COLS * COL_W) + 'px';
    inner.style.height = (rows.length * ROW_H) + 'px';
    var nowLine = App.el('div', 'guide-now-line');
    nowLine.setAttribute('aria-hidden', 'true');
    inner.appendChild(nowLine);
    scroll.appendChild(inner);
    timeArea.appendChild(timeHead); timeArea.appendChild(scroll);
    grid.appendChild(chanCol); grid.appendChild(timeArea);
    gd.body.appendChild(grid);

    /* banner honesto quando o guia salvo nao cobre o horario atual */
    if (rg.nowOutside) {
      var banner = App.el('div', 'guide-banner');
      banner.setAttribute('role', 'status');
      banner.appendChild(App.el('span', null, 'O guia salvo cobre ' + dayLabel(s.from) + ' · ' + hhmm(s.from) + ' a ' + dayLabel(s.to) + ' · ' + hhmm(s.to) + '. '));
      banner.appendChild(button('Atualizar guia', '', function () { if (gd && gd.list) App.epg.refresh(gd.list); }));
      gd.body.insertBefore(banner, grid);
    }

    gd.scroll = scroll; gd.timeTrack = timeTrack; gd.chanInner = chanInner; gd.rowsInner = inner;
    gd.nowLine = nowLine; gd.chanBox = chanBox;

    scroll.addEventListener('scroll', onScroll, { passive: true });
    bindDrag(scroll);
    paintVisibleRows(true);
    paintNow();
    /* posiciona a janela: "agora" a ~1/3 da largura visivel */
    scroll.scrollLeft = Math.max(0, Math.round(pxOf(now) - scroll.clientWidth / 3));
    scroll.scrollTop = Math.max(0, focusRowTop() - 40);
    onScroll();
    updateFocusRowClasses();
    applyFocus();
    focusScroll();
  }

  function pxOf(ts) { return (ts - gd.rangeStart) * PX_PER_MS; }
  function focusRowTop() { return gd.focusRow * ROW_H; }

  /* --------------------------------------------------- virtualizacao linhas */
  function visibleRange() {
    if (!gd || !gd.scroll) return { first: 0, last: -1 };
    var st = gd.scroll.scrollTop;
    var vh = gd.scroll.clientHeight || 600;
    var first = Math.max(0, Math.floor(st / ROW_H) - VIS_BUFFER);
    var last = Math.min(gd.rows.length - 1, Math.ceil((st + vh) / ROW_H) + VIS_BUFFER);
    return { first: first, last: last };
  }

  function paintVisibleRows(force) {
    if (!gd || !gd.scroll) return;
    var rg = visibleRange(), i;
    var keep = {};
    for (i = rg.first; i <= rg.last; i++) keep[i] = true;
    Object.keys(gd.rowEls).forEach(function (k) {
      if (!keep[k]) { removeRow(+k); }
    });
    for (i = rg.first; i <= rg.last; i++) ensureRow(i);
    if (force) {
      for (i = rg.first; i <= rg.last; i++) { if (gd.rowData[i]) paintRow(i); }
    }
    applyFocus();
  }

  function ensureRow(idx) {
    if (!gd || idx < 0 || idx >= gd.rows.length) return;
    var row = gd.rows[idx];
    if (!gd.chanEls[idx]) {
      var cell = App.el('div', 'guide-chan');
      cell.style.top = (idx * ROW_H) + 'px';
      cell.style.height = ROW_H + 'px';
      cell.setAttribute('role', 'rowheader');
      cell.setAttribute('aria-label', row.name);
      var logo = App.el('div', 'guide-chan-logo', (row.name || '?').slice(0, 1).toUpperCase());
      if (row.item && row.item.l) {
        var img = doc.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.src = row.item.l;
        img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
        logo.appendChild(img);
      }
      var nm = App.el('div', 'guide-chan-name', row.name);
      cell.appendChild(logo); cell.appendChild(nm);
      cell.addEventListener('click', function () { gd.focusRow = idx; focusRowInView(); applyFocus(); });
      gd.chanInner.appendChild(cell);
      gd.chanEls[idx] = cell;
    }
    if (!gd.rowEls[idx]) {
      var el = App.el('div', 'guide-row');
      el.style.top = (idx * ROW_H) + 'px';
      el.style.height = ROW_H + 'px';
      el.setAttribute('role', 'row');
      el.setAttribute('aria-label', row.name);
      gd.rowsInner.appendChild(el);
      gd.rowEls[idx] = el;
      if (gd.rowData[idx]) paintRow(idx);
      else ensureRowData(idx);
    }
  }

  function removeRow(idx) {
    var el = gd.rowEls[idx];
    if (el && el.parentNode) el.parentNode.removeChild(el);
    delete gd.rowEls[idx];
    var cell = gd.chanEls[idx];
    if (cell && cell.parentNode) cell.parentNode.removeChild(cell);
    delete gd.chanEls[idx];
  }

  function ensureRowData(idx) {
    if (!gd || gd.rowData[idx] || gd.rowP[idx]) return gd.rowP[idx] || Promise.resolve();
    var row = gd.rows[idx];
    if (!row) return Promise.resolve();
    gd.rowP[idx] = App.epg.programsOf(row.item).then(function (arr) {
      if (!gd || !gd.rows[idx] || gd.rows[idx].id !== row.id) return;
      gd.rowData[idx] = arr || [];
      delete gd.rowP[idx];
      if (gd.rowEls[idx]) paintRow(idx);
      applyFocus();
    }, function () {
      if (gd) { delete gd.rowP[idx]; gd.rowData[idx] = []; }
    });
    return gd.rowP[idx];
  }

  function blockTitle(pr) { return pr.t || 'Sem título'; }

  /* XMLTV "torto" pode ter programas sobrepostos no mesmo canal. A grade nao pode
     desenhar um por cima do outro: segmenta por prioridade (o de inicio maior vence,
     a mesma regra de App.epg.now) e mantem o horario real no aria-label/detalhe. */
  function segmentsOf(arr) {
    var out = [], i, pr, end, next;
    for (i = 0; i < arr.length; i++) {
      pr = arr[i];
      end = pr.e;
      /* divide o programa atual no inicio do proximo que se sobrepoe a ele */
      for (var j = i + 1; j < arr.length && arr[j].s < end; j++) { end = arr[j].s; break; }
      if (end <= pr.s) continue;                 /* totalmente encoberto */
      out.push({ pr: pr, s: pr.s, e: end, cut: end < pr.e });
    }
    return out;
  }

  function paintRow(idx) {
    if (!gd || !gd.rowsInner) return;
    var el = gd.rowEls[idx];
    if (!el) return;
    var arr = gd.rowData[idx] || [];
    App.clear(el);
    var segs = segmentsOf(arr), i, sg, pr, left, width, right, drawn = 0;
    for (i = 0; i < segs.length; i++) {
      sg = segs[i]; pr = sg.pr;
      if (sg.e <= gd.rangeStart || sg.s >= gd.rangeEnd) continue;
      left = Math.max(0, pxOf(sg.s));
      right = Math.min(COLS * COL_W, pxOf(sg.e));
      width = Math.max(6, right - left);
      var block = App.el('div', 'guide-prog' + (sg.cut ? ' is-cut' : ''));
      block.id = 'guide-cell-' + idx + '-' + pr.s;
      block.dataset.idx = idx;
      block.dataset.start = pr.s;
      block.style.left = left + 'px';
      block.style.width = width + 'px';
      block.setAttribute('role', 'gridcell');
      block.setAttribute('aria-label', gd.rows[idx].name + ': ' + blockTitle(pr) + ', ' + hhmm(pr.s) + ' às ' + hhmm(pr.e) + (sg.cut ? ' (trecho)' : ''));
      var tt = App.el('div', 'guide-prog-title', blockTitle(pr));
      tt.title = blockTitle(pr) + ' (' + hhmm(pr.s) + '–' + hhmm(pr.e) + ')';
      block.appendChild(tt);
      if (width > 96) block.appendChild(App.el('div', 'guide-prog-time', hhmm(sg.s) + '–' + hhmm(sg.e)));
      el.appendChild(block);
      drawn++;
    }
    if (!drawn) {
      el.appendChild(App.el('div', 'guide-row-empty', arr.length ? 'Sem programas nesta faixa de horário' : 'Sem programação'));
    }
    /* reaplica foco se a linha em foco foi repintada */
    if (idx === gd.focusRow) applyFocus();
  }

  /* --------------------------------------------------------------- foco */
  function focusedProgramme() {
    if (!gd) return null;
    var arr = gd.rowData[gd.focusRow];
    if (!arr || !arr.length) return null;
    var t = gd.focusTs, i, best = null;
    for (i = 0; i < arr.length; i++) {
      if (arr[i].s <= t && arr[i].e > t) { if (!best || arr[i].s > best.s) best = arr[i]; }
    }
    if (best) return best;
    for (i = 0; i < arr.length; i++) if (arr[i].s > t) return arr[i];
    return arr[arr.length - 1];
  }

  function blockOf(idx, start) {
    if (!gd || !gd.rowEls[idx]) return null;
    var blocks = gd.rowEls[idx].children;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].dataset && +blocks[i].dataset.start === +start) return blocks[i];
    }
    return null;
  }

  function applyFocus() {
    if (!gd) return;
    var focused = gd.rowsInner ? gd.rowsInner.querySelectorAll('.guide-prog.focused') : [];
    for (var i = 0; i < focused.length; i++) focused[i].classList.remove('focused');
    updateFocusRowClasses();
    var pr = focusedProgramme();
    if (!pr) return;
    var block = blockOf(gd.focusRow, pr.s);
    if (block) {
      block.classList.add('focused');
      if (gd.scroll) gd.scroll.setAttribute('aria-activedescendant', block.id);
    }
  }

  function updateFocusRowClasses() {
    if (!gd) return;
    if (gd.lastFocusRow != null && gd.chanEls[gd.lastFocusRow]) gd.chanEls[gd.lastFocusRow].classList.remove('is-focus');
    if (gd.rowEls[gd.lastFocusRow]) gd.rowEls[gd.lastFocusRow].classList.remove('is-focus');
    gd.lastFocusRow = gd.focusRow;
    if (gd.chanEls[gd.focusRow]) gd.chanEls[gd.focusRow].classList.add('is-focus');
    if (gd.rowEls[gd.focusRow]) gd.rowEls[gd.focusRow].classList.add('is-focus');
  }

  function focusRowInView() {
    if (!gd || !gd.scroll) return;
    var top = gd.focusRow * ROW_H, vh = gd.scroll.clientHeight || 600;
    if (top < gd.scroll.scrollTop) gd.scroll.scrollTop = top;
    else if (top + ROW_H > gd.scroll.scrollTop + vh) gd.scroll.scrollTop = top + ROW_H - vh;
  }

  function ensureFocusVisible() {
    if (!gd || !gd.scroll) return;
    focusRowInView();
    var pr = focusedProgramme();
    if (!pr) return;
    var left = Math.max(0, pxOf(pr.s));
    var right = Math.min(COLS * COL_W, pxOf(pr.e));
    var vw = gd.scroll.clientWidth || 900, sl = gd.scroll.scrollLeft;
    if (left < sl + 24) gd.scroll.scrollLeft = Math.max(0, left - 60);
    else if (right > sl + vw - 24) gd.scroll.scrollLeft = Math.min(COLS * COL_W - vw, right - vw + 120);
    renderSync();
  }

  /* ---------------------------------------------------------- navegacao */
  function moveRow(delta) {
    if (!gd || !gd.rows.length) return false;
    var nextIdx = clamp(gd.focusRow + delta, 0, gd.rows.length - 1);
    if (nextIdx === gd.focusRow) return false;
    gd.focusRow = nextIdx;
    ensureRowData(nextIdx);
    focusRowInView();
    paintVisibleRows();
    applyFocus();
    return true;
  }

  function moveProgramme(delta) {
    if (!gd) return false;
    var arr = gd.rowData[gd.focusRow];
    var pr = focusedProgramme();
    if (arr && arr.length && pr) {
      var idx = arr.indexOf(pr);
      var target = arr[clamp(idx + delta, 0, arr.length - 1)];
      if (target) gd.focusTs = clamp(target.s + 1000, gd.rangeStart + 1, gd.rangeEnd - 1);
      else gd.focusTs = clamp(gd.focusTs + delta * MIN, gd.rangeStart + 1, gd.rangeEnd - 1);
    } else {
      gd.focusTs = clamp(gd.focusTs + delta * MIN, gd.rangeStart + 1, gd.rangeEnd - 1);
      ensureRowData(gd.focusRow);
    }
    ensureFocusVisible();
    applyFocus();
    return true;
  }

  function openFocused() {
    if (!gd) return;
    var pr = focusedProgramme();
    if (!pr) return;
    var row = gd.rows[gd.focusRow];
    openDetail(row, pr);
  }

  function key(a) {
    if (!gd) return false;
    if (a === 'back' || a === 'exit') { close(); return true; }
    if (a === 'up') { moveRow(-1); return true; }
    if (a === 'down') { moveRow(1); return true; }
    if (a === 'left') { moveProgramme(-1); return true; }
    if (a === 'right') { moveProgramme(1); return true; }
    if (a === 'ok') { openFocused(); return true; }
    if (a === 'chup') { moveRow(-1); return true; }
    if (a === 'chdown') { moveRow(1); return true; }
    if (a === 'red') { if (gd.list) App.epg.refresh(gd.list).then(null, function () { }); return true; }
    return true;   /* consome as demais teclas: o guia esta por cima do shell */
  }

  /* ------------------------------------------------------------- detalhe */
  function openDetail(row, pr) {
    if (!gd || !row || !pr) return;
    closeDetail();
    var ov = App.el('div', 'overlay guide-detail-overlay');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'guide-detail-title');
    var modal = App.el('div', 'modal glass-panel guide-detail');
    modal.setAttribute('tabindex', '-1');
    var title = App.el('h2', 'h2 guide-detail-title', blockTitle(pr));
    title.id = 'guide-detail-title';
    var meta = App.el('div', 'guide-detail-meta');
    var day = dayLabel(pr.s);
    var parts = [row.name, day + ' · ' + hhmm(pr.s) + ' às ' + hhmm(pr.e), durMin(pr) + ' min'];
    meta.textContent = parts.filter(Boolean).join('  ·  ');
    modal.appendChild(title);
    modal.appendChild(meta);
    if (pr.cat) {
      var cat = App.el('span', 'badge guide-detail-cat', pr.cat);
      modal.appendChild(cat);
    }
    var desc = App.el('div', 'guide-detail-desc', pr.d || 'Sem descrição.');
    modal.appendChild(desc);
    var btns = App.el('div', 'btns');
    var closeBtn = button('Fechar', 'primary', function () { closeDetail(); });
    btns.appendChild(closeBtn);
    modal.appendChild(btns);
    ov.appendChild(modal);
    var layer = {
      key: function (a) {
        if (a === 'back' || a === 'ok' || a === 'exit') { closeDetail(); return true; }
        return true;
      }
    };
    gd.detailEl = ov;
    gd.detailClose = App.ui.open(ov, layer);
    try { modal.focus(); } catch (e) { /* ignore */ }
    ov.addEventListener('click', function (e) { if (e.target === ov) closeDetail(); });
  }

  function closeDetail() {
    if (!gd || !gd.detailClose) return false;
    var fn = gd.detailClose;
    gd.detailClose = null;
    gd.detailEl = null;
    try { fn(); } catch (e) { /* ignore */ }
    if (gd.scroll) { try { gd.scroll.focus(); } catch (e2) { /* ignore */ } }
    return true;
  }

  /* ------------------------------------------------------------- scroll */
  function renderSync() {
    if (!gd || !gd.scroll) return;
    var sl = gd.scroll.scrollLeft;
    if (gd.timeTrack) gd.timeTrack.style.transform = 'translateX(' + (-sl) + 'px)';
    if (gd.chanInner) gd.chanInner.style.transform = 'translateY(' + (-gd.scroll.scrollTop) + 'px)';
    paintNow();
  }

  function onScroll() {
    if (!gd) return;
    if (gd.raf) return;
    gd.raf = requestAnimationFrame(function () {
      gd.raf = 0;
      if (!gd) return;
      renderSync();
      paintVisibleRows();
    });
  }

  function paintNow() {
    if (!gd) return;
    var now = Date.now();
    var inRange = now >= gd.rangeStart && now <= gd.rangeEnd;
    var x = pxOf(now);
    if (gd.nowLine) {
      gd.nowLine.style.display = inRange ? 'block' : 'none';
      gd.nowLine.style.left = Math.round(x) + 'px';
      gd.nowLine.style.height = (gd.rows.length * ROW_H) + 'px';
    }
    if (gd.timeTrack) {
      var flag = gd.timeTrack.querySelector('.guide-now-flag');
      if (flag) {
        flag.style.display = inRange ? 'block' : 'none';
        flag.style.left = Math.round(x) + 'px';
      }
    }
    if (gd.statusEl) updateStatus();
  }

  /* ---------------------------------------------------------- mouse/drag */
  function bindDrag(scroll) {
    scroll.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      var t = e.target;
      if (t && t.closest && t.closest('button')) return;
      gd.drag = { x: e.clientX, y: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop, moved: false, target: t };
      try { scroll.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    scroll.addEventListener('pointermove', function (e) {
      var d = gd && gd.drag;
      if (!d) return;
      var dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 6) { d.moved = true; scroll.classList.add('dragging'); }
      if (!d.moved) return;
      scroll.scrollLeft = d.sl - dx;
      scroll.scrollTop = d.st - dy;
      if (e.cancelable) e.preventDefault();
    });
    function end(e) {
      var d = gd && gd.drag;
      if (!d) return;
      gd.drag = null;
      scroll.classList.remove('dragging');
      try { scroll.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (d.moved) return;
      var t = d.target;
      var block = t && t.closest ? t.closest('.guide-prog') : null;
      if (block) {
        var idx = +block.dataset.idx, start = +block.dataset.start;
        var arr = gd.rowData[idx] || [], pr = null, i;
        for (i = 0; i < arr.length; i++) if (arr[i].s === start) { pr = arr[i]; break; }
        gd.focusRow = idx; gd.focusTs = pr ? pr.s + 1 : gd.focusTs;
        applyFocus();
        if (pr) openDetail(gd.rows[idx], pr);
      } else {
        /* clique no fundo da grade: leva o foco para o horario clicado */
        var rect = scroll.getBoundingClientRect();
        var ts = gd.rangeStart + (scroll.scrollLeft + (e.clientX - rect.left)) / PX_PER_MS;
        gd.focusTs = clamp(ts, gd.rangeStart + 1, gd.rangeEnd - 1);
        applyFocus();
      }
    }
    scroll.addEventListener('pointerup', end);
    scroll.addEventListener('pointercancel', function () {
      if (gd) gd.drag = null;
      scroll.classList.remove('dragging');
    });
    scroll.addEventListener('wheel', function () { onScroll(); }, { passive: true });
  }

  /* --------------------------------------------------------------- API */
  App.desktop.guide = {
    open: open,
    close: close,
    isOpen: isOpen,
    __guideV1: true
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
