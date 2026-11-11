/* Parser M3U/M3U8 em fluxo (aceita listas de dezenas de MB): atributos livres, aspas simples/duplas,
   EXTGRP, CRLF, BOM. Classifica em live / movie / series. Episodios ficam EMPACOTADOS em texto
   (um bloco por serie) e so sao expandidos quando a serie e aberta, para poupar memoria na TV. */
(function (g) {
  'use strict';
  var App = g.App || (g.App = {});
  var hash = App.hash || function (s) { var h = 5381, i; for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  var norm = App.norm || function (s) { return String(s || '').toLowerCase(); };
  var EPCHUNK = 400;   /* series por bloco de episodios no cache */

  var RE_EP = /^(.*?)[\s._\-]*[\(\[]?\b[Ss](\d{1,3})\s*[._\-]?\s*[Ee](\d{1,4})\b[\)\]]?[\s._\-:]*(.*)$/;
  var RE_EP2 = /^(.*?)[\s._\-]+(\d{1,2})x(\d{1,3})\b[\s._\-:]*(.*)$/;
  var RE_VOD_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|m4v)(\?|$)/i;
  var RE_GRP_MOVIE = /(filme|movie|vod|cinema|lan[cç]amento)/i;
  var RE_GRP_SERIES = /(s[eé]rie|series|temporada|season|tv show)/i;
  var RE_GRP_LIVE = /(canais|canal|ao vivo|live|24h|24 horas)/i;

  /* copia independente: substring de V8 mantem o texto original inteiro vivo; isto evita reter o arquivo todo */
  function own(s) { return s.length < 13 ? s : JSON.parse(JSON.stringify(s)); }

  /* separa "atributos,nome" respeitando virgulas dentro de aspas */
  function splitInfo(line) {
    var q = null, i, ch;
    for (i = 0; i < line.length; i++) {
      ch = line.charAt(i);
      if (q) { if (ch === q) q = null; }
      else if (ch === '"' || ch === "'") q = ch;
      else if (ch === ',') return [line.slice(0, i), line.slice(i + 1)];
    }
    return [line, ''];
  }
  function parseAttrs(s) {
    var out = {}, re = /([A-Za-z0-9_\-]+)=(?:"([^"]*)"|'([^']*)'|([^\s,"']+))/g, m;
    while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
    return out;
  }
  function classify(name, group, url, dur) {
    var m = RE_EP.exec(name) || RE_EP2.exec(name);
    if (/\/series\//i.test(url) || (m && !RE_GRP_LIVE.test(group))) return 'series';
    if (/\/movie\//i.test(url)) return 'movie';
    if (RE_GRP_SERIES.test(group) && !RE_GRP_LIVE.test(group)) return 'series';
    if (RE_GRP_MOVIE.test(group) && !RE_GRP_LIVE.test(group)) return 'movie';
    if (RE_VOD_EXT.test(url) || dur > 0) return 'movie';
    return 'live';
  }
  function yearOf(name) {
    var m = /[\(\[](19\d{2}|20\d{2})[\)\]]/.exec(name) || /\s(19\d{2}|20\d{2})$/.exec(name);
    return m ? m[1] : '';
  }

  function Parser() {
    this.carry = ''; this.first = true; this.cur = null; this.extGrp = '';
    this.res = { live: [], movie: [], series: [], cats: { live: [], movie: [], series: [] } };
    this.catSeen = { live: {}, movie: {}, series: {} };
    this.sMap = {}; this.sList = [];
  }
  var P = Parser.prototype;

  P.addCat = function (t, name) {
    if (!this.catSeen[t][name]) { this.catSeen[t][name] = name; this.res.cats[t].push({ id: name, name: name }); }
    return this.catSeen[t][name];
  };

  P.push = function (info, url) {
    var res = this.res, name = info.name || info.attrs['tvg-name'] || '', group = info.attrs['group-title'] || info.group || '';
    var t = classify(name, group, url, info.dur), logo = info.attrs['tvg-logo'] || info.attrs['logo'] || '';
    var cat = this.addCat(t, own(group || 'Sem categoria')), m, sname, key, s, n;
    if (!name) name = 'Sem nome';
    if (t === 'series') {
      m = RE_EP.exec(name) || RE_EP2.exec(name);
      sname = m ? m[1].replace(/[\s._\-:]+$/, '') : name;
      if (!sname) sname = name;
      key = cat + '|' + sname;
      s = this.sMap[key];
      if (!s) {
        n = res.series.length; sname = own(sname);
        s = this.sMap[key] = { id: 'm' + hash(key), t: 'series', n: sname, ns: norm(sname), c: cat, l: own(logo), y: yearOf(sname), ek: Math.floor(n / EPCHUNK), ei: n % EPCHUNK };
        s.pk = []; s.cnt = 0;
        res.series.push(s); this.sList.push(s);
      }
      if (!s.l && logo) s.l = own(logo);
      var sn = m ? parseInt(m[2], 10) : 1, en = m ? parseInt(m[3], 10) : (++s.cnt), title = (m && m[4]) || name;
      s.pk.push(own(sn + '\t' + en + '\t' + title.replace(/[\t\n]/g, ' ') + '\t' + url));
      return;
    }
    name = own(name);
    res[t].push({
      id: 'm' + hash(url), t: t, n: name, ns: norm(name), c: cat, l: own(logo), u: own(url),
      y: t === 'movie' ? yearOf(name) : '', d: info.dur > 0 ? info.dur : 0
    });
  };

  P.line = function (line) {
    line = line.replace(/^\s+|\s+$/g, '');
    if (!line) return;
    if (line.charAt(0) === '#') {
      if (line.indexOf('#EXTINF:') === 0) {
        var p = splitInfo(line.slice(8)), head = p[0], durM = /^\s*(-?\d+(?:\.\d+)?)/.exec(head);
        this.cur = { dur: durM ? parseFloat(durM[1]) : -1, attrs: parseAttrs(head), name: p[1].replace(/^\s+|\s+$/g, ''), group: this.extGrp };
      } else if (line.indexOf('#EXTGRP:') === 0) {
        this.extGrp = line.slice(8).replace(/^\s+|\s+$/g, '');
        if (this.cur) this.cur.group = this.extGrp;
      }
      return;
    }
    if (this.cur) {
      if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(line)) this.push(this.cur, line);
      this.cur = null;
    }
  };

  /* recebe texto em pedacos; guarda a ultima linha incompleta para o proximo pedaco */
  P.feed = function (text) {
    if (this.first) { if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); this.first = false; }
    text = this.carry + text;
    var last = text.lastIndexOf('\n'), i = 0, j;
    if (last < 0) { this.carry = text; return; }
    while (i <= last) { j = text.indexOf('\n', i); this.line(text.substring(i, j)); i = j + 1; }
    this.carry = own(text.slice(last + 1));
  };

  /* devolve {live,movie,series,cats,epPacked} ou lanca {code:'invalid'} */
  P.end = function () {
    if (this.carry) { this.line(this.carry); this.carry = ''; }
    var res = this.res;
    if (!(res.live.length + res.movie.length + res.series.length)) throw { code: 'invalid' };
    res.epPacked = this.sList.map(function (s) { var t = s.pk.join('\n'); delete s.pk; delete s.cnt; return t; });
    this.sMap = null; this.sList = null;
    return res;
  };

  /* episodios empacotados -> [{n, eps:[{id,e,title,url}]}] */
  function unpack(str) {
    var seasons = {}, lines = String(str || '').split('\n'), i, p, sn, url;
    for (i = 0; i < lines.length; i++) {
      p = lines[i].split('\t'); if (p.length < 4) continue;
      sn = parseInt(p[0], 10); url = p.slice(3).join('\t');
      (seasons[sn] = seasons[sn] || []).push({ id: 'e' + hash(url), e: parseInt(p[1], 10), title: p[2], url: url });
    }
    return Object.keys(seasons).map(Number).sort(function (a, b) { return a - b; }).map(function (n) {
      return { n: n, eps: seasons[n].sort(function (a, b) { return a.e - b.e; }) };
    });
  }

  /* conveniencia: texto inteiro -> Promise (usado em testes e navegadores sem streaming) */
  function parse(text) {
    return new Promise(function (resolve, reject) {
      try {
        if (typeof text !== 'string') throw { code: 'invalid' };
        var p = new Parser(), i = 0, step = 1 << 20;
        (function next() {
          try {
            var end = Math.min(text.length, i + step);
            p.feed(text.slice(i, end)); i = end;
            if (i < text.length) return setTimeout(next, 0);
            resolve(p.end());
          } catch (e) { reject(e && e.code ? e : { code: 'invalid' }); }
        })();
      } catch (e) { reject(e); }
    });
  }

  App.m3u = { Parser: Parser, parse: parse, unpack: unpack, classify: classify, EPCHUNK: EPCHUNK };
  if (typeof module !== 'undefined' && module.exports) module.exports = App.m3u;
})(typeof window !== 'undefined' ? window : global);
