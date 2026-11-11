(function (g) {
  'use strict';
  var App = g.App;

  var DEFAULTS = {
    concurrency: 3, timeout: 8000, retry: 1, cache: 60000,
    /* limites de latencia (ms) — ajustados apos medir a TV: live TS costuma gastar 2-3 s no handshake.
       Troque em tempo de execucao com App.health.configure({green: 1200, yellow: 3000}). */
    green: 1500, yellow: 4000, playbackWindow: 600000, playbackSlow: 3000,
    hlsSegment: true, maxQueue: 80, maxRecords: 6000
  };
  var TEXT = {
    green: { label: 'Saudável', detail: 'Respondeu rápido e o stream parece válido.' },
    yellow: { label: 'Atenção', detail: 'Respondeu, mas com latência moderada.' },
    orange: { label: 'Instável', detail: 'Respondeu devagar, com erro isolado ou formato suspeito.' },
    red: { label: 'Offline', detail: 'Falhou de forma repetida ou não respondeu.' },
    gray: { label: 'Inconclusivo', detail: 'Não foi possível verificar (CORS, bloqueio ou ainda não verificado).' }
  };

  var cfg = {}, recs = {}, pending = {}, queue = [], inflight = 0, gen = 0, paused = false, waiters = [];
  /* Interruptor do monitoramento (preferencia). Padrao: ligado quando a chave nao existe.
     Fica em cache para nao ler o localStorage a cada card; so setEnabled() altera. */
  var off = (App.store && App.store.get('healthOn', true) === false);

  function copy(o) { var r = {}, k; for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; return r; }
  cfg = copy(DEFAULTS);

  function listId(list) {
    if (list && typeof list === 'object') return list.id || 'active';
    if (typeof list === 'string' && list) return list;
    if (App.catalog && App.catalog.listId) return App.catalog.listId;
    var a = App.lists && App.lists.active ? App.lists.active() : null;
    return a && a.id ? a.id : 'active';
  }
  function listObj(list) {
    if (list && typeof list === 'object') return list;
    if (typeof list === 'string' && App.lists && App.lists.get) return App.lists.get(list);
    return App.lists && App.lists.active ? App.lists.active() : null;
  }
  function keyOf(item, list) { return listId(list) + '|live|' + (item && item.id ? item.id : ''); }

  function blankRec() {
    return {
      state: 'gray', label: TEXT.gray.label, detail: 'Ainda não verificado.',
      checkedAt: 0, ttfb: 0, status: 0, code: '', kind: '', source: '',
      failures: 0, lastOk: 0, lastPlaybackAt: 0, lastPlaybackFail: 0,
      playbackState: '', playbackSlow: false, history: []
    };
  }
  function recFor(item, list) {
    var k = keyOf(item, list), r = recs[k];
    if (!r) { r = recs[k] = blankRec(); prune(); }
    return r;
  }
  function prune() {
    var keys = Object.keys(recs);
    if (keys.length <= cfg.maxRecords) return;
    keys.sort(function (a, b) { return (recs[a].checkedAt || 0) - (recs[b].checkedAt || 0); });
    for (var i = 0; i < keys.length - cfg.maxRecords; i++) delete recs[keys[i]];
  }

  function emit(item, rec) {
    App.bus.emit('health', { key: keyOf(item, rec && rec.listId), item: item, rec: rec });
  }

  function classify(rec, r, extra, now) {
    var code = r && r.code || '', status = r && r.status || 0, ok = !!(r && r.ok);
    var kind = r && r.kind || 'unknown', ttfb = r && (r.ttfb || r.ms) || 0;
    var failure = false, state = 'gray', detail = '';

    if (code === 'abort') return null;
    if (code === 'opaque') { state = 'gray'; detail = 'O provedor bloqueou a verificação (CORS).'; }
    else if (code === 'offline') { failure = true; state = 'red'; detail = 'Sem conexão com a internet.'; }
    else if (extra && extra.segmentFail) { failure = true; state = 'orange'; detail = 'O manifesto respondeu, mas o primeiro segmento falhou.'; }
    else if (extra && extra.invalidHls) { failure = true; state = 'orange'; detail = 'O manifesto HLS não é válido.'; }
    else if (code === 'timeout') { failure = true; state = 'orange'; detail = 'O canal demorou demais para responder.'; }
    else if (code === 'network') { failure = true; state = 'orange'; detail = 'Não foi possível acessar o canal.'; }
    else if (code === 'auth') { state = 'orange'; detail = 'O servidor recusou as credenciais da lista.'; }
    else if (code === 'invalid' || code === 'parse') { failure = true; state = 'orange'; detail = 'A lista não forneceu um stream válido.'; }
    else if (code === 'http') {
      if (status === 401 || status === 403) { state = 'orange'; detail = 'O servidor recusou o acesso (' + status + ').'; }
      else if (status === 404 || status === 410) { failure = true; state = 'orange'; detail = 'O canal não foi encontrado (' + status + ').'; }
      else { failure = true; state = 'orange'; detail = 'O servidor respondeu com erro ' + (status || '?') + '.'; }
    }
    else if (!ok) { failure = true; state = 'orange'; detail = 'A verificação não concluiu.'; }
    else if (kind === 'html' || kind === 'empty') { failure = true; state = 'orange'; detail = 'A resposta não parece ser um stream de vídeo.'; }
    else if (ttfb <= cfg.green) { state = 'green'; detail = 'Respondeu em ' + ttfb + ' ms.'; }
    else if (ttfb <= cfg.yellow) { state = 'yellow'; detail = 'Respondeu em ' + ttfb + ' ms (latência moderada).'; }
    else { state = 'orange'; detail = 'Respondeu em ' + ttfb + ' ms (latência alta).'; }

    if (failure) rec.failures = (rec.failures || 0) + 1;
    else if (ok && code !== 'opaque') rec.failures = 0;
    if (ok && !failure) rec.lastOk = now;

    rec.ttfb = ttfb; rec.status = status; rec.code = code; rec.kind = kind;
    rec.history.push({ t: now, ok: ok && !failure, ms: ttfb, status: status, code: code, kind: kind });
    if (rec.history.length > 5) rec.history.shift();

    if (failure) {
      var last = rec.history.slice(-3), allFail = last.length >= 3, i;
      for (i = 0; i < last.length; i++) if (last[i].ok) { allFail = false; break; }
      if (rec.failures >= 2 || allFail) {
        state = 'red';
        detail = detail + ' Falhas seguidas: ' + rec.failures + '.';
      }
    }
    if (rec.playbackState === 'ok' && rec.lastPlaybackAt && now - rec.lastPlaybackAt <= cfg.playbackWindow) {
      state = rec.playbackSlow ? 'yellow' : 'green';
      detail = 'Reprodução confirmada recentemente.';
    }
    return { state: state, label: TEXT[state].label, detail: detail };
  }

  function finish(job, r, extra) {
    if (job.dead || job.gen !== gen) return null;
    var rec = recs[job.key] || (recs[job.key] = blankRec());
    var now = Date.now(), res = classify(rec, r, extra, now);
    if (!res) return null;
    rec.state = res.state; rec.label = res.label; rec.detail = res.detail;
    rec.checkedAt = now; rec.source = 'http'; rec.listId = job.key.split('|')[0];
    App.bus.emit('health', { key: job.key, item: job.item, rec: rec });
    return rec;
  }

  function absUrl(u, base) {
    if (/^https?:\/\//i.test(u)) return u;
    if (u.charAt(0) === '/') { var m = /^(https?:\/\/[^\/]+)/i.exec(base); return m ? m[1] + u : u; }
    var clean = String(base || '').replace(/[?#].*$/, '');
    return clean.replace(/[^\/]*$/, '') + u;
  }
  function firstUri(text, base) {
    var lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/), variant = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+|\s+$/g, '');
      if (!line) continue;
      if (line.indexOf('#EXT-X-STREAM-INF') === 0) { variant = true; continue; }
      if (line.charAt(0) === '#') continue;
      return { uri: absUrl(line, base), variant: variant };
    }
    return null;
  }
  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  function probeOne(job, url, retries) {
    if (job.dead || job.gen !== gen) return Promise.resolve({ ok: false, code: 'abort', status: 0, kind: 'unknown' });
    var p;
    try { p = App.http.probe(url, { timeout: cfg.timeout }); } catch (e) { return Promise.resolve({ ok: false, code: 'network', status: 0, kind: 'unknown' }); }
    job.probe = p;
    return p.then(function (r) {
      if (job.dead || job.gen !== gen) return { ok: false, code: 'abort', status: 0, kind: 'unknown' };
      r = r || { ok: false, code: 'network', status: 0, kind: 'unknown' };
      if (retries > 0 && (r.code === 'timeout' || r.code === 'network')) {
        return delay(250).then(function () { return probeOne(job, url, retries - 1); });
      }
      return r;
    }, function () {
      return { ok: false, code: 'network', status: 0, kind: 'unknown' };
    });
  }

  function checkHls(job, r) {
    var text = String(r.text || '');
    if (text.replace(/^\uFEFF/, '').indexOf('#EXTM3U') < 0) return Promise.resolve({ invalidHls: true });
    var first = firstUri(text, job.lastUrl);
    if (!first) return Promise.resolve({ invalidHls: true });
    if (!cfg.hlsSegment) return Promise.resolve({});
    return probeOne(job, first.uri, 0).then(function (seg) {
      if (job.dead || job.gen !== gen) return {};
      if (!seg || seg.code === 'abort' || seg.code === 'opaque') return {};
      if (!seg.ok) return { segmentFail: true };
      if (first.variant) {
        if (seg.kind !== 'hls') return {};
        var media = firstUri(String(seg.text || ''), first.uri);
        if (!media) return { invalidHls: true };
        if (media.variant) return {};
        return probeOne(job, media.uri, 0).then(function (ms) {
          if (job.dead || job.gen !== gen) return {};
          if (!ms || ms.code === 'abort' || ms.code === 'opaque') return {};
          return ms.ok ? {} : { segmentFail: true };
        });
      }
      return {};
    });
  }

  function probeUrls(job, urls) {
    var i = 0, last = null;
    function next() {
      if (job.dead || job.gen !== gen) return Promise.resolve({ ok: false, code: 'abort', status: 0, kind: 'unknown' });
      if (i >= urls.length) return Promise.resolve(last || { ok: false, code: 'network', status: 0, kind: 'unknown' });
      var url = urls[i++];
      job.lastUrl = url;
      return probeOne(job, url, cfg.retry).then(function (r) {
        last = r;
        if (r.ok || r.code === 'opaque' || r.code === 'abort') return r;
        if (i < urls.length) return next();
        return r;
      });
    }
    return next();
  }

  function check(job) {
    return Promise.resolve().then(function () {
      return App.catalog.urls(job.item, listObj(job.list));
    }).then(function (urls) {
      if (job.dead || job.gen !== gen) return null;
      if (!urls || !urls.length) return finish(job, { ok: false, code: 'invalid', status: 0, kind: 'unknown' }, {});
      return probeUrls(job, urls).then(function (r) {
        if (!r || job.dead || job.gen !== gen || r.code === 'abort') return null;
        if (r.ok && r.kind === 'hls') {
          return checkHls(job, r).then(function (extra) {
            if (job.dead || job.gen !== gen) return null;
            return finish(job, r, extra || {});
          });
        }
        return finish(job, r, {});
      });
    }).then(null, function (e) {
      if (job.dead || job.gen !== gen) return null;
      return finish(job, e && e.code ? e : { ok: false, code: 'network', status: 0, kind: 'unknown' }, {});
    });
  }

  function settle() {
    if (queue.length || inflight) return;
    var w = waiters; waiters = [];
    for (var i = 0; i < w.length; i++) w[i]();
  }
  function done(job) {
    if (pending[job.key] === job) delete pending[job.key];
    job.running = false;
    inflight--;
    pump();
    settle();
  }
  function pump() {
    if (paused || off) { settle(); return; }
    while (inflight < cfg.concurrency && queue.length) {
      var job = queue.shift();
      if (!job || job.dead || job.gen !== gen) { if (job) delete pending[job.key]; continue; }
      inflight++;
      job.running = true;
      (function (j) {
        check(j).then(function () { done(j); }, function () { done(j); });
      })(job);
    }
    settle();
  }

  function observe(list, items) {
    if (off || !items) return 0;   /* desligado: nenhuma verificacao automatica e nenhuma requisicao */
    var arr = Object.prototype.toString.call(items) === '[object Array]' ? items : [items];
    var lid = listId(list), now = Date.now(), added = 0;
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (!it || it.t !== 'live' || !it.id) continue;
      var k = lid + '|live|' + it.id;
      if (pending[k]) continue;
      var rec = recs[k];
      if (rec && rec.checkedAt && now - rec.checkedAt < cfg.cache) continue;
      if (queue.length >= cfg.maxQueue) break;
      var job = { key: k, list: list, item: it, gen: gen, dead: false, running: false, probe: null };
      pending[k] = job; queue.push(job); added++;
    }
    if (added) pump();
    return added;
  }

  function cancel() {
    gen++;
    queue.length = 0;
    for (var k in pending) {
      var j = pending[k];
      j.dead = true;
      if (j.probe && j.probe.abort) { try { j.probe.abort(); } catch (e) { /* ignore */ } }
    }
    pending = {};
    settle();
  }
  function pause() { paused = true; }
  function resume() { paused = false; pump(); }

  /* Preferencia: ligada por padrao (chave ausente = true). */
  function enabled() { return !off; }
  /* Liga/desliga com efeito imediato: desligar aborta o que esta em voo e limpa a fila. */
  function setEnabled(on) {
    on = !!on;
    App.store.set('healthOn', on);
    off = !on;
    if (off) cancel();
    else pump();
    App.bus.emit('health:config', on);
    return on;
  }

  function state(item, list) {
    return recs[keyOf(item, list)] || blankRec();
  }
  function paint(dot, item, list) {
    if (!dot) return;
    var rec = state(item, list), st = rec.state || 'gray';
    dot.className = 'hdot ' + st;
    dot.setAttribute('data-state', st);
    dot.title = (rec.label || TEXT.gray.label) + ': ' + (rec.detail || TEXT.gray.detail);
  }
  /* Repinta no DOM os indicadores de uma chave (sem re-renderizar o card). */
  function paintKey(root, key, rec) {
    if (!root || !key) return;
    var nodes = root.querySelectorAll('[data-hkey]'), i, st;
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-hkey') !== key) continue;
      st = (rec && rec.state) || 'gray';
      nodes[i].className = 'hdot ' + st;
      nodes[i].setAttribute('data-state', st);
      nodes[i].title = ((rec && rec.label) || TEXT[st].label) + ': ' + ((rec && rec.detail) || TEXT[st].detail);
    }
  }
  function legend() {
    return 'Verde: saudável — respondeu rápido e o stream parece válido.\n' +
      'Amarelo: atenção — respondeu, mas com latência moderada.\n' +
      'Laranja: instável — respondeu devagar, com erro isolado ou formato suspeito.\n' +
      'Vermelho: offline — falhou de forma repetida ou não respondeu.\n' +
      'Cinza: inconclusivo — CORS, bloqueio ou ainda não verificado.\n\n' +
      'As verificações são leves, feitas só nos canais visíveis, com até 3 em paralelo e cache de 60 s.';
  }
  function detail(item, list) {
    var rec = state(item, list), lines = [];
    lines.push(item && item.n ? item.n : 'Canal');
    lines.push((rec.label || TEXT.gray.label) + ' — ' + (rec.detail || TEXT.gray.detail));
    if (rec.checkedAt) lines.push('Última verificação: ' + App.fmtDate(rec.checkedAt));
    if (rec.ttfb) lines.push('Tempo de resposta: ' + rec.ttfb + ' ms');
    if (rec.status) lines.push('Resposta HTTP: ' + rec.status);
    if (rec.kind) lines.push('Formato detectado: ' + String(rec.kind).toUpperCase());
    if (rec.failures) lines.push('Falhas seguidas: ' + rec.failures);
    if (rec.lastOk) lines.push('Último sucesso: ' + App.fmtDate(rec.lastOk));
    if (rec.lastPlaybackAt) lines.push('Reprodução confirmada: ' + App.fmtDate(rec.lastPlaybackAt));
    if (rec.lastPlaybackFail) lines.push('Última falha no player: ' + App.fmtDate(rec.lastPlaybackFail));
    return lines.join('\n');
  }
  function playback(item, ok, slow, list) {
    if (!item || item.t !== 'live') return null;
    var rec = recFor(item, list), now = Date.now();
    rec.source = 'player';
    if (ok) {
      rec.playbackState = 'ok'; rec.playbackSlow = !!slow; rec.lastPlaybackAt = now;
      rec.state = slow ? 'yellow' : 'green'; rec.label = TEXT[rec.state].label;
      rec.detail = slow ? 'Reprodução confirmada, mas com demora para iniciar.' : 'Reprodução confirmada recentemente.';
      rec.failures = 0; rec.lastOk = now;
      rec.history.push({ t: now, ok: true, ms: 0, status: 0, code: 'player', kind: 'playback' });
    } else {
      rec.playbackState = 'fail'; rec.lastPlaybackFail = now;
      rec.failures = (rec.failures || 0) + 1;
      rec.state = rec.failures >= 2 ? 'red' : 'orange'; rec.label = TEXT[rec.state].label;
      rec.detail = rec.failures >= 2 ? 'O player falhou mais de uma vez.' : 'O player não conseguiu abrir este canal.';
      rec.history.push({ t: now, ok: false, ms: 0, status: 0, code: 'player', kind: 'playback' });
    }
    if (rec.history.length > 5) rec.history.shift();
    App.bus.emit('health', { key: keyOf(item, list), item: item, rec: rec });
    return rec;
  }
  function configure(patch) {
    if (patch) {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, k) && typeof patch[k] === typeof DEFAULTS[k]) cfg[k] = patch[k];
      }
      if (cfg.concurrency < 1) cfg.concurrency = 1;
      if (cfg.maxQueue < 1) cfg.maxQueue = 1;
      if (cfg.maxRecords < 1) cfg.maxRecords = 1;
      pump();
    }
    return cfg;
  }
  function stats() {
    var out = { green: 0, yellow: 0, orange: 0, red: 0, gray: 0, queued: queue.length, inflight: inflight, records: 0, paused: paused, enabled: !off, checking: enabled() && !paused && (queue.length + inflight > 0) };
    for (var k in recs) {
      out.records++;
      if (out[recs[k].state] != null) out[recs[k].state]++;
    }
    return out;
  }
  function idle() {
    return new Promise(function (res) {
      if (!queue.length && !inflight) return res();
      waiters.push(res);
    });
  }
  function reset() { cancel(); recs = {}; paused = false; }

  App.health = {
    cfg: cfg, keyOf: keyOf, observe: observe, cancel: cancel, pause: pause, resume: resume,
    enabled: enabled, setEnabled: setEnabled,
    playback: playback, state: state, paint: paint, paintKey: paintKey, legend: legend, detail: detail,
    configure: configure, stats: stats, idle: idle, reset: reset
  };
})(window);
