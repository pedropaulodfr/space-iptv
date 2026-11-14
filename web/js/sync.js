/* Sincronização por usuário (Space IPTV web).
 *
 * - pull no boot, ANTES do catálogo, aplicando listas/segredos/favoritos/histórico
 *   e preferências no localStorage do aparelho;
 * - cada mutação vira uma operação em uma fila persistente (IndexedDB próprio,
 *   com fallback em localStorage), enviada em lote por /api/sync/push;
 * - falha de rede não perde operação: a fila sobrevive ao reload e é reenviada
 *   com backoff exponencial (1 s → 30 s) e no evento `online`.
 *
 * O catálogo (cat.* / eps.*) NÃO sincroniza: é derivado da lista.
 * As credenciais vão em claro para a nuvem (TLS + RLS + criptografia em repouso
 * do Neon) e são seladas de novo com a chave do aparelho ao aplicar aqui.
 */
(function (g) {
  'use strict';
  var App = g.App;

  var DEBOUNCE_MS = 800;
  var MAX_BATCH = 200;
  var BACKOFF_MAX = 30000;
  var DB_NAME = 'spaceiptv-sync';
  var LS_KEY = 'syncq';

  var enabled = false;
  var booted = false;
  var pushing = false;
  var timer = null;
  var backoff = 1000;
  var queue = [];
  var dbP = null;
  var listeners = [];
  var sessionExpired = false;

  /* ---------- fila persistente ---------- */

  function openDb() {
    if (dbP) return dbP;
    dbP = new Promise(function (res) {
      try {
        var rq = g.indexedDB.open(DB_NAME, 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = rq.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
    return dbP;
  }

  function loadQueue() {
    return openDb().then(function (db) {
      if (!db) {
        var raw = App.store.get(LS_KEY, []);
        queue = Array.isArray(raw) ? raw : [];
        return queue;
      }
      return new Promise(function (res) {
        try {
          var t = db.transaction('kv', 'readonly');
          var rq = t.objectStore('kv').get('queue');
          rq.onsuccess = function () {
            queue = Array.isArray(rq.result) ? rq.result : [];
            res(queue);
          };
          rq.onerror = function () {
            var raw = App.store.get(LS_KEY, []);
            queue = Array.isArray(raw) ? raw : [];
            res(queue);
          };
        } catch (e) {
          queue = [];
          res(queue);
        }
      });
    });
  }

  function persist() {
    var snapshot = queue;
    return openDb().then(function (db) {
      if (!db) { App.store.set(LS_KEY, snapshot); return; }
      try {
        var t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').put(snapshot, 'queue');
      } catch (e) { App.store.set(LS_KEY, snapshot); }
    });
  }

  /* ---------- operações ---------- */

  function pkOf(op) {
    if (!op || !op.table) return '';
    if (op.table === 'playlists') return 'playlists|' + (op.row ? op.row.id : op.key && op.key.id);
    if (op.table === 'playlist_secrets') return 'playlist_secrets|' + (op.row ? op.row.playlist_id : op.key && op.key.playlist_id);
    if (op.table === 'favorites' || op.table === 'history') {
      var r = op.row || op.key || {};
      return op.table + '|' + r.playlist_id + '|' + r.kind + '|' + r.item_id;
    }
    if (op.table === 'user_prefs') return 'user_prefs';
    return op.table;
  }

  /* Mantém a fila pequena: a última intenção para a mesma chave vence. */
  function collapse(op) {
    var key = pkOf(op);
    var out = [];
    for (var i = 0; i < queue.length; i++) {
      if (pkOf(queue[i]) === key) continue;
      out.push(queue[i]);
    }
    if (op.table === 'playlists' && op.op === 'delete') {
      var id = op.key && op.key.id;
      out = out.filter(function (o) { return !(o.row && o.row.playlist_id === id) && !(o.key && o.key.playlist_id === id); });
    }
    out.push(op);
    queue = out;
  }

  function enqueue(op, silent) {
    if (!enabled) return;
    /* Guarda de sanidade: só entram operações bem formadas (tabela + ação). */
    if (!op || !op.table || (op.op !== 'upsert' && op.op !== 'delete')) {
      App.log('sync: operação inválida descartada', op && op.table);
      return;
    }
    collapse(op);
    persist();
    if (!silent) emitBadge();
  }

  function iso(ts) {
    var n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
    return new Date(n).toISOString();
  }

  function listIdNow() {
    return App.catalog && App.catalog.listId ? App.catalog.listId : ((App.lists.active() || {}).id || '');
  }

  /* ---------- tradução evento local -> operação ---------- */

  function playlistRow(rec) {
    var active = App.lists.activeId();
    var xtream = rec.type === 'xtream';
    return {
      id: rec.id,
      name: rec.name || 'Lista',
      kind: xtream ? 'xtream' : 'm3u',
      server: xtream ? (rec.server || '') : '',
      xtream_user: xtream ? (rec.user || '') : '',
      is_active: String(rec.id) === String(active),
      last_error: rec.error || '',
      created_at: iso(rec.added),
      updated_at: iso(rec.updated || Date.now())
    };
  }

  function secretsRow(rec) {
    var opening = rec.type === 'xtream' ? App.secrets.open(rec.passS) : App.secrets.open(rec.urlS);
    return opening.then(function (value) {
      return {
        playlist_id: rec.id,
        m3u_url: rec.type === 'xtream' ? '' : String(value || ''),
        xtream_pass: rec.type === 'xtream' ? String(value || '') : '',
        updated_at: iso(rec.updated || Date.now())
      };
    });
  }

  function pushPlaylist(rec) {
    if (!rec || !rec.id) return Promise.resolve();
    enqueue({ table: 'playlists', op: 'upsert', row: playlistRow(rec) });
    return secretsRow(rec).then(function (row) {
      enqueue({ table: 'playlist_secrets', op: 'upsert', row: row });
    });
  }

  function prefsRow() {
    var last = App.store.get('lastCh', null);
    return {
      resume_last: !!(App.resume && App.resume.enabled()),
      health_check: !!(App.health && App.health.enabled()),
      last_channel: last && last.id ? {
        playlist_id: last.list || '',
        kind: 'live',
        item_id: String(last.id),
        at: last.ts || Date.now()
      } : null,
      parental_enabled: !!(App.parental && App.parental.enabled()),
      parental_pin_hash: App.store.get('pinH', '') || null,
      parental_pin_salt: App.store.get('pinSalt', '') || null,
      updated_at: new Date().toISOString()
    };
  }

  function pushPrefs() {
    enqueue({ table: 'user_prefs', op: 'upsert', row: prefsRow() });
  }

  function onLists(ev) {
    if (!ev) return;
    if (ev.action === 'remove') {
      enqueue({ table: 'playlists', op: 'delete', key: { id: ev.id } });
      return;
    }
    if (ev.action === 'active') {
      var rec = App.lists.get(ev.id);
      if (rec) pushPlaylist(rec);
      return;
    }
    var record = ev.record || App.lists.get(ev.id);
    if (record) pushPlaylist(record);
  }

  function onFavs(ev) {
    if (!ev || !ev.item) return;
    var list = ev.list || listIdNow();
    if (!list) return;
    var kind = ev.item.t || 'live';
    var itemId = String(ev.item.id || '');
    if (!itemId) return;
    if (ev.on) {
      enqueue({
        table: 'favorites',
        op: 'upsert',
        row: {
          playlist_id: list,
          kind: kind,
          item_id: itemId,
          title: ev.item.n || '',
          created_at: iso(ev.rec && ev.rec.ts)
        }
      });
    } else {
      enqueue({ table: 'favorites', op: 'delete', key: { playlist_id: list, kind: kind, item_id: itemId } });
    }
  }

  function onHist(ev) {
    if (!ev || !ev.item) return;
    var list = ev.list || listIdNow();
    if (!list) return;
    var kind = ev.item.t || 'live';
    var itemId = String(ev.item.id || '');
    if (!itemId) return;
    if (ev.removed) {
      enqueue({ table: 'history', op: 'delete', key: { playlist_id: list, kind: kind, item_id: itemId } });
      return;
    }
    var rec = ev.rec || {};
    enqueue({
      table: 'history',
      op: 'upsert',
      row: {
        playlist_id: list,
        kind: kind,
        item_id: itemId,
        title: ev.item.n || '',
        ep: rec.ep || null,
        pos: Math.max(0, Math.floor(rec.pos || 0)),
        dur: Math.max(0, Math.floor(rec.dur || 0)),
        watched_at: iso(rec.ts)
      }
    });
  }

  function subscribe() {
    listeners.push(['lists', onLists]);
    listeners.push(['favs', onFavs]);
    listeners.push(['hist', onHist]);
    listeners.push(['resume', pushPrefs]);
    listeners.push(['parental', pushPrefs]);
    listeners.push(['health:config', pushPrefs]);
    listeners.forEach(function (pair) { App.bus.on(pair[0], pair[1]); });
  }

  function unsubscribe() {
    listeners.forEach(function (pair) { App.bus.off(pair[0], pair[1]); });
    listeners = [];
  }

  /* ---------- envio ---------- */

  function emitBadge() {
    var state = 'idle';
    if (!App.isOnline()) state = 'offline';
    else if (pushing) state = 'pushing';
    else if (queue.length) state = 'pending';
    App.bus.emit('sync', { state: state, pending: queue.length });
  }

  function goLogin() {
    var here = String(g.location.pathname || '/') + String(g.location.search || '');
    if (here === '/' || here === '/index.html') here = '/';
    g.location.replace('/login.html?next=' + encodeURIComponent(here));
  }

  function schedule(ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; flush(); }, Math.max(0, ms || DEBOUNCE_MS));
  }

  function api(path, opts) {
    var o = opts || {};
    var init = {
      method: o.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {}
    };
    if (o.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(o.body);
    }
    return fetch(path, init).then(function (res) {
      return res.text().then(function (raw) {
        var data = null;
        if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function applyConflicts(conflicts) {    if (!conflicts || !conflicts.length) return;
    var lists = App.lists.all();
    var changed = false;
    conflicts.forEach(function (c) {
      if (!c || c.table !== 'playlists' || !c.serverRow) return;
      for (var i = 0; i < lists.length; i++) {
        if (lists[i].id !== c.serverRow.id) continue;
        var s = c.serverRow;
        lists[i].name = s.name || lists[i].name;
        lists[i].type = s.kind === 'xtream' ? 'xtream' : 'm3u';
        lists[i].server = s.server || '';
        lists[i].user = s.xtream_user || '';
        lists[i].error = s.last_error || '';
        lists[i].updated = Date.parse(s.updated_at) || lists[i].updated;
        changed = true;
      }
    });
    if (changed) {
      App.store.set('lists', lists);
      App.bus.emit('catalog');
      App.toast('Uma lista foi atualizada em outro aparelho.');
    }
  }

  function flush() {
    if (!enabled || pushing || sessionExpired) return Promise.resolve(false);
    if (!App.isOnline()) { emitBadge(); return Promise.resolve(false); }
    if (!queue.length) { emitBadge(); return Promise.resolve(true); }

    pushing = true;
    emitBadge();
    var batch = queue.slice(0, MAX_BATCH);

    return api('/api/sync/push', { method: 'POST', body: { ops: batch } }).then(function (r) {
      pushing = false;
      if (r.status === 401) {
        sessionExpired = true;
        enabled = false;
        emitBadge();
        goLogin();
        return false;
      }
      if (!r.ok) {
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
        emitBadge();
        schedule(backoff);
        return false;
      }
      queue = queue.filter(function (op) {
        return batch.indexOf(op) < 0;
      });
      persist();
      applyConflicts(r.data && r.data.conflicts);
      backoff = 1000;
      emitBadge();
      if (queue.length) schedule(120);
      return true;    }, function () {
      pushing = false;
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
      emitBadge();
      schedule(backoff);
      return false;
    });
  }

  /* ---------- pull / aplicação no aparelho ---------- */

  function sealValue(value) {
    if (!value) return Promise.resolve('');
    return App.secrets.seal(value).then(function (s) { return s; }, function () { return ''; });
  }

  function buildLocalLists(playlists, secrets) {
    var byId = {};
    (secrets || []).forEach(function (s) { byId[s.playlist_id] = s; });
    return Promise.all((playlists || []).map(function (p) {
      var sec = byId[p.id] || {};
      return Promise.all([
        p.kind === 'm3u' ? sealValue(sec.m3u_url) : Promise.resolve(''),
        p.kind === 'xtream' ? sealValue(sec.xtream_pass) : Promise.resolve('')
      ]).then(function (sealed) {
        return {
          id: p.id,
          name: p.name || 'Lista',
          type: p.kind === 'xtream' ? 'xtream' : 'm3u',
          server: p.server || '',
          user: p.xtream_user || '',
          urlS: sealed[0],
          passS: sealed[1],
          added: Date.parse(p.created_at) || Date.now(),
          updated: Date.parse(p.updated_at) || Date.now(),
          error: p.last_error || '',
          isActive: p.is_active === true
        };
      });
    }));
  }

  function applyCloud(data) {
    var playlists = (data && data.playlists) || [];
    var secrets = (data && data.secrets) || [];
    var favorites = (data && data.favorites) || [];
    var history = (data && data.history) || [];
    var prefs = (data && data.prefs) || null;

    return buildLocalLists(playlists, secrets).then(function (lists) {
      var activeId = null;
      var stored = lists.map(function (l) {
        if (l.isActive && !activeId) activeId = l.id;
        return {
          id: l.id, name: l.name, type: l.type, server: l.server, user: l.user,
          urlS: l.urlS, passS: l.passS, added: l.added, updated: l.updated, error: l.error
        };
      });

      var favs = {};
      favorites.forEach(function (f) {
        var key = f.playlist_id + '|' + f.kind + '|' + f.item_id;
        favs[key] = {
          t: f.kind, id: f.item_id, n: f.title || '', l: '',
          ts: Date.parse(f.created_at) || Date.now()
        };
      });

      var hist = history.map(function (h) {
        return {
          k: h.playlist_id + '|' + h.kind + '|' + h.item_id,
          list: h.playlist_id,
          t: h.kind,
          id: h.item_id,
          n: h.title || '',
          l: '',
          ep: h.ep || null,
          pos: h.pos || 0,
          dur: h.dur || 0,
          ts: Date.parse(h.watched_at) || Date.now()
        };
      });
      hist.sort(function (a, b) { return b.ts - a.ts; });
      if (hist.length > 60) hist.length = 60;

      App.store.set('lists', stored);
      App.store.set('favs', favs);
      App.store.set('hist', hist);
      App.store.set('active', activeId || (stored[0] ? stored[0].id : null));

      if (prefs) {
        /* PIN: grava o hash antes de ligar o bloqueio (enabled() depende dele) */
        if (prefs.parental_pin_hash) App.store.set('pinH', prefs.parental_pin_hash);
        else App.store.del('pinH');
        if (prefs.parental_pin_salt) App.store.set('pinSalt', prefs.parental_pin_salt);
        else App.store.del('pinSalt');
        var lc = prefs.last_channel;
        if (lc && lc.item_id) {
          App.store.set('lastCh', {
            list: lc.playlist_id || '',
            t: 'live',
            id: String(lc.item_id),
            ts: Number(lc.at) || Date.now()
          });
        } else {
          App.store.del('lastCh');
        }
        /* Usa os setters dos serviços: eles mantêm os caches internos coerentes
           (health.js guarda o "ligado/desligado" em memória, por exemplo). */
        if (App.resume && App.resume.setEnabled) App.resume.setEnabled(prefs.resume_last === true);
        if (App.health && App.health.setEnabled) App.health.setEnabled(prefs.health_check !== false);
        if (App.parental && App.parental.enable) App.parental.enable(prefs.parental_enabled === true);
      }

      App.bus.emit('lists', { action: 'applied' });
      App.bus.emit('catalog');
      return stored;
    });
  }

  function backup(key) {
    App.store.set(key, {
      at: Date.now(),
      lists: App.lists.all(),
      active: App.store.get('active', null),
      favs: App.store.get('favs', {}),
      hist: App.store.get('hist', []),
      lastCh: App.store.get('lastCh', null),
      resumeLast: App.store.get('resumeLast', false),
      healthOn: App.store.get('healthOn', true),
      pinOn: App.store.get('pinOn', false),
      pinH: App.store.get('pinH', ''),
      pinSalt: App.store.get('pinSalt', '')
    });
  }

  /* Reescreve os ids antigos (App.uid) para UUIDs, mantendo favoritos,
     histórico e último canal apontando para a mesma lista. */
  function remapIds() {
    var lists = App.lists.all(), map = {};
    lists.forEach(function (l) {
      var old = l.id;
      l.id = App.uuid();
      map[old] = l.id;
    });
    App.store.set('lists', lists);

    var active = App.store.get('active', null);
    if (active && map[active]) App.store.set('active', map[active]);

    var favs = App.store.get('favs', {}), nextFavs = {}, k;
    for (k in favs) {
      if (!Object.prototype.hasOwnProperty.call(favs, k)) continue;
      var parts = k.split('|');
      if (map[parts[0]]) parts[0] = map[parts[0]];
      nextFavs[parts.join('|')] = favs[k];
    }
    App.store.set('favs', nextFavs);

    var hist = App.store.get('hist', []);
    hist.forEach(function (h) {
      if (map[h.list]) {
        h.list = map[h.list];
        h.k = h.list + '|' + h.t + '|' + h.id;
      }
    });
    App.store.set('hist', hist);

    var last = App.store.get('lastCh', null);
    if (last && map[last.list]) {
      last.list = map[last.list];
      App.store.set('lastCh', last);
    }
    return lists;
  }

  function pushEverything() {
    var lists = App.lists.all();
    var ops = [];
    lists.forEach(function (l) {
      ops.push({ table: 'playlists', op: 'upsert', row: playlistRow(l) });
    });
    return Promise.all(lists.map(secretsRow)).then(function (secrets) {
      secrets.forEach(function (s) {
        ops.push({ table: 'playlist_secrets', op: 'upsert', row: s });
      });
      var favs = App.store.get('favs', {}), k;
      for (k in favs) {
        if (!Object.prototype.hasOwnProperty.call(favs, k)) continue;
        var p = k.split('|');
        ops.push({
          table: 'favorites', op: 'upsert',
          row: { playlist_id: p[0], kind: p[1], item_id: p[2], title: favs[k].n || '', created_at: iso(favs[k].ts) }
        });
      }
      var hist = App.store.get('hist', []);
      hist.forEach(function (h) {
        ops.push({
          table: 'history', op: 'upsert',
          row: {
            playlist_id: h.list, kind: h.t, item_id: String(h.id), title: h.n || '',
            ep: h.ep || null, pos: h.pos || 0, dur: h.dur || 0, watched_at: iso(h.ts)
          }
        });
      });
      ops.push({ table: 'user_prefs', op: 'upsert', row: prefsRow() });
      /* enfileira respeitando o limite de 200 por requisição */
      ops.forEach(function (op) { enqueue(op, true); });
      emitBadge();
      return flush();
    });
  }

  function hasLocalData() {
    if (App.lists.all().length) return true;
    var favs = App.store.get('favs', {});
    for (var k in favs) if (Object.prototype.hasOwnProperty.call(favs, k)) return true;
    return App.store.get('hist', []).length > 0;
  }

  function migrateOrApply(data) {
    var cloudEmpty = !(data && data.playlists && data.playlists.length);

    if (cloudEmpty && hasLocalData()) {
      backup('sl.migrated.' + Date.now());
      remapIds();
      return pushEverything().then(function () {
        App.toast('Seus dados agora estão na sua conta.');
        return true;
      });
    }

    if (!cloudEmpty && hasLocalData()) {
      backup('sl.lists.backup.' + Date.now());
      return applyCloud(data).then(function () {
        App.toast('Seus dados agora estão na sua conta.');
        return true;
      });
    }

    return applyCloud(data).then(function () { return true; });
  }

  function bootFromCloud() {
    return api('/api/sync/pull').then(function (r) {
      if (r.status === 401) {
        sessionExpired = true;
        return false;
      }
      if (!r.ok) {
        /* sem pull: o app abre com o cache local e a fila continua pendente */
        emitBadge();
        return true;
      }
      return migrateOrApply(r.data);
    }, function () {
      emitBadge();
      return true;
    });
  }

  /* ---------- ciclo de vida ---------- */

  function init() {
    if (booted) return Promise.resolve(true);
    booted = true;

    g.addEventListener('online', function () {
      emitBadge();
      flush();
    });
    g.addEventListener('offline', emitBadge);

    return loadQueue().then(function () {
      enabled = true;
      emitBadge();
      /* fila de uma sessão anterior primeiro: ela pode ser a alteração mais nova */
      if (queue.length) {
        return flush().then(function () { return bootFromCloud(); });
      }
      return bootFromCloud();
    }).then(function () {
      if (sessionExpired) { enabled = false; return false; }
      subscribe();
      emitBadge();
      return true;
    }).then(null, function (e) {
      App.log('falha ao iniciar a sincronização', e && e.message);
      enabled = true;
      subscribe();
      emitBadge();
      return true;
    });
  }

  App.sync = {
    init: init,
    flush: flush,
    pending: function () { return queue.length; },
    status: function () {
      return { enabled: enabled, pushing: pushing, pending: queue.length, offline: !App.isOnline() };
    },
    /* usado pelos testes: zera fila e assinaturas */
    _reset: function () {
      unsubscribe();
      queue = [];
      enabled = false;
      booted = false;
      pushing = false;
      backoff = 1000;
      sessionExpired = false;
      if (timer) { clearTimeout(timer); timer = null; }
      persist();
    }
  };
})(window);
