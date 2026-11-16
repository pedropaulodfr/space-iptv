/* Tela Baixados + integração de downloads do Space IPTV Desktop.
 *
 * Contrato (CONTRACTS.md §3.4):
 *   App.screens.downloads() -> {hints, mount, unmount, enter, key(a)}
 *   App.downloads = { probe(item,list,ep?,season?), download(item,list,ep?,season?),
 *                     playOffline(rec), refresh() }
 *
 * Regras:
 *  - botão "Baixar" no overlay de detalhes (filme e episódio) SEM editar tv/js:
 *    embrulha App.actions.details, injeta o botão no grupo de botões (teclado e
 *    mouse) e acrescenta um botão em cada linha de episódio (MutationObserver;
 *    desligado enquanto o player está aberto);
 *  - reprodução offline usa SÓ a rota interna `/offline/<id>/...` (same-origin,
 *    jamais reescrita pelo App.net.mediaUrl), sem backend/internet;
 *  - a tela funciona offline (lista vem do processo principal por IPC);
 *  - teclado (setas/Enter/Delete/Backspace) e mouse, foco visível, alvos ≥44 px,
 *    estados vazio/carregando com skeleton sem CLS.
 */
(function (g) {
  'use strict';
  var App = g.App;
  if (!App) return;

  var FILTERS = [
    { k: 'all', n: 'Todos' },
    { k: 'active', n: 'Baixando' },
    { k: 'done', n: 'Concluídos' },
    { k: 'paused', n: 'Pausados' },
    { k: 'error', n: 'Com erro' }
  ];

  var STATUS_LABEL = {
    queued: 'Na fila',
    downloading: 'Baixando',
    paused: 'Pausado',
    packaging: 'Finalizando',
    done: 'Concluído',
    error: 'Erro',
    canceled: 'Cancelado'
  };

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  /* CSS próprio: o index.html já carrega css/downloads.css; se alguém montar o
     renderer sem esse <link>, injeta o mesmo arquivo (defensivo, sem duplicar). */
  function ensureCss() {
    if (!document || !document.head) return;
    var has = document.querySelector('link[data-dl-css], link[href="css/downloads.css"]');
    if (has) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/downloads.css';
    link.setAttribute('data-dl-css', '');
    document.head.appendChild(link);
  }

  function downloadsApi() {
    return (g.space && g.space.downloads) ? g.space.downloads : null;
  }

  function toast(msg, ms) {
    if (App.toast) App.toast(msg, ms || 3200);
  }

  function offlineMode() {
    return !!(App.desktop && App.desktop.offline);
  }

  function isOnline() {
    try { return !(g.navigator && g.navigator.onLine === false); } catch (e) { return true; }
  }

  function currentList() {
    if (App.catalog && App.catalog.listId && App.lists && App.lists.get) return App.lists.get(App.catalog.listId);
    return (App.lists && App.lists.active) ? App.lists.active() : null;
  }

  function clamp01(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  function fmtBytes(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) return '—';
    if (v < 1024) return Math.round(v) + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return v.toFixed(v >= 100 ? 0 : 1).replace('.', ',') + ' ' + units[i];
  }

  function fmtSpeed(bps) {
    var v = Number(bps) || 0;
    if (v <= 0) return '';
    return fmtBytes(v) + '/s';
  }

  function fmtEta(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    if (!s) return '';
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60);
    return h + ' h ' + (m % 60) + ' min';
  }

  function pad2(n) {
    n = Math.max(0, Math.floor(Number(n) || 0));
    return n < 10 ? '0' + n : String(n);
  }

  function fmtDurationSeconds(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0));
    if (!s) return '';
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return h ? h + ' h ' + pad2(m) + ' min' : m + ' min';
  }

  function parseDuration(value) {
    if (typeof value === 'number' && isFinite(value)) return Math.max(0, Math.floor(value));
    var s = String(value == null ? '' : value);
    var m = /(\d+):(\d{2}):(\d{2})/.exec(s);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    m = /(\d+):(\d{2})/.exec(s);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    return 0;
  }

  function durationOf(item, ep) {
    if (ep && ep.dur) return parseDuration(ep.dur);
    if (item && item.d) return Number(item.d) || 0;
    return 0;
  }

  function typeLabel(rec) {
    if (!rec) return '';
    if (rec.kind === 'episode' || rec.episode) {
      return 'Série • T' + pad2(rec.season || 1) + ' E' + pad2(rec.episode || 1);
    }
    return 'Filme';
  }

  function statusText(rec) {
    var label = STATUS_LABEL[rec.status] || rec.status;
    var pct = Math.round(clamp01(rec.progress) * 100);
    if (rec.status === 'downloading') {
      var parts = [label, pct + '%'];
      var sp = fmtSpeed(rec.speedBps);
      if (sp) parts.push(sp);
      var eta = fmtEta(rec.etaSec);
      if (eta) parts.push('faltam ' + eta);
      return parts.join(' • ');
    }
    if (rec.status === 'queued') return label + ' • aguardando vaga';
    if (rec.status === 'packaging') return label + ' • gravando manifesto';
    if (rec.status === 'paused' || rec.status === 'canceled') return label + (pct ? ' • ' + pct + '%' : '');
    if (rec.status === 'error') return 'Erro' + (rec.error ? ' • ' + rec.error : '');
    if (rec.status === 'done') {
      var when = rec.completedAt ? App.fmtDate(rec.completedAt) : App.fmtDate(rec.createdAt);
      return label + (when ? ' • ' + when : '');
    }
    return label;
  }

  function metaText(rec) {
    var parts = [];
    var dur = fmtDurationSeconds(rec.durationSec);
    if (dur) parts.push(dur);
    var size = rec.status === 'done' ? (rec.sizeBytes || rec.bytes) : (rec.bytes || 0);
    if (size) parts.push(fmtBytes(size));
    if (rec.status !== 'done') parts.push(App.fmtDate(rec.createdAt));
    if (rec.variantLabel) parts.push(rec.variantLabel);
    return parts.join(' • ');
  }

  function posterInitials(title) {
    var words = String(title || '?').replace(/[^A-Za-z0-9À-ſ ]/g, ' ').split(/\s+/).filter(Boolean);
    return ((words[0] || '?').charAt(0) + (words[1] ? words[1].charAt(0) : '')).toUpperCase();
  }

  function makePoster(rec) {
    var box = App.el('div', 'dl-poster');
    var url = rec.poster || '';
    if (/^https?:\/\//i.test(url)) {
      var img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      try { img.referrerPolicy = 'no-referrer'; } catch (e) { /* ignore */ }
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      img.src = url;
      box.appendChild(img);
    }
    box.appendChild(App.el('span', 'dl-poster-ph', posterInitials(rec.title)));
    return box;
  }

  function variantLabel(variant) {
    if (!variant) return 'Fonte';
    var label = String(variant.label || '').replace(/^\s+|\s+$/g, '');
    if (label) return label;
    var parts = [];
    if (variant.resolution) parts.push(variant.resolution);
    if (variant.codecs) parts.push(variant.codecs);
    if (variant.bandwidth) parts.push((Number(variant.bandwidth) / 1000000).toFixed(1).replace('.', ',') + ' Mbps');
    if (variant.estimatedBytes) parts.push(fmtBytes(variant.estimatedBytes));
    return (variant.kind === 'hls' ? 'HLS' : 'MP4') + (parts.length ? ' • ' + parts.join(' • ') : '');
  }

  function isSessionUsable() {
    if (!App.session || typeof App.session.user !== 'function') return false;
    try { return !!App.session.user(); } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------------- */
  /* App.downloads — ações de download                                      */
  /* ---------------------------------------------------------------------- */

  var probeBusy = false;
  var lastList = null;
  var screenApi = null;

  function startDownload(item, list, ep, season, variant) {
    var api = downloadsApi();
    if (!api) {
      toast('Downloads disponíveis apenas no aplicativo desktop.');
      return Promise.resolve(null);
    }
    var engine = variant && variant.kind === 'hls' ? 'hls' : (variant && variant.kind === 'mp4' ? 'mp4' : undefined);
    var req = {
      kind: ep ? 'episode' : 'movie',
      title: item.n || 'Sem título',
      subtitle: ep ? ('T' + pad2(season || 1) + ' • E' + pad2(ep.e || 0) + (ep.title ? ' — ' + ep.title : '')) : (item.g || ''),
      poster: item.l || '',
      listId: (list && list.id) || (App.catalog && App.catalog.listId) || '',
      itemId: item.id,
      epId: ep ? (ep.id || '') : '',
      season: ep ? (season || 1) : 0,
      episode: ep ? (ep.e || 0) : 0,
      year: item.y || '',
      durationSec: durationOf(item, ep),
      url: variant.url,
      variantId: variant.id || '',
      variantLabel: variant.label || '',
      totalBytes: variant.estimatedBytes || 0,
      headers: {}
    };
    if (engine) req.engine = engine;
    return Promise.resolve(api.add(req)).then(function (res) {
      if (!res || res.ok === false) {
        toast((res && res.error) || 'Não foi possível iniciar o download.', 4200);
        return null;
      }
      toast(ep ? 'Episódio adicionado aos downloads' : 'Download adicionado à fila');
      App.downloads.refresh();
      return res.id;
    }, function () {
      toast('Não foi possível iniciar o download.', 4200);
      return null;
    });
  }

  function probeInternal(item, list, ep, season) {
    var api = downloadsApi();
    if (!api) {
      toast('Downloads disponíveis apenas no aplicativo desktop.');
      return Promise.resolve(null);
    }
    if (!item) return Promise.resolve(null);
    if (offlineMode() || !isOnline()) {
      toast('Sem conexão — não é possível baixar agora. Os downloads já feitos continuam disponíveis.', 4200);
      return Promise.resolve(null);
    }
    if (probeBusy) {
      toast('Preparando o download anterior…');
      return Promise.resolve(null);
    }
    probeBusy = true;
    var e = ep ? { id: ep.id, e: ep.e, s: season || ep.s || 1, title: ep.title, x: ep.x, url: ep.url, dur: ep.dur } : null;
    return Promise.resolve(App.catalog.urls(item, list, e)).then(function (urls) {
      var list2 = [];
      for (var i = 0; i < (urls || []).length; i++) {
        if (typeof urls[i] === 'string' && urls[i]) list2.push(urls[i]);
      }
      if (!list2.length) {
        probeBusy = false;
        toast('Nenhuma URL de mídia disponível para este item.');
        return null;
      }
      return Promise.resolve(api.probe({
        urls: list2,
        durationSec: durationOf(item, ep)
      })).then(function (res) {
        probeBusy = false;
        if (!res || !res.variants || !res.variants.length) {
          toast((res && res.error) || 'Não foi possível preparar o download.', 4600);
          return null;
        }
        if (res.variants.length === 1) return startDownload(item, list, ep, season, res.variants[0]);
        var options = res.variants.map(function (variant) {
          return { label: variantLabel(variant) };
        });
        return App.ui.menu({
          title: 'Qualidade do download',
          msg: 'O arquivo será salvo para assistir sem internet.',
          options: options
        }).then(function (idx) {
          if (idx == null) return null;
          return startDownload(item, list, ep, season, res.variants[idx]);
        });
      });
    }).then(null, function (err) {
      probeBusy = false;
      toast(App.friendly ? App.friendly(err && err.code ? err : { code: 'network' }) : 'Não foi possível preparar o download.', 4600);
      return null;
    });
  }

  function playOffline(rec) {
    if (!rec || !rec.offlineUrl) {
      toast('Arquivo offline não encontrado para este download.');
      return false;
    }
    if (!App.player || typeof App.player.play !== 'function') {
      toast('O player ainda não está disponível.');
      return false;
    }
    var isEpisode = rec.kind === 'episode' || !!rec.episode;
    var item = {
      t: isEpisode ? 'series' : 'movie',
      id: rec.itemId || rec.id,
      n: rec.title,
      l: rec.poster || '',
      y: rec.year || '',
      d: rec.durationSec || 0
    };
    var list = { id: rec.listId || 'offline', name: 'Baixados', type: 'offline' };
    var ep = isEpisode ? {
      id: rec.epId || rec.id,
      e: rec.episode || 0,
      s: rec.season || 0,
      title: rec.subtitle || '',
      dur: rec.durationSec || 0
    } : null;
    var sub = isEpisode
      ? ('T' + pad2(rec.season || 1) + ' • E' + pad2(rec.episode || 1) + (rec.subtitle ? ' — ' + rec.subtitle : '') + ' • offline')
      : ('Baixado • ' + fmtBytes(rec.sizeBytes || rec.bytes || 0));
    var posKey = 'dlpos.' + rec.id;
    var savedPos = 0;
    try { savedPos = Number(App.store.get(posKey, 0)) || 0; } catch (e) { savedPos = 0; }
    var durSec = Number(rec.durationSec) || 0;
    var startAt = (savedPos > 10 && !(durSec > 0 && savedPos / durSec > 0.95)) ? savedPos : 0;
    var historyItem = { t: item.t, id: item.id };

    App.player.play({
      item: item,
      list: list,
      ep: ep,
      urls: [rec.offlineUrl],
      live: false,
      startAt: startAt,
      title: function () { return rec.title; },
      sub: function () { return sub; },
      onClose: function (state) {
        /* posição do nosso "continuar assistindo" offline; não polui o histórico
           da lista ativa com um item que talvez não exista nela. */
        try {
          if (state && state.dur > 0 && state.pos > 10 && state.pos / state.dur <= 0.95) {
            App.store.set(posKey, Math.floor(state.pos / 1000));
          } else {
            App.store.set(posKey, 0);
          }
        } catch (e) { /* armazenamento indisponível */ }
        try { if (App.hist && App.hist.remove) App.hist.remove(historyItem); } catch (e2) { /* ignore */ }
        App.downloads.refresh();
      }
    });
    return true;
  }

  App.downloads = {
    probe: function (item, list, ep, season) { return probeInternal(item, list, ep, season); },
    download: function (item, list, ep, season) { return probeInternal(item, list, ep, season); },
    playOffline: playOffline,
    refresh: function () {
      if (screenApi && typeof screenApi.reload === 'function') return screenApi.reload();
      var api = downloadsApi();
      if (!api) return Promise.resolve(null);
      return Promise.resolve(api.list()).then(function (res) { lastList = res || lastList; return res; }, function () { return null; });
    },
    openFolder: function () {
      var api = downloadsApi();
      if (!api) return Promise.resolve(false);
      return Promise.resolve(api.openFolder()).then(function (res) {
        if (res && res.ok === false) toast(res.error || 'Não foi possível abrir a pasta.', 4200);
      }, function () { toast('Não foi possível abrir a pasta.', 4200); });
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Tela Baixados                                                          */
  /* ---------------------------------------------------------------------- */

  App.screens = App.screens || {};

  App.screens.downloads = function () {
    var el = null;
    var vlist = null;
    var listRoot = null;
    var searchField = null;
    var searchInput = null;
    var chips = null;
    var chipNodes = [];
    var actionsGroup = null;
    var actionNodes = [];
    var zone = 'list';
    var filter = 'all';
    var query = '';
    var all = [];
    var filtered = [];
    var stats = {};
    var loading = true;
    var errorMsg = '';
    var mounted = false;
    var offEvent = null;
    var onKeyDown = null;
    var reloadSeq = 0;
    var searchTimer = null;

    function matchFilter(rec, k) {
      if (k === 'all') return true;
      if (k === 'active') return rec.status === 'queued' || rec.status === 'downloading' || rec.status === 'packaging';
      if (k === 'done') return rec.status === 'done';
      if (k === 'paused') return rec.status === 'paused' || rec.status === 'canceled';
      if (k === 'error') return rec.status === 'error';
      return true;
    }

    function applyFilters() {
      var q = App.norm(query);
      var out = [];
      for (var i = 0; i < all.length; i++) {
        var rec = all[i];
        if (!matchFilter(rec, filter)) continue;
        if (q) {
          var hay = App.norm((rec.title || '') + ' ' + (rec.subtitle || '') + ' ' + (rec.dirName || ''));
          if (hay.indexOf(q) < 0) continue;
        }
        out.push(rec);
      }
      filtered = out;
      return out;
    }

    function counts() {
      var c = { all: all.length, active: 0, done: 0, paused: 0, error: 0 };
      for (var i = 0; i < all.length; i++) {
        var s = all[i].status;
        if (s === 'queued' || s === 'downloading' || s === 'packaging') c.active++;
        else if (s === 'done') c.done++;
        else if (s === 'paused' || s === 'canceled') c.paused++;
        else if (s === 'error') c.error++;
      }
      for (var j = 0; j < chipNodes.length; j++) {
        chipNodes[j].textContent = FILTERS[j].n + ' (' + c[FILTERS[j].k] + ')';
        chipNodes[j].classList[FILTERS[j].k === filter ? 'add' : 'remove']('primary');
      }
    }

    function paintSummary() {
      if (!el) return;
      var summary = App.$('.dl-summary', el);
      if (!summary) return;
      var active = (stats.downloading || 0) + (stats.queued || 0) + (stats.packaging || 0);
      var parts = [];
      if (all.length === 0) parts.push('Nenhum download');
      else parts.push(all.length + (all.length === 1 ? ' item' : ' itens'));
      if (stats.done) {
        var total = 0;
        for (var i = 0; i < all.length; i++) {
          if (all[i].status === 'done') total += Number(all[i].sizeBytes || all[i].bytes || 0);
        }
        if (total) parts.push(fmtBytes(total));
      }
      if (active) parts.push('baixando ' + active);
      var paused = (stats.paused || 0) + (stats.canceled || 0);
      if (paused) parts.push('pausados ' + paused);
      if (stats.error) parts.push('com erro ' + stats.error);
      if (offlineMode()) parts.push('modo offline');
      summary.textContent = parts.join(' • ');
    }

    function emptyText() {
      if (errorMsg) return errorMsg;
      if (loading) return 'Carregando downloads...';
      if (!all.length) {
        return 'Você ainda não baixou nada.\n\nAbra um filme ou um episódio e use o botão "Baixar" na tela de detalhes.\nOs arquivos ficam disponíveis mesmo sem internet.';
      }
      if (query) return 'Nada encontrado para "' + query + '".';
      return 'Nenhum download neste filtro.';
    }

    function paint() {
      if (!el) return;
      el.classList[loading ? 'add' : 'remove']('is-loading');
      paintSummary();
      counts();
      if (!vlist) return;
      vlist.o.empty = emptyText();
      vlist.setItems(filtered, true);
      if (zone === 'list' && mounted && !loading) {
        if (filtered.length) vlist.focus();
        else vlist.blur();
      }
    }

    function rowFor(rec, idx, cell) {
      var row = App.el('div', 'dl-row dl-st-' + rec.status);
      row.appendChild(makePoster(rec));
      var main = App.el('div', 'dl-main');
      var head = App.el('div', 'dl-row-head');
      head.appendChild(App.el('span', 'dl-title', rec.title || 'Sem título'));
      head.appendChild(App.el('span', 'badge dl-badge dl-st-badge-' + rec.status, STATUS_LABEL[rec.status] || rec.status));
      main.appendChild(head);
      var sub = App.el('div', 'dl-sub');
      sub.appendChild(App.el('span', 'dl-type', typeLabel(rec)));
      var meta = metaText(rec);
      if (meta) sub.appendChild(App.el('span', 'dl-meta', ' • ' + meta));
      main.appendChild(sub);
      var bar = App.el('div', 'dl-bar');
      var fill = App.el('i');
      var pct = Math.round(clamp01(rec.progress) * 100);
      fill.style.width = pct + '%';
      bar.appendChild(fill);
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-valuenow', String(pct));
      bar.setAttribute('aria-label', 'Progresso do download de ' + (rec.title || ''));
      main.appendChild(bar);
      main.appendChild(App.el('div', 'dl-status' + (rec.status === 'error' ? ' err' : ''), statusText(rec)));
      row.appendChild(main);
      var side = App.el('div', 'dl-side');
      side.appendChild(App.el('div', 'dl-size', fmtBytes(rec.status === 'done' ? (rec.sizeBytes || rec.bytes) : rec.bytes)));
      if (rec.status !== 'done' && rec.totalBytes) side.appendChild(App.el('div', 'dl-size-total', 'de ' + fmtBytes(rec.totalBytes)));
      side.appendChild(App.el('div', 'dl-date', App.fmtDate(rec.status === 'done' ? (rec.completedAt || rec.createdAt) : rec.createdAt)));
      row.appendChild(side);
      cell.appendChild(row);
      return row;
    }

    /* ---------- ações ---------- */

    function withApi(fn) {
      var api = downloadsApi();
      if (!api) { toast('Downloads disponíveis apenas no aplicativo desktop.'); return Promise.resolve(null); }
      return Promise.resolve(fn(api)).then(function (res) {
        if (res && res.ok === false && res.error) toast(res.error, 4600);
        return res;
      }, function () {
        toast('Não foi possível concluir a ação.', 4200);
        return null;
      });
    }

    function pause(rec) {
      return withApi(function (api) { return api.pause(rec.id); }).then(function (res) {
        if (res && res.ok) toast('Download pausado');
        return res;
      });
    }

    function resume(rec) {
      return withApi(function (api) { return api.resume(rec.id); }).then(function (res) {
        if (res && res.ok) toast('Download retomado');
        return res;
      });
    }

    function cancel(rec) {
      return withApi(function (api) { return api.cancel(rec.id); }).then(function (res) {
        if (res && res.ok) toast('Download cancelado. Os arquivos parciais ficam disponíveis para retomar.');
        return res;
      });
    }

    function retry(rec) {
      return withApi(function (api) { return api.retry(rec.id); }).then(function (res) {
        if (res && res.ok) toast('Tentando novamente…');
        return res;
      });
    }

    function confirmRemove(rec) {
      var msg = 'Vai apagar permanentemente os arquivos gerenciados por este aplicativo:\n\n' +
        (rec.title || 'Download') +
        (rec.kind === 'episode' ? ' — T' + pad2(rec.season || 1) + ' E' + pad2(rec.episode || 1) : '') +
        '\nPasta: ' + (rec.dirName || '(desconhecida)') +
        '\n\nNada fora da pasta de downloads é apagado. Esta ação não pode ser desfeita.';
      return App.ui.confirm({
        title: 'Excluir download?',
        msg: msg,
        yes: 'Excluir arquivos',
        no: 'Manter',
        danger: true
      }).then(function (ok) {
        if (!ok) return false;
        return withApi(function (api) { return api.remove(rec.id, { deleteFiles: true }); }).then(function (res) {
          if (res && res.ok) {
            toast('Download excluído');
            return reload();
          }
          return false;
        });
      });
    }

    function openFolder(rec) {
      return withApi(function (api) { return api.reveal(rec.id); }).then(function (res) {
        if (res && res.ok === false) toast(res.error || 'Não foi possível abrir a pasta.', 4200);
        return res;
      });
    }

    function openActions(rec) {
      if (!rec) return;
      var options = [];
      if (rec.status === 'done' && rec.offlineUrl) {
        options.push({ label: 'Reproduzir offline', run: function () { playOffline(rec); } });
      }
      if (rec.status === 'downloading' || rec.status === 'queued') {
        options.push({ label: 'Pausar', run: function () { pause(rec); } });
        options.push({ label: 'Cancelar', run: function () { cancel(rec); } });
      } else if (rec.status === 'paused') {
        options.push({ label: 'Retomar', run: function () { resume(rec); } });
        options.push({ label: 'Cancelar', run: function () { cancel(rec); } });
      } else if (rec.status === 'error' || rec.status === 'canceled') {
        options.push({ label: 'Tentar novamente', run: function () { retry(rec); } });
      } else if (rec.status === 'packaging') {
        options.push({ label: 'Cancelar', run: function () { cancel(rec); } });
      }
      options.push({ label: 'Abrir pasta', run: function () { openFolder(rec); } });
      options.push({ label: 'Excluir arquivos…', danger: true, run: function () { confirmRemove(rec); } });
      App.ui.menu({
        title: rec.title || 'Download',
        msg: typeLabel(rec) + ' • ' + statusText(rec).split(' • ')[0] + (rec.dirName ? '\nPasta: ' + rec.dirName : ''),
        options: options.map(function (o) { return { label: o.label, danger: !!o.danger }; })
      }).then(function (idx) {
        if (idx == null) return;
        var opt = options[idx];
        if (opt && typeof opt.run === 'function') opt.run();
      });
    }

    /* ---------- teclado / foco ---------- */

    function setZone(z) {
      zone = z;
      if (searchField) searchField.classList[z === 'search' ? 'add' : 'remove']('focused');
      if (z === 'chips' && chips) chips.focus(chips.i); else if (chips) chips.blur();
      if (z === 'actions' && actionsGroup) actionsGroup.focus(actionsGroup.i); else if (actionsGroup) actionsGroup.blur();
      if (z !== 'list' && vlist) vlist.blur();
      if (z === 'list' && vlist && filtered.length) vlist.focus();
      if (z === 'search' && searchInput) searchInput.focus();
    }

    function onSearchInput() {
      var value = searchInput ? searchInput.value : '';
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchTimer = null;
        query = String(value || '').replace(/^\s+|\s+$/g, '');
        applyFilters();
        paint();
      }, 200);
    }

    function onDeleteKey(ev) {
      if (!mounted || !ev || ev.defaultPrevented) return;
      if (ev.key !== 'Delete') return;
      if (App.player && typeof App.player.isOpen === 'function' && App.player.isOpen()) return;
      var overlays = document.getElementById('overlays');
      if (overlays && overlays.children.length) return;
      var tag = ev.target && ev.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (ev.target && ev.target.isContentEditable)) return;
      if (zone !== 'list' || !vlist) return;
      var rec = vlist.current();
      if (!rec) return;
      ev.preventDefault();
      confirmRemove(rec);
    }

    /* ---------- carga / eventos ---------- */

    function reload() {
      var api = downloadsApi();
      var seq = ++reloadSeq;
      if (!api) {
        loading = false;
        errorMsg = 'A área de downloads não está disponível neste ambiente.';
        all = [];
        applyFilters();
        paint();
        return Promise.resolve(null);
      }
      loading = all.length === 0;
      if (el) el.classList[loading ? 'add' : 'remove']('is-loading');
      return Promise.resolve(api.list()).then(function (res) {
        if (seq !== reloadSeq || !mounted) return null;
        loading = false;
        errorMsg = (res && res.error) || '';
        all = (res && res.items) || [];
        stats = (res && res.stats) || {};
        lastList = res || lastList;
        applyFilters();
        paint();
        return res;
      }, function () {
        if (seq !== reloadSeq || !mounted) return null;
        loading = false;
        errorMsg = 'Não foi possível carregar a lista de downloads.';
        paint();
        return null;
      });
    }

    function reconcileFromEvent(payload) {
      if (!mounted || !payload) return;
      var rec = payload.item;
      var changedList = false;
      if (payload.type === 'removed' && rec && rec.id) {
        all = all.filter(function (x) { return x.id !== rec.id; });
        changedList = true;
      } else if (rec && rec.id) {
        var found = false;
        for (var i = 0; i < all.length; i++) {
          if (all[i].id === rec.id) { all[i] = rec; found = true; break; }
        }
        if (!found) { all.unshift(rec); changedList = true; }
      }
      if (payload.stats) stats = payload.stats;
      var before = filtered.map(function (x) { return x.id; }).join('|');
      applyFilters();
      var after = filtered.map(function (x) { return x.id; }).join('|');
      if (changedList || before !== after) {
        paint();
        return;
      }
      paintSummary();
      counts();
      if (vlist && rec && rec.id) {
        for (var j = 0; j < filtered.length; j++) {
          if (filtered[j].id === rec.id) {
            if (vlist.cellOf(j)) vlist.refreshItem(j);
            break;
          }
        }
      }
      if (vlist) vlist.o.empty = emptyText();
    }

    function build() {
      App.clear(el);
      var screen = App.el('div', 'dl-screen is-loading');
      var head = App.el('div', 'dl-head');
      var top = App.el('div', 'dl-head-top');
      top.appendChild(App.el('h1', 'display', 'Baixados'));
      top.appendChild(App.el('span', 'dl-summary', 'Carregando downloads...'));
      head.appendChild(top);

      var toolbar = App.el('div', 'dl-toolbar');
      searchField = App.el('div', 'dl-search field');
      searchField.appendChild(App.el('label', null, 'Buscar'));
      searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = 'Título, série ou episódio';
      searchInput.autocomplete = 'off';
      searchInput.spellcheck = false;
      searchInput.setAttribute('aria-label', 'Buscar nos downloads');
      searchInput.addEventListener('input', onSearchInput);
      searchField.appendChild(searchInput);
      toolbar.appendChild(searchField);

      var chipRow = App.el('div', 'dl-chips chip-row');
      chipRow.style.padding = '0';
      chipNodes = FILTERS.map(function (f, i) {
        var chip = App.ui.btn(f.n);
        chip.classList.add('dl-chip');
        chip._act = function () {
          filter = FILTERS[i].k;
          applyFilters();
          paint();
          setZone('chips');
          if (chips) chips.focus(i);
        };
        chipRow.appendChild(chip);
        return chip;
      });
      chips = App.ui.group(chipNodes, true);
      toolbar.appendChild(chipRow);

      var actions = App.el('div', 'dl-actions');
      var btnFolder = App.ui.btn('Abrir pasta');
      btnFolder.classList.add('dl-action');
      btnFolder._act = function () { App.downloads.openFolder(); };
      var btnRefresh = App.ui.btn('Atualizar');
      btnRefresh.classList.add('dl-action');
      btnRefresh._act = function () { reload(); };
      actions.appendChild(btnFolder);
      actions.appendChild(btnRefresh);
      actionNodes = [btnFolder, btnRefresh];
      actionsGroup = App.ui.group(actionNodes, true);
      toolbar.appendChild(actions);
      head.appendChild(toolbar);
      screen.appendChild(head);

      var body = App.el('div', 'dl-body');
      var skeleton = App.el('div', 'dl-skeleton');
      for (var s = 0; s < 4; s++) {
        var skel = App.el('div', 'dl-skel-row');
        skel.appendChild(App.el('div', 'skel dl-skel-poster'));
        var skelMain = App.el('div', 'dl-skel-main');
        skelMain.appendChild(App.el('div', 'skel dl-skel-line w60'));
        skelMain.appendChild(App.el('div', 'skel dl-skel-line w40'));
        skelMain.appendChild(App.el('div', 'skel dl-skel-line w80'));
        skel.appendChild(skelMain);
        skel.appendChild(App.el('div', 'skel dl-skel-side'));
        skeleton.appendChild(skel);
      }
      body.appendChild(skeleton);
      listRoot = App.el('div', 'dl-list');
      body.appendChild(listRoot);
      screen.appendChild(body);
      el.appendChild(screen);

      vlist = new App.VList({
        root: listRoot, cols: 1, rowH: 148, empty: emptyText(),
        render: rowFor,
        onFocus: function () {
          /* ponteiro: passar o mouse numa linha assume o foco da lista, para o
             clique abrir as ações do item (e não o chip que estava focado) */
          if (zone !== 'list') setZone('list');
        },
        onSelect: function (rec) { openActions(rec); }
      });
      vlist.setItems([]);

      zone = 'list';
      applyFilters();
      paint();
      setZone('list');
    }

    return {
      hints: ['OK: ações do download', 'DELETE: excluir', 'Esc: voltar'],
      mount: function (root) {
        el = root;
        mounted = true;
        ensureCss();
        build();
        offEvent = null;
        if (g.space && g.space.downloads && typeof g.space.downloads.onEvent === 'function') {
          try {
            offEvent = g.space.downloads.onEvent(function (payload) {
              try { reconcileFromEvent(payload); } catch (e) { /* nunca derruba a tela */ }
            });
          } catch (e) { offEvent = null; }
        }
        onKeyDown = function (ev) { onDeleteKey(ev); };
        document.addEventListener('keydown', onKeyDown, true);
        reload();
      },
      unmount: function () {
        mounted = false;
        if (typeof offEvent === 'function') { try { offEvent(); } catch (e) { /* ignore */ } }
        offEvent = null;
        if (onKeyDown) { document.removeEventListener('keydown', onKeyDown, true); onKeyDown = null; }
        if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
        if (vlist) { vlist.destroy(); vlist = null; }
        el = null; listRoot = null; searchField = null; searchInput = null;
        chips = null; chipNodes = []; actionsGroup = null; actionNodes = [];
        screenApi = null;
      },
      enter: function () {
        if (!vlist) return false;
        if (filtered.length) { setZone('list'); return vlist.focus(); }
        setZone('chips');
        return true;
      },
      key: function (a) {
        if (!vlist) return false;
        if (a === 'back') {
          if (query) {
            query = '';
            if (searchInput) searchInput.value = '';
            applyFilters();
            paint();
            return true;
          }
          if (zone === 'search') {
            setZone(filtered.length ? 'list' : 'chips');
            return true;
          }
          return false;                       /* deixa o shell voltar ao menu */
        }
        if (zone === 'search') {
          if (a === 'ok') { if (searchInput) searchInput.focus(); return true; }
          if (a === 'down') { setZone('chips'); return true; }
          if (a === 'right') { setZone('actions'); return true; }
          return a !== 'left';
        }
        if (zone === 'chips') {
          if (chips && chips.key(a)) return true;
          if (a === 'up') { setZone('search'); return true; }
          if (a === 'down') { setZone(filtered.length ? 'list' : 'chips'); return true; }
          if (a === 'right') { setZone('actions'); return true; }
          return a !== 'left';
        }
        if (zone === 'actions') {
          if (actionsGroup && actionsGroup.key(a)) return true;
          if (a === 'up') { setZone('chips'); return true; }
          if (a === 'down') { setZone(filtered.length ? 'list' : 'actions'); return true; }
          if (a === 'left') { setZone('chips'); return true; }
          return true;
        }
        /* lista */
        if (vlist.key(a)) return true;
        if (a === 'up') { setZone('chips'); return true; }
        if (a === 'down') { setZone('actions'); return true; }
        if (a === 'left' || a === 'right') return true;
        return true;
      },
      reload: function () { return reload(); },
      debugItems: function () { return all.slice(); }
    };
  };

  /* a tela atual, se for a de Downloads (usada pelo App.downloads.refresh) */
  var originalScreenFactory = App.screens.downloads;
  App.screens.downloads = function () {
    var screen = originalScreenFactory();
    screenApi = screen;
    return screen;
  };

  /* ---------------------------------------------------------------------- */
  /* Botão "Baixar" no overlay de detalhes (sem editar tv/js)               */
  /* ---------------------------------------------------------------------- */

  var detailContext = null;      /* {item, list, seasons, loading} */
  var pendingInject = null;      /* botão a entrar no grupo de botões */
  var observer = null;
  var enhanceTimer = null;

  function makeDetailButton(label, act) {
    var btn = App.ui.btn(label);
    btn.classList.add('dl-detail-btn');
    btn._act = act;
    return btn;
  }

  function downloadButtonLabel(item) {
    return item && item.t === 'series' ? 'Baixar episódio' : 'Baixar';
  }

  function seasonEpisodes(item, list) {
    return Promise.resolve(App.catalog.seriesInfo(item, list)).then(function (info) {
      return (info && info.seasons) || [];
    });
  }

  function episodesMenu(item, list) {
    if (offlineMode() || !isOnline()) {
      toast('Sem conexão — os downloads só podem ser adicionados online.', 4200);
      return;
    }
    seasonEpisodes(item, list).then(function (seasons) {
      var options = [];
      var map = [];
      seasons.forEach(function (season) {
        (season.eps || []).forEach(function (ep) {
          if (options.length >= 200) return;
          options.push({
            label: 'T' + pad2(season.n) + ' • E' + pad2(ep.e) + (ep.title ? ' — ' + ep.title : '')
          });
          map.push({ ep: ep, season: season.n });
        });
      });
      if (!options.length) {
        toast('Nenhum episódio disponível para esta série.');
        return;
      }
      App.ui.menu({
        title: 'Baixar episódio',
        msg: 'Escolha o episódio que será salvo para assistir offline.',
        options: options
      }).then(function (idx) {
        if (idx == null) return;
        var target = map[idx];
        probeInternal(item, list, target.ep, target.season);
      });
    }, function (err) {
      toast(App.friendly ? App.friendly(err && err.code ? err : { code: 'network' }) : 'Não foi possível carregar os episódios.', 4200);
    });
  }

  function mainDownloadAction(item, list) {
    if (item.t === 'series') return episodesMenu(item, list);
    return probeInternal(item, list, null, 0);
  }

  function detailButtonAct(item, list) {
    return function () {
      if (App.player && typeof App.player.isOpen === 'function' && App.player.isOpen()) return;
      mainDownloadAction(item, list);
    };
  }

  /* Embrulha App.ui.group: durante a chamada de App.actions.details injeta o
     botão "Baixar" no MESMO grupo de botões (navegável pelo controle/teclado).
     O tv/js monta a linha `.det-btns` ANTES de criar o grupo, então além de
     entrar em `nodes` o botão precisa ser inserido no DOM logo após "Assistir". */
  if (App.ui && typeof App.ui.group === 'function') {
    var groupOriginal = App.ui.group;
    App.ui.group = function (nodes, horizontal) {
      var inject = pendingInject;
      var list = nodes;
      if (inject && !inject.done && horizontal && Object.prototype.toString.call(nodes) === '[object Array]' && nodes.length >= 2) {
        inject.done = true;
        if (nodes[0] && nodes[0].parentNode && nodes[0].parentNode.insertBefore) {
          try { nodes[0].parentNode.insertBefore(inject.btn, nodes[0].nextSibling || null); } catch (e) { /* ignore */ }
        }
        list = nodes.slice();
        list.splice(1, 0, inject.btn);
      }
      return groupOriginal.call(App.ui, list, horizontal);
    };
  }

  if (App.actions && typeof App.actions.details === 'function') {
    var detailsOriginal = App.actions.details;
    App.actions.details = function (item, resumeEp) {
      if (!item) return detailsOriginal.apply(this, arguments);
      /* contrato §3.4: botão só aparece com player disponível e sessão válida
         (no modo offline a sessão vem do cache do main). */
      if (!App.player || !isSessionUsable()) return detailsOriginal.apply(this, arguments);
      var list = currentList();
      var btn = makeDetailButton(downloadButtonLabel(item), detailButtonAct(item, list));
      pendingInject = { btn: btn, done: false };
      var result;
      try {
        result = detailsOriginal.apply(this, arguments);
      } finally {
        pendingInject = null;
      }
      armDetailEnhance(item, list, btn);
      return result;
    };
  }

  function detailOverlay() {
    return document.querySelector('#overlays .overlay.details');
  }

  function armDetailEnhance(item, list, btn) {
    detailContext = {
      item: item,
      list: list,
      btn: btn,
      seasons: null,
      seasonsLoading: false
    };
    scheduleEnhance();
  }

  function activeSeasonNumber() {
    var overlay = detailOverlay();
    if (!overlay) return 1;
    var chips = overlay.querySelectorAll('.seasons .btn');
    for (var i = 0; i < chips.length; i++) {
      if (chips[i].classList.contains('primary')) {
        var m = /(\d+)/.exec(chips[i].textContent || '');
        if (m) return Number(m[1]);
      }
    }
    var m2 = /(\d+)/.exec((chips[0] && chips[0].textContent) || '');
    return m2 ? Number(m2[1]) : 1;
  }

  function findEpisode(episodeNumber, seasonNumber, title) {
    if (!detailContext || !detailContext.seasons) return null;
    for (var i = 0; i < detailContext.seasons.length; i++) {
      var season = detailContext.seasons[i];
      if (Number(season.n) !== Number(seasonNumber)) continue;
      for (var j = 0; j < season.eps.length; j++) {
        var ep = season.eps[j];
        if (Number(ep.e) === Number(episodeNumber)) return { ep: ep, season: Number(season.n) };
      }
      /* fallback por título (temporadas com numeração fora do padrão) */
      for (var k = 0; k < season.eps.length; k++) {
        if (title && season.eps[k].title && App.norm(season.eps[k].title) === App.norm(title)) {
          return { ep: season.eps[k], season: Number(season.n) };
        }
      }
    }
    return null;
  }

  function ensureSeasons() {
    if (!detailContext || detailContext.seasons || detailContext.seasonsLoading) return;
    if (!detailContext.item || detailContext.item.t !== 'series') return;
    var ctx = detailContext;
    ctx.seasonsLoading = true;
    seasonEpisodes(ctx.item, ctx.list).then(function (seasons) {
      if (detailContext !== ctx) return;
      ctx.seasons = seasons || [];
      ctx.seasonsLoading = false;
      enhanceDetail();
    }, function () {
      if (detailContext === ctx) ctx.seasonsLoading = false;
    });
  }

  function injectEpisodeButton(card, episodeInfo) {
    if (!card || !episodeInfo || card.querySelector('.dl-ep-btn')) return;
    var btn = App.el('div', 'dl-ep-btn');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '-1');
    btn.textContent = 'Baixar';
    btn._act = function () {
      if (App.player && typeof App.player.isOpen === 'function' && App.player.isOpen()) return;
      var ctx = detailContext;
      if (!ctx) return;
      probeInternal(ctx.item, ctx.list, episodeInfo.ep, episodeInfo.season);
    };
    card.appendChild(btn);
  }

  function enhanceEpisodes(overlay) {
    if (!detailContext || detailContext.item.t !== 'series') return;
    var cards = overlay.querySelectorAll('.ep-list .card.ep');
    if (!cards.length) return;
    var seasonNumber = activeSeasonNumber();
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.querySelector('.dl-ep-btn')) continue;
      var noEl = card.querySelector('.no');
      var nmEl = card.querySelector('.nm');
      var m = /(\d+)/.exec((noEl && noEl.textContent) || '');
      if (!m) continue;
      var info = findEpisode(Number(m[1]), seasonNumber, nmEl ? nmEl.textContent : '');
      if (!info) { ensureSeasons(); continue; }
      injectEpisodeButton(card, info);
    }
  }

  function ensureMainButton(overlay) {
    if (!detailContext || !overlay) return;
    if (overlay.querySelector('.det-btns .dl-detail-btn')) return;
    var row = overlay.querySelector('.det-btns');
    if (!row) return;
    /* fallback: se o grupo não pôde ser embrulhado (outra tela de detalhes),
       o botão ainda aparece e funciona com mouse */
    var btn = makeDetailButton(downloadButtonLabel(detailContext.item), detailButtonAct(detailContext.item, detailContext.list));
    row.appendChild(btn);
  }

  function enhanceDetail() {
    enhanceTimer = null;
    if (!detailContext) return;
    var overlay = detailOverlay();
    if (!overlay) { detailContext = null; return; }
    if (App.player && typeof App.player.isOpen === 'function' && App.player.isOpen()) return;
    ensureMainButton(overlay);
    if (detailContext.item && detailContext.item.t === 'series') {
      ensureSeasons();
      enhanceEpisodes(overlay);
    }
  }

  function scheduleEnhance() {
    if (enhanceTimer) return;
    enhanceTimer = setTimeout(enhanceDetail, 60);
  }

  function startObserver() {
    if (observer || typeof MutationObserver !== 'function') return;
    var overlays = document.getElementById('overlays');
    if (!overlays) return;
    observer = new MutationObserver(function () {
      if (App.player && typeof App.player.isOpen === 'function' && App.player.isOpen()) return;
      if (!detailContext) return;
      scheduleEnhance();
    });
    observer.observe(overlays, { childList: true, subtree: true });
  }

  /* O overlay de detalhes é criado de forma assíncrona (temporadas/episódios),
     então observamos #overlays desde já. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }

  ensureCss();
})(window);
