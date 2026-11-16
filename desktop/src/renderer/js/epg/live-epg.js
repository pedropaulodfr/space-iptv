/* Integracao do EPG na TV ao vivo do Space IPTV Desktop (sem editar tv/js).
 *
 * - Embrulha App.cards.channel: acrescenta as linhas estaveis "Agora:" / "A seguir:"
 *   (altura reservada, sem CLS) e atualiza a cada 60 s e a cada evento do EPG.
 * - Embrulha App.screens.browse('live'): injeta a barra com o botao "Guia" (+ status do
 *   guia e "Atualizar"), carrega o EPG ao abrir a TV ao vivo e tenta de novo quando o
 *   catalogo termina de carregar (M3U so descobre url-tvg depois do catalogo).
 * - Atalho G (fallback do bootstrap) e Teclado/Enter no botao nativo; mouse/clique idem.
 */
(function (g) {
  'use strict';
  var App = g.App;
  if (!App || !App.epg) return;
  if (App.epg.__liveLoaded) return;   /* carregado duas vezes (tag + fallback): nao duplica nada */
  App.epg.__liveLoaded = true;

  var doc = g.document;
  if (!doc) return;

  var UPDATE_MS = 60000;
  var TICK = null;
  var liveRoot = null;
  var bar = null;
  var barStatus = null;
  var loadTimer = null;
  var loadFor = null;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmm(ts) { var d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function activeList() { return App.lists && typeof App.lists.active === 'function' ? App.lists.active() : null; }
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable === true;
  }
  function overlaysOpen() { var o = doc.getElementById('overlays'); return !!(o && o.children.length); }
  function playerOpen() { var p = doc.getElementById('player'); return !!(p && p.classList.contains('open')); }

  function openGuide() {
    if (App.desktop && App.desktop.guide && typeof App.desktop.guide.open === 'function') {
      return App.desktop.guide.open(activeList());
    }
    return false;
  }

  /* Carrega o EPG da lista ativa em segundo plano (com debounce; nao compete com o catalogo). */
  function scheduleLoad(delay) {
    var list = activeList();
    if (!list) return;
    if (loadFor === list.id && App.epg.state().status !== 'none' && App.epg.state().status !== 'idle') {
      /* mesma lista e ja tem estado util: o load() decide sozinho se o cache venceu */
    }
    loadFor = list.id;
    clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      loadTimer = null;
      App.epg.load(list);
    }, delay == null ? 900 : delay);
  }

  /* ---------------------------------------------------- cards de canal */
  function makeLine(cls) {
    var line = App.el('div', 'epg-line ' + cls + ' epg-empty');
    var lbl = App.el('div', 'epg-lbl');
    var txt = App.el('div', 'epg-txt');
    line.appendChild(lbl); line.appendChild(txt);
    return { line: line, lbl: lbl, txt: txt };
  }
  function setLine(part, label, text, title) {
    if (!text) {
      part.line.classList.add('epg-empty');
      part.txt.textContent = '';
      part.lbl.textContent = '';
      part.line.removeAttribute('title');
      return;
    }
    part.line.classList.remove('epg-empty');
    part.lbl.textContent = label;
    part.txt.textContent = text;
    part.line.setAttribute('title', label + ' ' + text + (title ? ' (' + title + ')' : ''));
  }

  function decorateChannel(card, it) {
    if (!card || !it || it.t !== 'live') return card;
    card.__epgItem = it;
    if (card.__epgNow) return card;
    var info = card.querySelector('.info');
    if (!info) return card;
    var box = App.el('div', 'epg-lines');
    box.setAttribute('data-epg', '1');
    var nowPart = makeLine('epg-now');
    var nextPart = makeLine('epg-next');
    box.appendChild(nowPart.line); box.appendChild(nextPart.line);
    info.appendChild(box);
    card.__epgNow = nowPart; card.__epgNext = nextPart; card.__epgLines = box;
    paintCard(card);
    scheduleLoad();
    return card;
  }

  function paintCard(card) {
    if (!card || !card.__epgNow) return;
    var it = card.__epgItem;
    var ag = null, nx = null;
    try { ag = App.epg.now(it); } catch (e) { ag = null; }
    try { nx = App.epg.next(it); } catch (e) { nx = null; }
    setLine(card.__epgNow, 'Agora:', ag ? ag.title : '', ag ? hhmm(ag.start) + '–' + hhmm(ag.stop) : '');
    setLine(card.__epgNext, 'A seguir:', nx ? nx.title : '', nx ? hhmm(nx.start) : '');
  }

  /* poster da Home/resultados (TV ao vivo usa poster com .psub vazio): preenche com "Agora". */
  function decoratePoster(card, it) {
    if (!card || !it || it.t !== 'live') return card;
    card.__epgItem = it;
    if (!card.__epgPoster) {
      var sub = card.querySelector('.psub');
      if (!sub) return card;
      card.__epgPoster = true;
      card.__epgSub = sub;
      card.__epgSubOriginal = sub.textContent || '';
    }
    paintPoster(card);
    scheduleLoad();
    return card;
  }
  function paintPoster(card) {
    if (!card || !card.__epgSub) return;
    if (card.__epgSubOriginal) return;   /* legenda propria (ex.: categoria) vence o EPG */
    var ag = null;
    try { ag = App.epg.now(card.__epgItem); } catch (e) { ag = null; }
    card.__epgSub.textContent = ag ? ('Agora: ' + ag.title) : '';
    if (ag) card.__epgSub.setAttribute('title', ag.title + ' (' + hhmm(ag.start) + '–' + hhmm(ag.stop) + ')');
    else card.__epgSub.removeAttribute('title');
  }

  /* ---------------------------------------------------- barra da tela ao vivo */
  function paintStatus() {
    if (!barStatus) return;
    var s = App.epg.state();
    var txt = '';
    if (s.status === 'loading' || s.refreshing) txt = 'Carregando guia…';
    else if (s.status === 'none') txt = 'Sem EPG nesta lista';
    else if (s.status === 'error') txt = 'Guia indisponível';
    else if (s.status === 'ready') {
      txt = 'Guia: ' + s.channelCount + (s.channelCount === 1 ? ' canal' : ' canais');
      if (s.fetchedAt) txt += ' · atualizado ' + hhmm(s.fetchedAt);
      if (s.stale) txt += ' (desatualizado)';
    }
    barStatus.textContent = txt;
    barStatus.title = s.error || (s.source ? 'Fonte: ' + s.source : '');
    if (s.status === 'none' || s.status === 'error') barStatus.classList.add('warn');
    else barStatus.classList.remove('warn');
  }

  function buildBar(root) {
    var el = App.el('div', 'epg-live-bar');
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Guia de programação');
    var status = App.el('span', 'epg-live-status hud-caption');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    var refresh = doc.createElement('button');
    refresh.type = 'button';
    refresh.className = 'epg-live-refresh';
    refresh.textContent = 'Atualizar guia';
    refresh.title = 'Atualizar o guia de programação agora';
    refresh.addEventListener('click', function () {
      var list = activeList();
      if (list) App.epg.refresh(list).then(null, function () { /* erro vira status/evento */ });
    });

    var open = doc.createElement('button');
    open.type = 'button';
    open.className = 'epg-live-open btn primary';
    open.textContent = 'Guia';
    open.title = 'Abrir o guia de programação (atalho G)';
    open.setAttribute('aria-keyshortcuts', 'G');
    open.setAttribute('aria-haspopup', 'dialog');
    open.addEventListener('click', openGuide);

    el.appendChild(status);
    el.appendChild(refresh);
    el.appendChild(open);
    root.appendChild(el);
    return { root: el, status: status };
  }

  function ensureBar(root) {
    if (!root || !root.isConnected) return;
    if (bar && bar.root && bar.root.parentNode === root) return;
    if (bar && bar.root && bar.root.parentNode) bar.root.parentNode.removeChild(bar.root);
    bar = buildBar(root);
    barStatus = bar.status;
    paintStatus();
  }

  function removeBar() {
    if (bar && bar.root && bar.root.parentNode) bar.root.parentNode.removeChild(bar.root);
    bar = null; barStatus = null;
  }

  /* ---------------------------------------------------- embrulhos */
  function wrapChannel() {
    var base = App.cards && App.cards.channel;
    if (typeof base !== 'function' || base.__epgWrapped) return;
    var wrapped = function (it, o) { return decorateChannel(base.call(App.cards, it, o), it); };
    wrapped.__epgWrapped = true;
    App.cards.channel = wrapped;
  }
  function wrapPoster() {
    var base = App.cards && App.cards.poster;
    if (typeof base !== 'function' || base.__epgWrapped) return;
    var wrapped = function (it, o) { return decoratePoster(base.call(App.cards, it, o), it); };
    wrapped.__epgWrapped = true;
    App.cards.poster = wrapped;
  }
  function wrapLiveScreen() {
    if (!App.screens || typeof App.screens.browse !== 'function' || App.screens.browse.__epgWrapped) return;
    var base = App.screens.browse;
    var wrapped = function (type) {
      var screen = base.apply(App.screens, arguments);
      if (type !== 'live' || !screen || typeof screen.mount !== 'function') return screen;
      return liveProxy(screen);
    };
    wrapped.__epgWrapped = true;
    App.screens.browse = wrapped;
  }

  function liveProxy(s) {
    return {
      hints: s.hints,
      mount: function (root) {
        liveRoot = root;
        if (root && root.classList) root.classList.add('epg-live-screen');
        s.mount(root);
        ensureBar(root);
        paintVisible();
        scheduleLoad(200);
      },
      unmount: function () {
        removeBar();
        if (liveRoot && liveRoot.classList) liveRoot.classList.remove('epg-live-screen');
        liveRoot = null;
        if (typeof s.unmount === 'function') s.unmount();
      },
      enter: function () {
        ensureBar(liveRoot);
        paintStatus();
        return typeof s.enter === 'function' ? s.enter() : true;
      },
      key: function (a) { return s.key ? s.key(a) : false; }
    };
  }

  /* ---------------------------------------------------- atualizacao periodica */
  function paintVisible() {
    var cards, i, el;
    cards = doc.querySelectorAll('#screen .chan');
    for (i = 0; i < cards.length; i++) { el = cards[i]; if (el.__epgItem) { try { paintCard(el); } catch (e) { /* ignora card isolado */ } } }
    cards = doc.querySelectorAll('#screen .poster');
    for (i = 0; i < cards.length; i++) { el = cards[i]; if (el.__epgPoster) { try { paintPoster(el); } catch (e) { /* ignora */ } } }
  }
  function startTick() {
    if (TICK) return;
    TICK = setInterval(function () { paintVisible(); paintStatus(); }, UPDATE_MS);
  }

  /* ---------------------------------------------------- eventos */
  function onEpg() {
    paintVisible();
    paintStatus();
    if (liveRoot) ensureBar(liveRoot);
  }
  function onCatalog() {
    /* o browse pode reconstruir a tela inteira em resposta a este mesmo evento; readiciona a
       barra depois que ele terminar (nosso assinante roda antes, porque o modulo carrega antes) */
    if (liveRoot) setTimeout(function () { if (liveRoot) ensureBar(liveRoot); }, 0);
    scheduleLoad(300);
  }
  function onLists(e) {
    if (!e) return;
    if (e.action === 'active' || e.action === 'save' || e.action === 'remove') {
      barStatus = null;
      scheduleLoad(400);
    }
  }

  /* atalho G (fallback; o bootstrap tambem registra e o guide.open e idempotente) */
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var k = e.key || '';
    if (k !== 'g' && k !== 'G') return;
    if (isEditable(e.target || doc.activeElement)) return;
    if (playerOpen() || overlaysOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    openGuide();
  }

  /* ---------------------------------------------------- boot */
  wrapChannel();
  wrapPoster();
  wrapLiveScreen();
  startTick();

  if (App.bus && typeof App.bus.on === 'function') {
    App.bus.on('epg', onEpg);
    App.bus.on('epg:done', onEpg);
    App.bus.on('epg:error', onEpg);
    App.bus.on('epg:chunk', onEpg);
    App.bus.on('catalog', onCatalog);
    App.bus.on('catalog:done', onCatalog);
    App.bus.on('lists', onLists);
  }
  doc.addEventListener('keydown', onKey, true);

  /* primeiro carregamento: depois do boot (o catalogo ainda vai carregar) */
  if (doc.readyState === 'complete') scheduleLoad(1200);
  else g.addEventListener('load', function () { scheduleLoad(1200); }, { once: true });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
