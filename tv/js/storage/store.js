/* Persistencia: localStorage (pequeno), IndexedDB (catalogo) e segredos (AES-GCM) */
(function (g) {
  'use strict';
  var App = g.App;

  App.store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('sl.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('sl.' + k, JSON.stringify(v)); return true; } catch (e) { return false; }
    },
    del: function (k) { try { localStorage.removeItem('sl.' + k); } catch (e) { /* ignore */ } }
  };

  /* IndexedDB, com fallback em memoria se indisponivel */
  var mem = {}, dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res) {
      try {
        var rq = indexedDB.open('spaceiptv', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { res(null); };
        rq.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      if (!d) return fn(null);
      return new Promise(function (res) {
        try {
          var t = d.transaction('kv', mode), s = t.objectStore('kv'), out = fn(s);
          t.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); };
          t.onerror = t.onabort = function () { res(undefined); };
        } catch (e) { res(undefined); }
      });
    });
  }
  App.idb = {
    get: function (k) { return db().then(function (d) { return d ? tx('readonly', function (s) { return s.get(k); }) : mem[k]; }); },
    put: function (k, v) { return db().then(function (d) { if (!d) { mem[k] = v; return; } return tx('readwrite', function (s) { return s.put(v, k); }); }); },
    del: function (k) { return db().then(function (d) { if (!d) { delete mem[k]; return; } return tx('readwrite', function (s) { return s['delete'](k); }); }); }
  };

  /* Segredos. A chave fica no armazenamento privado do app (a Tizen Web nao expoe
     keystore de hardware). Protege contra leitura casual do dump, nao contra root. */
  function b64(buf) { var a = new Uint8Array(buf), s = '', i; for (i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function unb64(s) { var b = atob(s), a = new Uint8Array(b.length), i; for (i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  var keyP = null;
  function getKey() {
    if (keyP) return keyP;
    var subtle = g.crypto && g.crypto.subtle;
    if (!subtle) return (keyP = Promise.resolve(null));
    var raw = App.store.get('k', null);
    if (!raw) {
      var r = new Uint8Array(32); g.crypto.getRandomValues(r);
      raw = b64(r); App.store.set('k', raw);
    }
    keyP = subtle.importKey('raw', unb64(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']).then(null, function () { return null; });
    return keyP;
  }
  App.secrets = {
    seal: function (text) {
      text = String(text == null ? '' : text);
      return getKey().then(function (k) {
        if (!k) return 'p0:' + btoa(unescape(encodeURIComponent(text)));
        var iv = new Uint8Array(12); g.crypto.getRandomValues(iv);
        var bytes = new Uint8Array(unescape(encodeURIComponent(text)).split('').map(function (c) { return c.charCodeAt(0); }));
        return g.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, bytes).then(function (ct) { return 'v1:' + b64(iv) + ':' + b64(ct); });
      });
    },
    open: function (s) {
      if (!s) return Promise.resolve('');
      if (s.indexOf('p0:') === 0) { try { return Promise.resolve(decodeURIComponent(escape(atob(s.slice(3))))); } catch (e) { return Promise.resolve(''); } }
      var p = s.split(':');
      if (p[0] !== 'v1' || p.length !== 3) return Promise.resolve('');
      return getKey().then(function (k) {
        if (!k) return '';
        return g.crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(p[1]) }, k, unb64(p[2])).then(function (buf) {
          var a = new Uint8Array(buf), t = '', i; for (i = 0; i < a.length; i++) t += String.fromCharCode(a[i]);
          return decodeURIComponent(escape(t));
        });
      }).then(null, function () { return ''; });
    }
  };
})(window);
