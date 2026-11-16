/* EPG do Space IPTV Desktop: descoberta da fonte, download em fluxo (gzip), parser incremental,
 * cache em blocos no IndexedDB existente (`spaceiptv`/`kv`) e consulta "agora / a seguir".
 *
 * Contrato (CONTRACTS.md §3.5):
 *   App.epg = { load(list), refresh(list), now(item, t?), next(item, t?), state(),
 *               open(), close(), onChange(cb) }
 * Extras usados pela tela Guia / cards (mesmo modulo):
 *   channelOf(item), programsOf(item|channelId), prefetch(items), channels(),
 *   hasData(), dropCache(listId), __reset().
 *
 * Fonte:
 *  - M3U:  App.catalog.data.head['url-tvg'] | head['x-tvg-url'] (varias URLs separadas por espaco)
 *  - Xtream: creds.server + '/xmltv.php?username=..&password=..' (credenciais so em memoria)
 * Download: fetch('/_epg/source?url=...') com fallback fetch(url) direto; gzip detectado pelos bytes
 * (0x1f 0x8b) e descomprimido com DecompressionStream quando o Chromium nao decodificou sozinho.
 *
 * Cache por lista (nunca toca em chaves cat.* ou eps.* nem no banco spaceiptv-sync):
 *   epg.meta.<listId>  {v, fetchedAt, ttlH, channelCount, programmeCount, source, chunks, bytes}
 *   epg.idx.<listId>   {v, channels:[{id,n,icon,segs:[{c,o,l}],count}], chunkCount, ...}
 *   epg.ch.<listId>.<i> bloco de ate 500 programas ([start, stop, title, desc, category])
 * Os programas sao lidos por bloco sob demanda (canal visivel), nunca o XMLTV inteiro a cada render.
 */
(function (g) {
  'use strict';
  var App = g.App;
  if (!App) return;
  /* fallback dinamico: se o dono do index.html ainda nao incluiu epg.js, nao duplica listeners/estado */
  if (App.epg && App.epg.__epgV1) return;

  var doc = g.document || null;
  var DEFAULT_TTL_H = 24;
  var CHUNK = 500;
  var CACHE_V = 1;
  var MAX_CHUNK_CACHE = 16;
  var MAX_CHANNEL_CACHE = 48;
  var DEFAULT_OFFSET_MIN = 0;   /* XMLTV sem fuso: UTC (deterministico; o formato padrao traz offset) */

  var BASE = 'js/epg/';
  try {
    if (doc && doc.currentScript && doc.currentScript.src) BASE = String(doc.currentScript.src).replace(/[^\/]*$/, '');
  } catch (e) { /* mantem o caminho padrao */ }

  var parserP = null;
  var mem = null;              /* indice em memoria da lista atual: {listId, meta, channels, byId, byIdLower, byName, chunkCount} */
  var memChunks = {};          /* cache de blocos lidos (i -> rows) */
  var memChunkP = {};          /* leituras em andamento (i -> Promise) */
  var chunkOrder = [];
  var channelOrder = [];
  var st = idleState();
  var busy = {};               /* listId -> Promise (load) */
  var refreshing = {};         /* listId -> Promise (refresh) */
  var subs = [];

  /* ------------------------------------------------------------------ estado */
  function idleState() {
    return {
      status: 'idle', listId: null, listName: '',
      channelCount: 0, programmeCount: 0,
      fetchedAt: 0, ttlH: DEFAULT_TTL_H, expiresAt: 0, stale: false,
      from: 0, to: 0,
      source: '', error: '', progress: -1, fromCache: false, refreshing: false
    };
  }
  function state() {
    return {
      status: st.status, listId: st.listId, listName: st.listName,
      channelCount: st.channelCount, programmeCount: st.programmeCount,
      fetchedAt: st.fetchedAt, ttlH: st.ttlH, expiresAt: st.expiresAt, stale: st.stale,
      from: st.from, to: st.to,
      source: st.source, error: st.error, progress: st.progress,
      fromCache: st.fromCache, refreshing: st.refreshing
    };
  }
  function setState(patch) { for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) st[k] = patch[k]; }

  function emit(ev, data) { try { App.bus.emit(ev, data); } catch (e) { /* assinante com erro nao derruba o EPG */ } }
  function publish() {
    var s = state();
    subs.slice().forEach(function (fn) { try { fn(s); } catch (e) { /* ignore */ } });
    emit('epg', s);
  }

  /* ------------------------------------------------------------------ utils */
  function norm(s) {
    if (App.epgParse && typeof App.epgParse.normName === 'function') return App.epgParse.normName(s);
    var t = String(s == null ? '' : s).toLowerCase();
    try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { /* sem normalize */ }
    return t.replace(/[^a-z0-9]+/g, '');
  }
  function isHttp(u) { return typeof u === 'string' && /^https?:\/\//i.test(u); }
  function metaKey(id) { return 'epg.meta.' + id; }
  function idxKey(id) { return 'epg.idx.' + id; }
  function chunkKey(id, i) { return 'epg.ch.' + id + '.' + i; }
  function countOf(ch) {
    if (!ch) return 0;
    if (ch.count != null) return ch.count;
    var n = 0, i;
    for (i = 0; ch.segs && i < ch.segs.length; i++) n += ch.segs[i].l || 0;
    return n;
  }
  function ttlMs(h) { return Math.max(1, Number(h) || DEFAULT_TTL_H) * 3600 * 1000; }
  function expired(meta, ttlH) {
    return !meta || !meta.fetchedAt || (Date.now() - meta.fetchedAt) > ttlMs(ttlH);
  }

  /* TTL configuravel via space.config.get().epgTtlHours (fallback 24h se o bridge nao existir).
     Sem memo: a tela de Configuracoes pode mudar o TTL e pedir refresh logo em seguida. */
  function ttlHours() {
    var bridge = g.space;
    if (!bridge || !bridge.config || typeof bridge.config.get !== 'function') return Promise.resolve(DEFAULT_TTL_H);
    return Promise.resolve().then(function () { return bridge.config.get(); }).then(function (c) {
      var h = Number(c && c.epgTtlHours);
      if (isFinite(h) && h >= 1 && h <= 24 * 30) return h;
      return DEFAULT_TTL_H;
    }, function () { return DEFAULT_TTL_H; });
  }

  function friendlyError(e) {
    var c = e && e.code;
    if (c === 'invalid') return 'O guia de programação recebido não é um XMLTV válido.';
    if (c === 'http') return 'O servidor do guia de programação recusou a requisição (código ' + ((e && e.status) || '?') + ').';
    if (c === 'offline') return 'Sem conexão com a internet. O guia salvo continua disponível.';
    if (c === 'timeout') return 'O guia de programação demorou demais para responder.';
    if (c === 'parse') return 'O guia de programação veio em um formato inesperado (gzip inválido?).';
    return 'Não foi possível carregar o guia de programação. Verifique a URL do EPG na lista.';
  }

  /* ------------------------------------------------------- descoberta da fonte */
  function headOf(list) {
    var d = App.catalog && App.catalog.data;
    if (d && d.head && (d.head['url-tvg'] || d.head['x-tvg-url']) && App.catalog.listId === list.id) {
      return Promise.resolve(d.head);
    }
    /* lista nao ativa (ou catalogo ainda nao carregado): le o cache do catalogo sem tocar em nada */
    if (!App.idb) return Promise.resolve(d && d.head ? d.head : null);
    return App.idb.get('cat.' + list.id).then(function (c) {
      return (c && c.data && c.data.head) || (d && d.head) || null;
    }, function () { return (d && d.head) || null; });
  }

  function sourceOf(list) {
    if (!list) return Promise.resolve(null);
    if (list.type === 'xtream') {
      return Promise.resolve(App.lists && typeof App.lists.creds === 'function' ? App.lists.creds(list) : null).then(function (c) {
        if (!c || !c.server) return null;
        var base = String(c.server).replace(/\/+$/, '');
        return {
          url: base + '/xmltv.php?username=' + encodeURIComponent(c.user || '') + '&password=' + encodeURIComponent(c.pass || ''),
          label: base + '/xmltv.php',   /* sem credenciais no rotulo guardado no cache */
          kind: 'xtream'
        };
      });
    }
    return headOf(list).then(function (head) {
      if (!head) return null;
      var raw = head['url-tvg'] || head['x-tvg-url'] || head['tvg-url'] || '';
      var urls = String(raw).split(/[\s,]+/).filter(isHttp);
      if (!urls.length) return null;
      return { url: urls[0], label: urls[0], kind: 'm3u' };
    });
  }

  /* ------------------------------------------------------------ download fluxo */
  var lastProgressPct = -1;
  function reportProgress(loaded, total) {
    var p = total > 0 ? Math.min(0.99, loaded / total) : -1;
    if (p >= 0) {
      var q = Math.floor(p * 100);
      if (q === lastProgressPct) return;
      lastProgressPct = q;
    } else if (lastProgressPct === -2) return;
    lastProgressPct = p >= 0 ? lastProgressPct : -2;
    setState({ progress: p });
    emit('epg:loading', { listId: st.listId, progress: p });
  }

  function decodeAllBytes(bytes) {
    var gz = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (!gz) return new g.TextDecoder('utf-8').decode(bytes);
    if (typeof g.DecompressionStream !== 'function' || typeof g.ReadableStream !== 'function' || typeof g.Response !== 'function') {
      throw { code: 'parse' };
    }
    /* sem streaming disponivel: descomprime o buffer inteiro */
    var stream = new g.Response(bytes).body.pipeThrough(new g.DecompressionStream('gzip'));
    var rd = stream.getReader(), out = '';
    return (function pump() {
      return rd.read().then(function (d) {
        if (d.done) return out;
        out += new g.TextDecoder('utf-8').decode(d.value, { stream: true });
        return pump();
      });
    })().then(function () { return out; });
  }

  /* Le a resposta byte a byte, detecta gzip pelo magic e entrega texto UTF-8 em pedacos. */
  function decodeResponse(res, sink) {
    var total = parseInt(res.headers.get('content-length'), 10) || 0;
    var body = res.body;
    var dec = new g.TextDecoder('utf-8');
    var loaded = 0;

    if (!body || typeof body.getReader !== 'function' || typeof g.TextDecoder !== 'function') {
      return res.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf);
        sink(decodeAllBytes(bytes));
        reportProgress(bytes.length, bytes.length);
        return { bytes: bytes.length };
      });
    }

    var reader = body.getReader();

    function finishText() { sink(dec.decode()); return { bytes: loaded }; }
    function pumpText() {
      return reader.read().then(function (d) {
        if (d.done) return finishText();
        loaded += d.value.byteLength || d.value.length;
        reportProgress(loaded, total);
        sink(dec.decode(d.value, { stream: true }));
        return pumpText();
      });
    }
    function pumpGz(stream) {
      var rd = stream.getReader();
      return (function pump() {
        return rd.read().then(function (d) {
          if (d.done) return finishText();
          sink(dec.decode(d.value, { stream: true }));
          return pump();
        });
      })();
    }

    return reader.read().then(function (first) {
      if (first.done) { sink(''); return { bytes: 0 }; }
      var v = first.value;
      loaded += v.byteLength || v.length;
      reportProgress(loaded, total);
      var gz = v.length > 1 && v[0] === 0x1f && v[1] === 0x8b;
      if (gz) {
        if (typeof g.DecompressionStream !== 'function' || typeof g.ReadableStream !== 'function') throw { code: 'parse' };
        var firstBuf = v;
        var src = new g.ReadableStream({
          pull: function (c) {
            if (firstBuf) { c.enqueue(firstBuf); firstBuf = null; return; }
            return reader.read().then(function (d) {
              if (d.done) { c.close(); return; }
              loaded += d.value.byteLength || d.value.length;
              reportProgress(loaded, total);
              c.enqueue(d.value);
            }, function (e) { c.error(e); });
          }
        });
        return pumpGz(src.pipeThrough(new g.DecompressionStream('gzip')));
      }
      sink(dec.decode(v, { stream: true }));
      return pumpText();
    });
  }

  /* O host do guia pode nao estar na allowlist do servidor interno (ela e montada a partir
     das listas/catalogo). Registra best-effort antes de usar /_epg/source. Sem efeito fora do
     desktop ou se o bridge ainda nao existir. */
  var registeredHosts = {};
  function registerSourceHost(url) {
    var host = '';
    try { host = String(new g.URL(url).hostname || '').toLowerCase(); } catch (e) { return Promise.resolve(); }
    if (!host || registeredHosts[host]) return Promise.resolve();
    var api = App.desktop && App.desktop.api;
    if (!api || typeof api.registerMediaHosts !== 'function') return Promise.resolve();
    registeredHosts[host] = true;
    return Promise.resolve(api.registerMediaHosts([host])).then(null, function () { registeredHosts[host] = false; });
  }

  function fetchOne(target, viaServer, sink, fetchOpts) {
    if (typeof g.fetch !== 'function') return Promise.reject({ code: 'network' });
    fetchOpts = fetchOpts || {};
    return g.fetch(target, fetchOpts).then(function (res) {
      if (!res.ok) {
        /* rota interna inexistente OU host ainda fora da allowlist: tenta o fetch direto */
        if (viaServer && (res.status === 400 || res.status === 401 || res.status === 403 ||
          res.status === 404 || res.status === 405 || res.status === 501)) return { fallback: true };
        throw { code: 'http', status: res.status };
      }
      return decodeResponse(res, sink);
    }, function () {
      if (viaServer) return { fallback: true };   /* rota interna ainda nao existe: tenta direto */
      throw { code: 'network' };
    });
  }

  function fetchEpg(src, sink) {
    var ctl = typeof g.AbortController === 'function' ? new g.AbortController() : null;
    var opts = ctl ? { cache: 'no-store', credentials: 'same-origin', signal: ctl.signal } : { cache: 'no-store', credentials: 'same-origin' };
    var via = '/_epg/source?url=' + encodeURIComponent(src.url);
    function abort() { if (ctl) { try { ctl.abort(); } catch (e) { /* ignore */ } } }
    function go() {
      return fetchOne(via, true, sink, opts).then(function (r) {
        if (r && r.fallback) return fetchOne(src.url, false, sink, opts);
        return r;
      }).then(function (r) {
        if (r && r.fallback) throw { code: 'network' };
        return r;
      }, function (e) { abort(); throw e; });
    }
    return registerSourceHost(src.url).then(go, go);
  }

  /* ------------------------------------------------------------------ parser */
  function ensureParser() {
    if (App.epgParse) return Promise.resolve(App.epgParse);
    if (parserP) return parserP;
    parserP = loadScript(BASE + 'epg-parse.js', function () { return !!App.epgParse; }).then(function (ok) {
      if (!ok || !App.epgParse) throw { code: 'parse' };
      return App.epgParse;
    });
    return parserP;
  }

  function fetchAndParse(src, progressSink) {
    return ensureParser().then(function (api) {
      var parser = new api.Parser({ defaultOffsetMin: DEFAULT_OFFSET_MIN });
      var bytes = 0;
      lastProgressPct = -1;
      /* erro do parser (XML invalido) vira {code:'invalid'}; erro de rede preserva o code */
      function feed(text) {
        try { parser.feed(text); } catch (e) { throw (e && e.code) ? e : { code: 'invalid' }; }
      }
      return fetchEpg(src, function (text) {
        if (progressSink) progressSink();
        feed(text);
      }).then(function (r) {
        bytes = (r && r.bytes) || 0;
        var res;
        try { res = parser.end(); } catch (e) { throw (e && e.code) ? e : { code: 'invalid' }; }
        res.bytes = bytes;
        return res;
      });
    });
  }

  /* -------------------------------------------------------- cache: estrutura */
  /* transforma o resultado do parser em blocos + indice + meta */
  function buildCache(res) {
    var byId = {}, order = [], i, p, cid;
    var minS = Infinity, maxE = -Infinity;
    for (i = 0; i < res.channels.length; i++) {
      var ch = res.channels[i];
      if (!ch.id) continue;
      if (!byId[ch.id]) { byId[ch.id] = { id: ch.id, names: (ch.names || []).slice(), icon: ch.icon || '', progs: [] }; order.push(ch.id); }
    }
    for (i = 0; i < res.programmes.length; i++) {
      p = res.programmes[i];
      var rec = byId[p.c];
      if (!rec) { rec = byId[p.c] = { id: p.c, names: [], icon: '', progs: [] }; order.push(p.c); }
      rec.progs.push(p);
      if (p.s < minS) minS = p.s;
      if (p.e > maxE) maxE = p.e;
    }

    var chunks = [], idxChannels = [], total = 0;
    for (i = 0; i < order.length; i++) {
      var c = byId[order[i]];
      var arr = c.progs;
      arr.sort(function (a, b) { return (a.s - b.s) || ((a.e || 0) - (b.e || 0)); });
      /* stop ausente/invalido: completa com o proximo inicio ou +1h */
      for (var k = 0; k < arr.length; k++) {
        if (!arr[k].e || arr[k].e <= arr[k].s) {
          arr[k].e = k + 1 < arr.length && arr[k + 1].s > arr[k].s ? arr[k + 1].s : arr[k].s + 3600000;
        }
      }
      /* bloco de ate 500 programas, sem dividir canal entre blocos quando cabe */
      var segs = [], pos = 0;
      while (pos < arr.length) {
        if (!chunks.length || chunks[chunks.length - 1].length >= CHUNK) chunks.push([]);
        var ci = chunks.length - 1, room = CHUNK - chunks[ci].length;
        var take = Math.min(room, arr.length - pos), off = chunks[ci].length, j;
        for (j = 0; j < take; j++) {
          var pr = arr[pos + j];
          chunks[ci].push([pr.s, pr.e, pr.t || '', pr.d || '', pr.cat || '']);
        }
        segs.push({ c: ci, o: off, l: take });
        pos += take;
      }
      if (arr.length) idxChannels.push({ id: c.id, n: c.names, icon: c.icon, segs: segs, count: arr.length });
      total += arr.length;
    }
    return {
      chunks: chunks, idxChannels: idxChannels,
      channelCount: idxChannels.length, programmeCount: total,
      from: minS === Infinity ? 0 : minS, to: maxE === -Infinity ? 0 : maxE
    };
  }

  function writeChunks(listId, chunks) {
    var i = 0;
    return new Promise(function (resolve, reject) {
      (function next() {
        if (i >= chunks.length) return resolve();
        var at = i++;
        App.idb.put(chunkKey(listId, at), chunks[at]).then(function () {
          if (at % 12 === 11) setTimeout(next, 0); else next();
        }, reject);
      })();
    });
  }

  function deleteExtraChunks(listId, from, to) {
    var ps = [], i;
    for (i = from; i < to; i++) ps.push(App.idb.del(chunkKey(listId, i)));
    return Promise.all(ps);
  }

  function saveCache(listId, built, ttlH, srcLabel, bytes) {
    var meta = {
      v: CACHE_V, fetchedAt: Date.now(), ttlH: ttlH,
      channelCount: built.channelCount, programmeCount: built.programmeCount,
      from: built.from, to: built.to,
      source: srcLabel || '', chunks: built.chunks.length, bytes: bytes || 0
    };
    var idx = {
      v: CACHE_V, channels: built.idxChannels, chunkCount: built.chunks.length,
      channelCount: built.channelCount, programmeCount: built.programmeCount,
      from: built.from, to: built.to
    };
    return App.idb.get(metaKey(listId)).then(function (old) {
      return writeChunks(listId, built.chunks).then(function () {
        return App.idb.put(idxKey(listId), idx);
      }).then(function () {
        return App.idb.put(metaKey(listId), meta);   /* meta por ultimo: e o "commit" do cache */
      }).then(function () {
        if (old && old.chunks > built.chunks.length) return deleteExtraChunks(listId, built.chunks.length, old.chunks);
      }).then(function () { return { meta: meta, idx: idx }; });
    });
  }

  function loadCache(listId) {
    return Promise.all([App.idb.get(metaKey(listId)), App.idb.get(idxKey(listId))]).then(function (a) {
      var meta = a[0], idx = a[1];
      if (!meta || !idx || !idx.channels || meta.v !== CACHE_V || idx.v !== CACHE_V) return null;
      if (!meta.fetchedAt || meta.chunks !== idx.chunkCount) return null;
      return { meta: meta, idx: idx };
    }, function () { return null; });
  }

  /* ------------------------------------------------------ cache: indice em RAM */
  function applyCache(list, meta, idx) {
    mem = {
      listId: list.id,
      meta: meta,
      channels: idx.channels || [],
      byId: {},
      byIdLower: {},
      byName: {},
      chunkCount: idx.chunkCount || 0
    };
    var i, k, ch, names;
    for (i = 0; i < mem.channels.length; i++) {
      ch = mem.channels[i];
      ch.count = countOf(ch);
      if (ch.id) {
        mem.byId[ch.id] = ch;
        mem.byIdLower[String(ch.id).toLowerCase()] = ch;
      }
      names = ch.n || [];
      for (k = 0; k < names.length; k++) {
        var nk = norm(names[k]);
        if (!nk) continue;
        (mem.byName[nk] = mem.byName[nk] || []).push(ch);
      }
    }
    memChunks = {}; memChunkP = {}; chunkOrder = []; channelOrder = [];
    setState({
      status: 'ready', listId: list.id, listName: list.name || '',
      channelCount: idx.channelCount || 0, programmeCount: idx.programmeCount || 0,
      fetchedAt: meta.fetchedAt, ttlH: meta.ttlH || DEFAULT_TTL_H,
      expiresAt: meta.fetchedAt + ttlMs(meta.ttlH || DEFAULT_TTL_H),
      stale: expired(meta, meta.ttlH || DEFAULT_TTL_H),
      from: meta.from || 0, to: meta.to || 0,
      source: meta.source || '', error: '', fromCache: true, progress: 1, refreshing: false
    });
  }
  function clearMem() {
    mem = null; memChunks = {}; memChunkP = {}; chunkOrder = []; channelOrder = [];
  }

  function rememberChunk(i, rows) {
    memChunks[i] = rows;
    chunkOrder.push(i);
    while (chunkOrder.length > MAX_CHUNK_CACHE) {
      var old = chunkOrder.shift();
      if (old != null && old !== i) delete memChunks[old];
    }
  }
  function getChunk(i) {
    if (!mem) return Promise.resolve(null);
    var key = String(i);
    if (Object.prototype.hasOwnProperty.call(memChunks, key)) return Promise.resolve(memChunks[key]);
    if (memChunkP[key]) return memChunkP[key];
    var listId = mem.listId;
    var p = App.idb.get(chunkKey(listId, i)).then(function (rows) {
      delete memChunkP[key];
      if (!mem || mem.listId !== listId) return null;
      if (!Array.isArray(rows)) return null;
      rememberChunk(i, rows);
      return rows;
    }, function () { delete memChunkP[key]; return null; });
    memChunkP[key] = p;
    return p;
  }
  function rememberChannel(ch) {
    channelOrder.push(ch.id);
    while (channelOrder.length > MAX_CHANNEL_CACHE) {
      var oldId = channelOrder.shift();
      if (oldId && mem && mem.byId[oldId] && oldId !== ch.id) delete mem.byId[oldId].__arr;
    }
  }

  function loadChannelData(ch) {
    if (!ch) return Promise.resolve(null);
    if (ch.__arr) return Promise.resolve(ch.__arr);
    if (ch.__p) return ch.__p;
    var listId = mem && mem.listId;
    var segs = ch.segs || [];
    ch.__p = Promise.all(segs.map(function (s) { return getChunk(s.c); })).then(function (parts) {
      if (!mem || mem.listId !== listId) { ch.__p = null; return null; }
      var out = [], i, k, rows, seg, row;
      for (i = 0; i < segs.length; i++) {
        seg = segs[i]; rows = parts[i];
        if (!rows) continue;
        for (k = 0; k < seg.l; k++) {
          row = rows[seg.o + k];
          if (!row) continue;
          out.push({ s: row[0], e: row[1], t: row[2] || '', d: row[3] || '', cat: row[4] || '' });
        }
      }
      out.sort(function (a, b) { return (a.s - b.s) || (a.e - b.e); });
      ch.__arr = out; ch.__p = null;
      rememberChannel(ch);
      emit('epg:chunk', { listId: listId, id: ch.id });
      return out;
    }, function () { ch.__p = null; return null; });
    return ch.__p;
  }

  /* -------------------------------------------------------------- consultas */
  function channelOf(item) {
    if (!mem || !item) return null;
    var id = item.ti || item.tvg || item['tvg-id'] || item.epgId || '';
    var c = null;
    if (id) c = mem.byId[id] || mem.byIdLower[String(id).toLowerCase()];
    if (c) return c;
    var k = norm(item.n || item.name || '');
    if (!k) return null;
    var list = mem.byName[k];
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) if (countOf(list[i]) > 0) return list[i];
    return list[0];
  }

  function lastStartLE(arr, ts) {
    var lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].s <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  function firstStartGT(arr, ts) {
    var lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].s > ts) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ans;
  }
  function resultOf(pr, ts, isNext) {
    var dur = pr.e > pr.s ? pr.e - pr.s : 0;
    return {
      title: pr.t || '', desc: pr.d || '',
      start: pr.s, stop: pr.e,
      progress: isNext || !dur ? 0 : Math.min(1, Math.max(0, (ts - pr.s) / dur)),
      duration: dur, category: pr.cat || ''
    };
  }

  function now(item, t) {
    var ch = channelOf(item);
    if (!ch) return null;
    if (!ch.__arr) { loadChannelData(ch); return null; }   /* primeiro uso do canal: carrega e avisa */
    var ts = t == null ? Date.now() : Number(t);
    if (!isFinite(ts)) ts = Date.now();
    var arr = ch.__arr, i = lastStartLE(arr, ts), guard;
    /* programas podem se sobrepor: pega o de maior inicio que ainda contem o horario */
    for (guard = 0; i >= 0 && guard < 64; i--, guard++) {
      if (arr[i].e > ts && arr[i].s <= ts) return resultOf(arr[i], ts, false);
    }
    return null;
  }

  function next(item, t) {
    var ch = channelOf(item);
    if (!ch) return null;
    if (!ch.__arr) { loadChannelData(ch); return null; }
    var ts = t == null ? Date.now() : Number(t);
    if (!isFinite(ts)) ts = Date.now();
    var i = firstStartGT(ch.__arr, ts);
    if (i < 0) return null;
    return resultOf(ch.__arr[i], ts, true);
  }

  function programsOf(itemOrId) {
    if (!mem) return Promise.resolve([]);
    var ch = typeof itemOrId === 'string'
      ? (mem.byId[itemOrId] || mem.byIdLower[String(itemOrId).toLowerCase()] || null)
      : channelOf(itemOrId);
    if (!ch) return Promise.resolve([]);
    return loadChannelData(ch).then(function (arr) { return arr || []; });
  }

  function prefetch(items) {
    if (!mem || !items) return Promise.resolve();
    var ps = [];
    for (var i = 0; i < items.length; i++) {
      var ch = channelOf(items[i]);
      if (ch && countOf(ch) > 0 && !ch.__arr && !ch.__p) ps.push(loadChannelData(ch));
    }
    return Promise.all(ps);
  }

  function channels() {
    if (!mem) return [];
    var out = [], i, ch;
    for (i = 0; i < mem.channels.length; i++) {
      ch = mem.channels[i];
      if (countOf(ch) > 0) out.push({ id: ch.id, name: (ch.n && ch.n[0]) || ch.id, names: (ch.n || []).slice(), icon: ch.icon || '', count: countOf(ch) });
    }
    return out;
  }

  /* -------------------------------------------------------------- load/refresh */
  function beginList(list) {
    var same = st.listId === list.id;
    if (!same) {
      clearMem();
      setState(idleState());
      setState({ listId: list.id, listName: list.name || '' });
    } else {
      setState({ listName: list.name || st.listName });
    }
  }

  function applyFetchOk(list, src, ttlH, res) {
    var built = buildCache(res);
    return saveCache(list.id, built, ttlH, src.label, res.bytes).then(function (saved) {
      applyCache(list, saved.meta, saved.idx);
      setState({ fromCache: false, stale: false, refreshing: false, error: '', progress: 1 });
      emit('epg:done', {
        listId: list.id, channelCount: saved.meta.channelCount, programmeCount: saved.meta.programmeCount,
        fetchedAt: saved.meta.fetchedAt, ttlH: ttlH, fromCache: false
      });
      publish();
      return state();
    });
  }

  function refreshImpl(list, src, ttlH, opts) {
    var id = list.id;
    if (refreshing[id]) return refreshing[id];
    var hadData = st.listId === id && st.status === 'ready' && !!mem;
    setState({ refreshing: true, error: '' });
    emit('epg:loading', { listId: id, progress: -1 });
    publish();
    var p = fetchAndParse(src).then(function (res) {
      return applyFetchOk(list, src, ttlH, res);
    }).then(function (s) {
      delete refreshing[id];
      return s;
    }, function (e) {
      delete refreshing[id];
      var msg = friendlyError(e);
      setState({
        refreshing: false, error: msg, progress: -1,
        status: hadData ? 'ready' : 'error',
        stale: hadData ? true : st.stale
      });
      emit('epg:error', { listId: id, message: msg, code: (e && e.code) || 'network' });
      publish();
      return state();
    });
    refreshing[id] = p;
    return p;
  }

  function load(list) {
    if (!list || !list.id) return Promise.resolve(state());
    var id = list.id;
    if (st.listId === id && st.status === 'ready' && mem && !expired(mem.meta, st.ttlH)) {
      return Promise.resolve(state());   /* cache valido em memoria: nada a fazer */
    }
    if (busy[id]) return busy[id];
    beginList(list);
    var p;
    try {
      p = ensureParser().then(function () { return ttlHours(); }).then(function (ttlH) {
        return Promise.all([loadCache(id), sourceOf(list)]).then(function (r) {
          var cache = r[0], src = r[1];
          if (cache) {
            applyCache(list, cache.meta, cache.idx);
            setState({ ttlH: ttlH, expiresAt: cache.meta.fetchedAt + ttlMs(ttlH) });
            if (!expired(cache.meta, ttlH)) {
              emit('epg:done', {
                listId: id, channelCount: st.channelCount, programmeCount: st.programmeCount,
                fetchedAt: st.fetchedAt, ttlH: ttlH, fromCache: true
              });
              publish();
              return state();
            }
            /* cache vencido: mostra o antigo e atualiza em background */
            setState({ stale: true });
            publish();
            if (!src) return state();   /* sem fonte agora (offline?): mantem o cache vencido e o erro claro */
            return refreshImpl(list, src, ttlH, { background: true }).then(function () { return state(); });
          }
          if (!src) {
            clearMem();
            setState({
              status: 'none', listId: id, listName: list.name || '', channelCount: 0, programmeCount: 0,
              error: '', source: '', progress: -1, refreshing: false
            });
            publish();
            return state();
          }
          return refreshImpl(list, src, ttlH, {}).then(function () { return state(); });
        });
      });
    } catch (e) {
      p = Promise.reject(e);
    }
    p = p.then(function (s) { delete busy[id]; return s; }, function (e) {
      delete busy[id];
      var msg = friendlyError(e);
      setState({ status: st.status === 'ready' ? 'ready' : 'error', error: msg, refreshing: false, progress: -1 });
      emit('epg:error', { listId: id, message: msg, code: (e && e.code) || 'network' });
      publish();
      return state();
    });
    busy[id] = p;
    return p;
  }

  function refresh(list) {
    var target = list || (App.lists && typeof App.lists.active === 'function' ? App.lists.active() : null);
    if (!target || !target.id) return Promise.reject({ code: 'list', message: 'Nenhuma lista ativa.' });
    var id = target.id;
    if (busy[id]) return busy[id];
    beginList(target);
    var p = ensureParser().then(function () { return ttlHours(); }).then(function (ttlH) {
      return sourceOf(target).then(function (src) {
        if (!src) {
          if (!mem) {
            setState({ status: 'none', listId: id, listName: target.name || '', error: '', progress: -1, refreshing: false });
            publish();
          }
          return state();
        }
        return refreshImpl(target, src, ttlH, { force: true }).then(function () { return state(); });
      });
    });
    p = p.then(function (s) {
      delete busy[id];
      if (s && s.status === 'none') throw { code: 'none', message: 'Esta lista não fornece EPG.', silent: true };
      if (s && s.error) throw { code: 'epg', message: s.error, silent: true };
      return s;
    }, function (e) {
      delete busy[id];
      var msg = friendlyError(e);
      setState({ status: st.status === 'ready' ? 'ready' : 'error', error: msg, refreshing: false, progress: -1 });
      emit('epg:error', { listId: id, message: msg, code: (e && e.code) || 'network' });
      publish();
      throw { code: (e && e.code) || 'network', message: msg, status: (e && e.status) || 0 };
    });
    busy[id] = p;
    return p;
  }

  function dropCache(listId) {
    if (!listId || !App.idb) return Promise.resolve();
    return App.idb.get(metaKey(listId)).then(function (meta) {
      var ps = [App.idb.del(metaKey(listId)), App.idb.del(idxKey(listId))];
      var n = (meta && meta.chunks) || 0, i;
      for (i = 0; i < n; i++) ps.push(App.idb.del(chunkKey(listId, i)));
      return Promise.all(ps);
    }).then(function () {
      if (st.listId === listId) {
        clearMem();
        setState(idleState());
        publish();
      }
    }, function () { /* sem cache a apagar */ });
  }

  /* ------------------------------------------------------------ atalhos/UI */
  function open(list) {
    if (App.desktop && App.desktop.guide && typeof App.desktop.guide.open === 'function') {
      return App.desktop.guide.open(list);
    }
    return load(list || (App.lists && App.lists.active ? App.lists.active() : null));
  }
  function close() {
    if (App.desktop && App.desktop.guide && typeof App.desktop.guide.close === 'function') return App.desktop.guide.close();
    return false;
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    subs.push(cb);
    return function () { var i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); };
  }

  /* ------------------------------------------------- bootstrap defensivo */
  function loadScript(src, ready) {
    if (ready()) return Promise.resolve(true);
    if (!doc || typeof doc.createElement !== 'function') return Promise.resolve(false);
    return new Promise(function (resolve) {
      var s = doc.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { resolve(ready()); };
      s.onerror = function () { resolve(false); };
      (doc.head || doc.documentElement).appendChild(s);
    });
  }
  function ensureCss() {
    try {
      if (!doc || typeof doc.createElement !== 'function') return;
      if (doc.querySelector('link[href*="epg.css"]')) return;
      var l = doc.createElement('link');
      l.rel = 'stylesheet'; l.href = BASE + '../css/epg.css';
      (doc.head || doc.documentElement).appendChild(l);
    } catch (e) { /* CSS e enfeite: sem ele o guia ainda funciona */ }
  }
  function ensureLive() {
    if (App.epg && App.epg.__liveLoaded) return;
    loadScript(BASE + 'live-epg.js', function () { return !!(App.epg && App.epg.__liveLoaded); });
  }
  function bootFallbacks() {
    ensureCss();
    if (!doc) return;
    if (doc.readyState === 'complete') setTimeout(ensureLive, 0);
    else if (typeof g.addEventListener === 'function') g.addEventListener('load', ensureLive, { once: true });
  }

  if (App.bus && typeof App.bus.on === 'function') {
    App.bus.on('lists', function (e) {
      if (e && e.action === 'remove' && e.id) dropCache(e.id);
    });
  }

  var api = {
    __epgV1: true,
    CHUNK: CHUNK,
    DEFAULT_TTL_H: DEFAULT_TTL_H,
    load: load,
    refresh: refresh,
    now: now,
    next: next,
    state: state,
    onChange: onChange,
    open: open,
    close: close,

    /* usados pela tela Guia e pelos cards */
    channelOf: channelOf,
    programsOf: programsOf,
    prefetch: prefetch,
    channels: channels,
    hasData: function () { return st.status === 'ready' && st.programmeCount > 0; },
    refreshing: function () { return !!st.refreshing; },
    dropCache: dropCache,
    __reset: function () {
      clearMem(); setState(idleState());
      busy = {}; refreshing = {}; registeredHosts = {}; parserP = null;
    }
  };
  App.epg = api;
  bootFallbacks();
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
