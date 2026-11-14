/* Gerenciamento de listas cadastradas (M3U e Xtream). Senhas/URLs ficam seladas. */
(function (g) {
  'use strict';
  var App = g.App, credCache = {};

  function load() { return App.store.get('lists', []); }
  function save(a) { App.store.set('lists', a); }

  App.lists = {
    all: load,
    get: function (id) { return load().filter(function (l) { return l.id === id; })[0] || null; },
    activeId: function () { return App.store.get('active', null); },
    active: function () {
      var id = App.lists.activeId(), a = load();
      return a.filter(function (l) { return l.id === id; })[0] || a[0] || null;
    },
    setActive: function (id) {
      App.store.set('active', id);
      App.bus.emit('lists', { action: 'active', id: id });
    },

    /* f: {name, type:'m3u'|'xtream', url | server,user,pass}. Em edicao, campo vazio mantem o valor atual. */
    save: function (f, id) {
      var all = load(), cur = id ? App.lists.get(id) : null;
      var rec = cur ? JSON.parse(JSON.stringify(cur)) : { id: App.uuid(), added: Date.now(), updated: 0, error: '' };
      rec.name = f.name; rec.type = f.type;
      var p = Promise.resolve(), cleanup = null;
      if (f.type === 'm3u') {
        rec.server = rec.user = rec.passS = '';
        if (f.url) {
          /* Se estava em arquivo, virou lista por URL: remove o texto local. */
          if (rec.source === 'file') {
            cleanup = App.idb.del('m3u.' + rec.id);
            delete rec.source; delete rec.filename; delete rec.size;
          }
          p = App.secrets.seal(f.url).then(function (s) { rec.urlS = s; });
        }
      } else {
        rec.urlS = ''; rec.server = f.server; rec.user = f.user;
        if (f.pass) p = App.secrets.seal(f.pass).then(function (s) { rec.passS = s; });
      }
      return p.then(function () {
        var i, found = false, ps = [];
        for (i = 0; i < all.length; i++) if (all[i].id === rec.id) { all[i] = rec; found = true; }
        if (!found) all.push(rec);
        rec.updated = Date.now();
        save(all); delete credCache[rec.id];
        if (cleanup) ps.push(cleanup);
        return Promise.all(ps);
      }).then(function () {
        if (!App.store.get('active', null)) App.lists.setActive(rec.id);
        App.bus.emit('lists', { action: 'save', id: rec.id, record: rec });
        return rec;
      });
    },
    patch: function (id, fields) {
      var all = load();
      all.forEach(function (l) { if (l.id === id) for (var k in fields) l[k] = fields[k]; });
      save(all);
      App.bus.emit('lists', { action: 'patch', id: id, fields: fields });
    },
    remove: function (id) {
      var rec = App.lists.get(id);
      save(load().filter(function (l) { return l.id !== id; }));
      delete credCache[id];
      if (App.store.get('active', null) === id) { var r = load()[0]; App.store.set('active', r ? r.id : null); }
      App.bus.emit('lists', { action: 'remove', id: id });
      var p = App.catalog.dropCache(id);
      if (rec && rec.source === 'file') p = Promise.all([p, App.idb.del('m3u.' + id)]);
      return p;
    },
    /* Lista M3U lida de arquivo local: o texto fica só no IndexedDB deste navegador. */
    saveFile: function (f, id) {
      var all = load(), cur = id ? App.lists.get(id) : null;
      var text = String(f && f.text || '');
      var name = String(f && f.name || '').replace(/^\s+|\s+$/g, '');
      if (!name || !text) return Promise.reject({ code: 'invalid' });
      var rec = cur ? JSON.parse(JSON.stringify(cur)) : { id: App.uuid(), added: Date.now(), updated: 0, error: '' };
      rec.name = name; rec.type = 'm3u'; rec.source = 'file';
      rec.filename = String(f.filename || rec.filename || '');
      rec.size = Number(f.size) || text.length;
      rec.server = rec.user = rec.passS = ''; rec.urlS = '';
      var key = 'm3u.' + rec.id;
      return App.idb.put(key, text).then(function () {
        return App.idb.get(key);
      }).then(function (saved) {
        if (saved !== text) throw { code: 'storage' };
        var i, found = false;
        for (i = 0; i < all.length; i++) if (all[i].id === rec.id) { all[i] = rec; found = true; }
        if (!found) all.push(rec);
        rec.updated = Date.now();
        save(all); delete credCache[rec.id];
        if (!App.store.get('active', null)) App.lists.setActive(rec.id);
        App.bus.emit('lists', { action: 'save', id: rec.id, record: rec });
        return rec;
      });
    },
    /* Texto do arquivo salvo localmente (usado pelo catálogo). */
    readM3uFile: function (l) {
      return App.idb.get('m3u.' + l.id).then(function (text) {
        if (typeof text !== 'string' || !text.replace(/^\s+|\s+$/g, '')) throw { code: 'invalid' };
        return text;
      });
    },
    /* credenciais em texto, so em memoria */
    creds: function (l) {
      if (l.source === 'file') return Promise.resolve({ url: '' });
      if (credCache[l.id]) return Promise.resolve(credCache[l.id]);
      var p = l.type === 'm3u'
        ? App.secrets.open(l.urlS).then(function (u) { return { url: u }; })
        : App.secrets.open(l.passS).then(function (pw) { return { server: l.server, user: l.user, pass: pw }; });
      return p.then(function (c) { credCache[l.id] = c; return c; });
    },
    /* so o host, para mostrar na UI sem vazar credenciais */
    hostOf: function (l) {
      var m = /^(?:https?:\/\/)?([^\/:?#]+)/i.exec(l.server || '');
      return m ? m[1] : '';
    }
  };
})(window);
