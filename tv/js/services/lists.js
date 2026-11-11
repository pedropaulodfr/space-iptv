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
    setActive: function (id) { App.store.set('active', id); },

    /* f: {name, type:'m3u'|'xtream', url | server,user,pass}. Em edicao, campo vazio mantem o valor atual. */
    save: function (f, id) {
      var all = load(), cur = id ? App.lists.get(id) : null;
      var rec = cur ? JSON.parse(JSON.stringify(cur)) : { id: App.uid(), added: Date.now(), updated: 0, error: '' };
      rec.name = f.name; rec.type = f.type;
      var p = Promise.resolve();
      if (f.type === 'm3u') {
        rec.server = rec.user = rec.passS = '';
        if (f.url) p = App.secrets.seal(f.url).then(function (s) { rec.urlS = s; });
      } else {
        rec.urlS = ''; rec.server = f.server; rec.user = f.user;
        if (f.pass) p = App.secrets.seal(f.pass).then(function (s) { rec.passS = s; });
      }
      return p.then(function () {
        var i, found = false;
        for (i = 0; i < all.length; i++) if (all[i].id === rec.id) { all[i] = rec; found = true; }
        if (!found) all.push(rec);
        save(all); delete credCache[rec.id];
        if (!App.store.get('active', null)) App.lists.setActive(rec.id);
        return rec;
      });
    },
    patch: function (id, fields) {
      var all = load();
      all.forEach(function (l) { if (l.id === id) for (var k in fields) l[k] = fields[k]; });
      save(all);
    },
    remove: function (id) {
      save(load().filter(function (l) { return l.id !== id; }));
      delete credCache[id];
      if (App.store.get('active', null) === id) { var r = load()[0]; App.store.set('active', r ? r.id : null); }
      return App.catalog.dropCache(id);
    },
    /* credenciais em texto, so em memoria */
    creds: function (l) {
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
