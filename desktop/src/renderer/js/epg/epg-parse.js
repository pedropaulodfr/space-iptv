/* Parser XMLTV incremental (fluxo) do Space IPTV Desktop.
 *
 * - Recebe texto em pedacos (`feed`), sem DOM/DOMParser e sem carregar o XMLTV inteiro de uma vez.
 * - Le <channel id><display-name> e <programme start stop channel><title><desc><category><icon>.
 * - Tolerante: comentarios, CDATA, DOCTYPE, entidades XML/HTML comuns, XML truncado.
 * - Dedup por (channelId, inicio) e por (nome normalizado, inicio).
 * - Datas XMLTV "YYYYMMDDhhmmss +HHMM" (e variantes sem segundos/offset) -> timestamp UTC (ms).
 * - Resultado invalido (sem canal e sem programa): lanca {code:'invalid'}.
 *
 * UMD como tv/js/parser/m3u.js: no navegador vive em App.epgParse; no Node `require` devolve a API.
 */
(function (g) {
  'use strict';
  var App = g.App || (g.App = {});

  var DEFAULT_OFFSET_MIN = 0;   /* XMLTV sem fuso: assume UTC (o chamador pode configurar) */
  var MAX_PENDING = 4 << 20;    /* tag sem '>' maior que isso = arquivo invalido (nao segurar memoria) */

  /* copia independente: substring de V8 mantem o texto original inteiro vivo */
  function own(s) { return s == null ? '' : (s.length < 12 ? s : JSON.parse(JSON.stringify(s))); }

  /* ---------- normalizacao de nome (sem acento/caixa/espacos/pontuacao) ---------- */
  function normName(s) {
    var t = null;
    if (typeof App.norm === 'function') {
      try { t = App.norm(s); } catch (e) { t = null; }
    }
    if (t == null) {
      t = String(s == null ? '' : s).toLowerCase();
      try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e2) { /* sem normalize */ }
    }
    return String(t).replace(/[^a-z0-9]+/g, '');
  }

  /* ---------- entidades ---------- */
  var NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    /* entidades HTML comuns em XMLTV "torto" (teoricamente invalidas, mas aparecem) */
    nbsp: ' ', aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä',
    eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', iacute: 'í', igrave: 'ì',
    icirc: 'î', iuml: 'ï', oacute: 'ó', ograve: 'ò', ocirc: 'ô', otilde: 'õ',
    ouml: 'ö', uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', ccedil: 'ç',
    ntilde: 'ñ', Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä',
    Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Iacute: 'Í', Oacute: 'Ó', Ograve: 'Ò',
    Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Uacute: 'Ú', Ccedil: 'Ç', Ntilde: 'Ñ',
    hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”'
  };
  var RE_ENT = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]{1,15});/g;

  function decodeEntities(s) {
    s = String(s == null ? '' : s);
    if (s.indexOf('&') < 0) return s;
    return s.replace(RE_ENT, function (all, body) {
      if (body.charAt(0) === '#') {
        var n = body.charAt(1) === 'x' || body.charAt(1) === 'X'
          ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!isFinite(n) || n <= 0 || n > 0x10ffff) return all;
        try { return String.fromCodePoint(n); } catch (e) { return all; }
      }
      var v = NAMED[body];
      return v != null ? v : all;
    });
  }

  function collapse(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  }

  /* ---------- datas XMLTV -> UTC (ms) ---------- */
  var RE_DATE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-])(\d{2}):?(\d{2}))?$/;

  /* Aceita 20261114180000 -0300 / 202611141800 -0300 / 20261114180000 / 20261114180000+0000.
     Sem offset usa defaultOffsetMin (minutos a somar ao UTC local para obter UTC). */
  function parseDate(s, defaultOffsetMin) {
    var m = RE_DATE.exec(collapse(s));
    if (!m) return null;
    var y = +m[1], mo = +m[2] - 1, d = +m[3], hh = +m[4], mi = +m[5], ss = m[6] == null ? 0 : +m[6];
    if (mo < 0 || mo > 11 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return null;
    var off = defaultOffsetMin == null ? DEFAULT_OFFSET_MIN : defaultOffsetMin;
    if (m[7]) off = (m[7] === '-' ? -1 : 1) * (+m[8] * 60 + +m[9]);
    var utc = Date.UTC(y, mo, d, hh, mi, ss) - off * 60000;
    return isFinite(utc) ? utc : null;
  }

  /* ---------- atributos ---------- */
  var RE_ATTR = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  function parseAttrs(raw) {
    var out = {}, m;
    RE_ATTR.lastIndex = 0;
    while ((m = RE_ATTR.exec(raw))) out[m[1].toLowerCase()] = decodeEntities(m[2] != null ? m[2] : m[3]);
    return out;
  }

  function tagName(raw) {
    var m = /^\s*\/?\s*([A-Za-z_][\w.:-]*)/.exec(raw);
    return m ? m[1].toLowerCase() : '';
  }
  function isClosing(raw) { return /^\s*\//.test(raw); }
  function isSelfClosing(raw) { return /\/\s*$/.test(raw); }

  /* '>' final de um <!DOCTYPE ... [ subset interno ]>; -1 se ainda nao chegou */
  function doctypeEnd(buf) {
    var open = buf.indexOf('['), gt = buf.indexOf('>');
    if (open < 0 || (gt >= 0 && gt < open)) return gt;
    var close = buf.indexOf(']>', open);
    return close < 0 ? -1 : close + 1;
  }

  /* ---------- parser ---------- */
  function Parser(o) {
    o = o || {};
    this.defaultOffsetMin = o.defaultOffsetMin != null ? o.defaultOffsetMin : DEFAULT_OFFSET_MIN;
    this.buf = '';
    this.first = true;
    this.channels = [];
    this.chMap = {};
    this.programmes = [];
    this.cur = null;        /* programa em construcao */
    this.curCh = null;      /* canal em construcao */
    this.cap = null;        /* texto sendo capturado: {field,text,cdata} */
    this.seen = {};         /* dedup (channelId|start) */
    this.ended = false;
    this.stats = { duplicates: 0, invalidDates: 0, ignored: 0, truncated: false };
  }
  var P = Parser.prototype;

  P.feed = function (text) {
    if (this.ended) return this;
    text = String(text == null ? '' : text);
    if (!text) return this;
    if (this.first) {
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      if (this.buf.charCodeAt(0) === 0xFEFF) this.buf = this.buf.slice(1);
      this.first = false;
    }
    this.buf += text;
    this.scan();
    return this;
  };

  /* consome o buffer ate onde for seguro; guarda o resto (tag/texto incompletos) */
  P.scan = function () {
    var buf = this.buf, i;
    while (true) {
      var lt = buf.indexOf('<');
      if (lt < 0) {
        if (this.cap) this.cap.text += buf;
        this.buf = '';
        return;
      }
      if (lt > 0) {
        if (this.cap) this.cap.text += buf.slice(0, lt);
        buf = buf.slice(lt);
      }
      var head = buf.substr(0, 9), end;
      if (head === '<!--') {
        end = buf.indexOf('-->');
        if (end < 0) return this.hold(buf);
        buf = buf.slice(end + 3);
      } else if (head === '<![CDATA[') {
        end = buf.indexOf(']]>');
        if (end < 0) return this.hold(buf);
        if (this.cap) this.cap.cdata += buf.slice(9, end);
        buf = buf.slice(end + 3);
      } else if (buf.charAt(1) === '?') {
        end = buf.indexOf('?>');
        if (end < 0) return this.hold(buf);
        buf = buf.slice(end + 2);
      } else if (buf.charAt(1) === '!') {
        end = doctypeEnd(buf);
        if (end < 0) return this.hold(buf);
        buf = buf.slice(end + 1);
      } else {
        end = buf.indexOf('>');
        if (end < 0) return this.hold(buf);
        var raw = buf.slice(1, end);
        buf = buf.slice(end + 1);
        this.tag(raw);
      }
    }
  };

  P.hold = function (rest) {
    if (rest.length > MAX_PENDING) throw { code: 'invalid' };
    this.buf = rest;
  };

  P.startCapture = function (field) { this.cap = { field: field, text: '', cdata: '' }; };

  P.endCapture = function () {
    var cap = this.cap;
    this.cap = null;
    if (!cap) return;
    var plain = collapse(decodeEntities(cap.text));
    var cdata = collapse(cap.cdata);
    var val = plain && cdata ? (plain + ' ' + cdata) : (plain || cdata);
    if (!val) return;
    if (cap.field === 'display-name') {
      if (this.curCh && this.curCh.names.indexOf(val) < 0) this.curCh.names.push(val);
      return;
    }
    if (!this.cur || this.cur.skip) return;
    if (cap.field === 'title') this.cur.t = val;
    else if (cap.field === 'desc') this.cur.d = val;
    else if (cap.field === 'category') this.cur.cat.push(val);
  };

  P.tag = function (raw) {
    var name = tagName(raw);
    if (!name) return;
    var closing = isClosing(raw), selfClosing = isSelfClosing(raw), attrs = null;

    /* qualquer fechamento encerra a captura pendente (tolerante a XML "torto") */
    if (closing && this.cap) this.endCapture();

    if (name === 'channel') {
      if (!closing) {
        attrs = parseAttrs(raw);
        if (this.curCh) { this.stats.ignored++; this.curCh = null; }
        this.curCh = { id: attrs.id || '', names: [], icon: attrs.icon || '' };
      } else if (this.curCh) {
        var ch = this.curCh;
        this.curCh = null;
        if (!ch.id) { this.stats.ignored++; return; }
        var prev = this.chMap[ch.id];
        if (prev) {   /* mesmo id declarado duas vezes: junta os nomes */
          for (var n = 0; n < ch.names.length; n++) if (prev.names.indexOf(ch.names[n]) < 0) prev.names.push(ch.names[n]);
          if (!prev.icon && ch.icon) prev.icon = ch.icon;
          return;
        }
        this.channels.push(ch);
        this.chMap[ch.id] = ch;
      }
      return;
    }

    if (name === 'display-name') {
      if (closing) { if (this.cap) this.endCapture(); return; }
      if (!selfClosing && this.curCh) this.startCapture('display-name');
      return;
    }

    if (name === 'programme') {
      if (closing) { this.endProgramme(); return; }
      if (this.cur) { this.stats.truncated = true; this.endProgramme(); }
      attrs = parseAttrs(raw);
      var st = parseDate(attrs.start, this.defaultOffsetMin);
      if (!attrs.channel || st == null) {
        if (attrs.channel) this.stats.invalidDates++;
        else this.stats.ignored++;
        this.cur = { skip: true };
        return;
      }
      var stop = parseDate(attrs.stop, this.defaultOffsetMin);
      if (stop != null && stop <= st) stop = null;
      this.cur = { c: attrs.channel, s: st, e: stop == null ? 0 : stop, t: '', d: '', cat: [] };
      return;
    }

    if (name === 'title' || name === 'desc' || name === 'category') {
      if (closing) { if (this.cap) this.endCapture(); return; }
      if (!selfClosing && this.cur && !this.cur.skip) this.startCapture(name);
      return;
    }

    /* icon, lang, rating, episode-num, video, audio, subtitles... sao ignorados */
    if (selfClosing && this.cap) this.endCapture();
  };

  P.endProgramme = function () {
    var pr = this.cur;
    this.cur = null;
    if (this.cap) this.endCapture();      /* fecha captura pendente antes de finalizar */
    if (!pr || pr.skip) return;
    var key = pr.c + '|' + pr.s;
    if (this.seen[key]) { this.stats.duplicates++; return; }
    this.seen[key] = 1;
    this.programmes.push({
      c: pr.c,
      s: pr.s,
      e: pr.e && pr.e > pr.s ? pr.e : 0,
      t: own(collapse(pr.t)),
      d: own(collapse(pr.d)),
      cat: own(collapse(pr.cat.join(' / ')))
    });
  };

  /* dedup por (nome normalizado do canal, inicio): roda no fim, quando todos os canais sao conhecidos */
  P.dedupByName = function () {
    var out = [], seen = {}, i, pr, ch, nm, key;
    for (i = 0; i < this.programmes.length; i++) {
      pr = this.programmes[i];
      ch = this.chMap[pr.c];
      nm = ch && ch.names.length ? normName(ch.names[0]) : '';
      if (nm) {
        key = nm + '|' + pr.s;
        if (seen[key]) { this.stats.duplicates++; continue; }
        seen[key] = 1;
      }
      out.push(pr);
    }
    this.programmes = out;
  };

  /* devolve {channels, programmes, stats} ou lanca {code:'invalid'} */
  P.end = function () {
    if (this.ended) throw { code: 'invalid' };
    this.ended = true;
    /* resto sem '<': texto solto (provavelmente truncado) e descartado */
    if (this.cur) { this.stats.truncated = true; this.endProgramme(); }
    this.cap = null;
    this.buf = '';
    this.dedupByName();
    if (!this.channels.length && !this.programmes.length) throw { code: 'invalid' };
    return {
      channels: this.channels,
      programmes: this.programmes,
      stats: this.stats
    };
  };

  function parse(text, opts) {
    var p = new Parser(opts);
    p.feed(text);
    return p.end();
  }

  var api = {
    Parser: Parser,
    parse: parse,
    parseDate: parseDate,
    normName: normName,
    decodeEntities: decodeEntities,
    collapse: collapse,
    DEFAULT_OFFSET_MIN: DEFAULT_OFFSET_MIN
  };
  App.epgParse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
