/* Cliente Xtream Codes (player_api.php). Nao assume que todos os endpoints existem. */
(function (g) {
  'use strict';
  var App = g.App;
  var T = 45000;

  function server(s) {
    s = String(s || '').replace(/^\s+|\s+$/g, '');
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s.replace(/\/(player_api|get|panel_api)\.php.*$/i, '').replace(/\/+$/, '');
  }
  function api(c, action, extra) {
    var u = server(c.server) + '/player_api.php?username=' + encodeURIComponent(c.user) + '&password=' + encodeURIComponent(c.pass);
    if (action) u += '&action=' + action;
    if (extra) u += extra;
    return u;
  }
  function arr(v) { return Object.prototype.toString.call(v) === '[object Array]' ? v : []; }
  function s(v) { return v == null ? '' : String(v); }
  function yearOf(v) { var m = /(19\d{2}|20\d{2})/.exec(s(v)); return m ? m[1] : ''; }

  /* Valida credenciais; devolve {user_info, server_info} */
  function auth(c) {
    return App.http.get(api(c), { json: true, timeout: 20000 }).then(function (d) {
      var ui = d && d.user_info;
      if (!ui) throw { code: 'auth' };
      if (String(ui.auth) === '0' || ui.auth === false) throw { code: 'auth' };
      if (ui.status && /disabled|banned|expired/i.test(String(ui.status)) && String(ui.auth) !== '1') throw { code: 'auth' };
      return d;
    });
  }

  function soft(p) { return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; }); }

  function mapAll(list, fn) {
    var out = [], i = 0;
    return new Promise(function (res) {
      (function step() {
        var end = Math.min(list.length, i + 3000);
        for (; i < end; i++) { var r = fn(list[i]); if (r) out.push(r); }
        if (i < list.length) setTimeout(step, 0); else res(out);
      })();
    });
  }

  function cats(raw, items) {
    var out = [], seen = {};
    arr(raw).forEach(function (c) { var id = s(c.category_id); if (id && !seen[id]) { seen[id] = 1; out.push({ id: id, name: s(c.category_name) || ('Categoria ' + id) }); } });
    var missing = false;
    items.forEach(function (it) { if (!seen[it.c]) { seen[it.c] = 1; missing = true; out.push({ id: it.c, name: it.c === '0' ? 'Sem categoria' : 'Categoria ' + it.c }); } });
    return out;
  }
  function catOf(v) { v = s(v); return v ? v : '0'; }

  /* Carrega tudo. Falhas parciais (ex.: servidor sem series) viram aviso, nao erro. */
  function fetchAll(c, onProgress) {
    var warns = [];
    var jobs = ['get_live_categories', 'get_live_streams', 'get_vod_categories', 'get_vod_streams', 'get_series_categories', 'get_series'];
    var done = 0;
    return auth(c).then(function (info) {
      return Promise.all(jobs.map(function (a) {
        return soft(App.http.get(api(c, a), { json: true, timeout: T })).then(function (r) { done++; if (onProgress) onProgress(done / jobs.length * 0.7); return r; });
      })).then(function (r) { return { info: info, r: r }; });
    }).then(function (o) {
      var r = o.r, names = ['TV ao vivo', 'filmes', 'séries'];
      [[0, 1], [2, 3], [4, 5]].forEach(function (p, i) {
        if (!r[p[1]].ok) warns.push('Não foi possível carregar ' + names[i] + '.');
      });
      if (r.every(function (x) { return !x.ok; })) throw r[1].e || { code: 'network' };
      var live = r[1].ok ? arr(r[1].v) : [], vod = r[3].ok ? arr(r[3].v) : [], ser = r[5].ok ? arr(r[5].v) : [];
      return Promise.all([
        mapAll(live, function (x) { var n = s(x.name); return { id: s(x.stream_id), t: 'live', n: n, ns: App.norm(n), c: catOf(x.category_id), l: s(x.stream_icon), tvg: s(x.epg_channel_id) }; }),
        mapAll(vod, function (x) { var n = s(x.name); return { id: s(x.stream_id), t: 'movie', n: n, ns: App.norm(n), c: catOf(x.category_id), l: s(x.stream_icon), x: s(x.container_extension) || 'mp4', r: s(x.rating), a: Number(x.added) || 0, y: yearOf(x.year || x.releaseDate) || yearOf(n) }; }),
        mapAll(ser, function (x) { var n = s(x.name); return { id: s(x.series_id), t: 'series', n: n, ns: App.norm(n), c: catOf(x.category_id), l: s(x.cover), p: s(x.plot), g: s(x.genre), y: yearOf(x.year || x.releaseDate || x.release_date), r: s(x.rating), a: Number(x.last_modified) || 0, bd: arr(x.backdrop_path)[0] || '' }; })
      ]).then(function (it) {
        if (onProgress) onProgress(0.95);
        return {
          live: it[0], movie: it[1], series: it[2], warns: warns,
          cats: { live: cats(r[0].ok ? r[0].v : [], it[0]), movie: cats(r[2].ok ? r[2].v : [], it[1]), series: cats(r[4].ok ? r[4].v : [], it[2]) }
        };
      });
    });
  }

  function seriesInfo(c, id) {
    return App.http.get(api(c, 'get_series_info', '&series_id=' + encodeURIComponent(id)), { json: true, timeout: 30000 }).then(function (d) {
      if (!d || typeof d !== 'object') throw { code: 'parse' };
      var info = d.info || {}, eps = d.episodes || {}, out = [];
      if (Object.prototype.toString.call(eps) === '[object Array]') { var o = {}; eps.forEach(function (list, i) { o[i + 1] = list; }); eps = o; }
      Object.keys(eps).map(Number).sort(function (a, b) { return a - b; }).forEach(function (sn) {
        var list = arr(eps[sn]).map(function (e) {
          var inf = e.info || {};
          return { id: s(e.id), e: Number(e.episode_num) || 0, title: s(e.title), x: s(e.container_extension) || 'mp4', dur: s(inf.duration), plot: s(inf.plot), l: s(inf.movie_image) };
        }).sort(function (a, b) { return a.e - b.e; });
        if (list.length) out.push({ n: sn, eps: list });
      });
      return { info: { plot: s(info.plot), g: s(info.genre), y: yearOf(info.releaseDate || info.release_date), r: s(info.rating), cast: s(info.cast), l: s(info.cover), bd: arr(info.backdrop_path)[0] || '' }, seasons: out };
    });
  }

  function vodInfo(c, id) {
    return App.http.get(api(c, 'get_vod_info', '&vod_id=' + encodeURIComponent(id)), { json: true, timeout: 20000 }).then(function (d) {
      var i = (d && d.info) || {};
      return { plot: s(i.plot || i.description), g: s(i.genre), y: yearOf(i.releasedate || i.release_date), dur: s(i.duration), r: s(i.rating), bd: arr(i.backdrop_path)[0] || '', l: s(i.movie_image) };
    });
  }

  function base(c) { var b = server(c.server); return b; }
  function path(c, kind, id, ext) { return base(c) + '/' + kind + '/' + encodeURIComponent(c.user) + '/' + encodeURIComponent(c.pass) + '/' + id + (ext ? '.' + ext : ''); }

  /* Muitos paineis informam container_extension errado (ou nenhum) e, com a extensao
     errada, alguns servidores nem respondem 404 na hora: ficam pendurados ate o timeout.
     Tentar a outra extensao logo em seguida cobre o caso mais comum de "filme nao abre"
     sem o usuario precisar descobrir o formato certo. */
  function alternativas(c, kind, id, ext) {
    var e = String(ext || 'mp4').toLowerCase().replace(/^\./, '') || 'mp4';
    var alt = (e === 'mkv') ? 'mp4' : 'mkv';
    return [path(c, kind, id, e), path(c, kind, id, alt)];
  }

  App.xtream = {
    server: server, auth: auth, fetchAll: fetchAll, seriesInfo: seriesInfo, vodInfo: vodInfo,
    liveUrls: function (c, id) { return [path(c, 'live', id, 'm3u8'), path(c, 'live', id, 'ts')]; },
    movieUrls: function (c, id, ext) { return alternativas(c, 'movie', id, ext); },
    episodeUrls: function (c, id, ext) { return alternativas(c, 'series', id, ext); }
  };
})(window);
