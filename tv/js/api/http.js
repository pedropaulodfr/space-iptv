/* Requisicoes HTTP com timeout e erros classificados */
(function (g) {
  'use strict';
  var App = g.App;

  /* opts: {timeout:ms, json:bool}. Rejeita com {code, status} sem expor a URL. */
  App.http = {
    /* Baixa em pedacos (Uint8Array) sem montar o arquivo todo na memoria.
       opts: {idle:ms sem dados, onChunk(u8), onProgress(loaded,total)}. fetch primeiro; XHR binario como reserva. */
    stream: function (url, opts) {
      opts = opts || {};
      return new Promise(function (resolve, reject) {
        if (!App.isOnline()) return reject({ code: 'offline' });
        var loaded = 0, total = 0, got = false, idle = opts.idle || 60000, timer = null, dead = false;
        function fail(code, status) { if (dead) return; dead = true; clearTimeout(timer); reject({ code: code, status: status || 0 }); }
        function ok() { if (dead) return; dead = true; clearTimeout(timer); resolve(loaded); }
        function ping(onTimeout) { clearTimeout(timer); timer = setTimeout(onTimeout, idle); }

        function viaXhr() {
          var x = new XMLHttpRequest();
          try { x.open('GET', url, true); } catch (e) { return fail('network'); }
          x.responseType = 'arraybuffer'; x.timeout = 0;
          ping(function () { x.abort(); fail('timeout'); });
          x.onprogress = function (e) { ping(function () { x.abort(); fail('timeout'); }); loaded = e.loaded; total = e.lengthComputable ? e.total : 0; if (opts.onProgress) opts.onProgress(loaded, total); };
          x.onerror = function () { fail('network'); };
          x.onabort = function () { fail('network'); };
          x.onload = function () {
            if (x.status < 200 || x.status >= 300) return fail('http', x.status);
            var buf = x.response, i = 0, step = 1 << 20;
            clearTimeout(timer); loaded = buf.byteLength;
            (function next() {
              if (dead) return;
              try { opts.onChunk(new Uint8Array(buf, i, Math.min(step, buf.byteLength - i))); } catch (e) { return fail(e && e.code ? e.code : 'parse'); }
              i += step;
              if (i < buf.byteLength) return setTimeout(next, 0);
              buf = null; x.response = null; ok();
            })();
          };
          try { x.send(); } catch (e2) { fail('network'); }
        }

        if (!(g.fetch && g.ReadableStream && g.AbortController)) return viaXhr();
        var ctl = new AbortController();
        ping(function () { ctl.abort(); fail('timeout'); });
        g.fetch(url, { signal: ctl.signal }).then(function (r) {
          if (!r.ok) return fail('http', r.status);
          if (!r.body || !r.body.getReader) { ctl.abort(); return viaXhr(); }
          total = parseInt(r.headers.get('content-length'), 10) || 0;
          var rd = r.body.getReader();
          (function pump() {
            rd.read().then(function (d) {
              if (dead) return;
              if (d.done) return ok();
              got = true; loaded += d.value.length; ping(function () { ctl.abort(); fail('timeout'); });
              try { opts.onChunk(d.value); } catch (e) { ctl.abort(); return fail(e && e.code ? e.code : 'parse'); }
              if (opts.onProgress) opts.onProgress(loaded, total);
              pump();
            }, function () { if (!got && !dead) viaXhr(); else fail('network'); });
          })();
        }, function () { if (!got && !dead) viaXhr(); else fail('network'); });
      });
    },

    get: function (url, opts) {
      opts = opts || {};
      return new Promise(function (resolve, reject) {
        if (!App.isOnline()) return reject({ code: 'offline' });
        var x = new XMLHttpRequest(), done = false;
        function fail(code, status) { if (done) return; done = true; reject({ code: code, status: status || 0 }); }
        try { x.open('GET', url, true); } catch (e) { return fail('network'); }
        if (opts.headers) { for (var h in opts.headers) { if (Object.prototype.hasOwnProperty.call(opts.headers, h)) { try { x.setRequestHeader(h, opts.headers[h]); } catch (e0) { /* header invalido */ } } } }
        x.timeout = opts.timeout || 30000;
        x.onload = function () {
          if (done) return;
          if (x.status < 200 || x.status >= 300) return fail('http', x.status);
          var t = x.responseText;
          if (opts.json) {
            try { done = true; resolve(JSON.parse(t)); } catch (e) { done = false; fail('parse'); }
          } else { done = true; resolve(t); }
        };
        x.onerror = function () { fail('network'); };
        x.ontimeout = function () { fail('timeout'); };
        x.onabort = function () { fail('network'); };
        try { x.send(); } catch (e) { fail('network'); }
      });
    },

    /* Verifica alcance de um stream sem baixa-lo por inteiro.
       opts: {timeout, maxBytes, range}. Devolve {ok,status,code,ttfb,ms,bytes,kind,contentType,text}.
       Nao registra a URL em erros. */
    probe: function (url, opts) {
      opts = opts || {};
      var api = { abort: null };
      var p = new Promise(function (resolve) {
        if (!App.isOnline()) return resolve({ ok: false, code: 'offline', status: 0, ttfb: 0, ms: 0, bytes: 0, kind: 'unknown', inconclusive: true });
        var start = Date.now(), done = false, xhr = null, ctl = null, timer = null, tryingOpaque = false;
        var status = 0, ttfb = 0, contentType = '', bytes = 0, buf = null, headers = false;
        var maxBytes = opts.maxBytes || 65536, timeout = opts.timeout || 8000;
        var hls = /\.m3u8(?:[?#]|$)/i.test(url);

        function decode(b) {
          if (!b || !b.length) return '';
          try { if (g.TextDecoder) return new g.TextDecoder('utf-8').decode(b); } catch (e0) { /* fallback */ }
          var s = '', i;
          for (i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
          return s;
        }
        function kindOf(b, ct) {
          ct = String(ct || '').toLowerCase();
          if (/mpegurl/.test(ct) || hls) return 'hls';
          if (/^text\/html/.test(ct)) return 'html';
          /* bytes existentes valem mais que o content-type */
          if (b && b.length) {
            var s = '', i;
            for (i = 0; i < Math.min(b.length, 16); i++) s += String.fromCharCode(b[i]);
            if (s.indexOf('#EXTM3U') >= 0 && s.indexOf('#EXTM3U') < 3) return 'hls';
            if (b[0] === 0x47) return 'ts';
            if (s.substr(4, 4) === 'ftyp') return 'mp4';
            if (s.charAt(0) === '<') return 'html';
          }
          /* vazio ainda pode ser stream: servidores TS/octet-stream mandam cabecalho antes do corpo */
          if (/^(video|audio)\//.test(ct) || /octet-stream|mp2t/.test(ct)) return 'video';
          if (!b || !b.length) return 'empty';
          return 'binary';
        }
        function finish(res) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (ctl) { try { ctl.abort(); } catch (e1) { /* ignore */ } }
          if (xhr) {
            xhr.onreadystatechange = xhr.onprogress = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
            try { xhr.abort(); } catch (e2) { /* ignore */ }
          }
          res = res || {};
          if (res.ms == null) res.ms = Date.now() - start;
          if (res.ttfb == null) res.ttfb = ttfb || res.ms;
          if (res.status == null) res.status = status;
          if (res.contentType == null) res.contentType = contentType;
          if (res.bytes == null) res.bytes = bytes;
          if (!res.kind) res.kind = kindOf(buf, contentType);
          if (res.kind === 'hls' && res.text == null && buf) res.text = decode(buf);
          resolve(res);
        }
        api.abort = function () { finish({ ok: false, code: 'abort', status: status, inconclusive: true }); };

        function opaque() {
          if (tryingOpaque) return;
          tryingOpaque = true;
          if (!g.fetch || !g.AbortController) return finish({ ok: false, code: 'network', status: 0 });
          var c = new g.AbortController(); ctl = c;
          timer = setTimeout(function () { try { c.abort(); } catch (e3) { /* ignore */ } finish({ ok: false, code: 'timeout', status: 0 }); }, timeout);
          g.fetch(url, { mode: 'no-cors', signal: c.signal, cache: 'no-store' }).then(function () {
            finish({ ok: false, code: 'opaque', status: 0, inconclusive: true, kind: 'unknown' });
          }, function () {
            finish({ ok: false, code: 'network', status: 0 });
          });
        }

        var x = xhr = new XMLHttpRequest();
        try { x.open('GET', url, true); } catch (e4) { return finish({ ok: false, code: 'network', status: 0 }); }
        x.responseType = 'arraybuffer';
        x.timeout = timeout;
        if (opts.range) { try { x.setRequestHeader('Range', 'bytes=0-' + (maxBytes - 1)); } catch (e5) { /* ignore */ } }
        x.onreadystatechange = function () {
          if (done) return;
          if (x.readyState >= 2 && !headers) {
            headers = true; status = x.status; ttfb = Date.now() - start;
            contentType = x.getResponseHeader('content-type') || '';
            if (/mpegurl/i.test(contentType)) hls = true;
          }
          if (x.readyState !== 4) return;
          if (x.status === 0) return opaque();
          var b = x.response;
          if (b) { bytes = b.byteLength; try { buf = new Uint8Array(b).slice(0, maxBytes); } catch (e6) { buf = null; } }
          var ok = status >= 200 && status < 400;
          finish({ ok: ok, code: ok ? '' : 'http', status: status, kind: kindOf(buf, contentType) });
        };
        x.onprogress = function (e) {
          if (done) return;
          bytes = e.loaded;
          if (!buf && x.response) { try { buf = new Uint8Array(x.response).slice(0, maxBytes); } catch (e7) { /* ignore */ } }
          /* erro HTTP tem prioridade: sem isso um 404 com corpo HTML viraria "ok" */
          if (status >= 400) return finish({ ok: false, code: 'http', status: status, kind: kindOf(buf, contentType) });
          if (!hls) return finish({ ok: true, status: status, kind: kindOf(buf, contentType) });
          if (bytes >= maxBytes) finish({ ok: true, status: status, kind: kindOf(buf, contentType) });
        };
        x.onerror = function () { if (!done) opaque(); };
        x.ontimeout = function () { finish({ ok: false, code: 'timeout', status: status }); };
        x.onabort = function () { if (!done) finish({ ok: false, code: 'abort', status: status, inconclusive: true }); };
        try { x.send(); } catch (e8) { finish({ ok: false, code: 'network', status: 0 }); }
      });
      p.abort = function () { if (api.abort) api.abort(); };
      return p;
    }
  };
})(window);
