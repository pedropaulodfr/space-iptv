/* Controle parental: esconde o conteudo adulto e pede senha para liberar.
   A senha fica selada (AES-GCM) como as URLs/senhas das listas.
   O desbloqueio vale so para a sessao atual: ao abrir o app de novo, volta a ficar bloqueado. */
(function (g) {
  'use strict';
  var App = g.App;

  /* Termos que identificam conteudo adulto: nome da categoria, do item ou da lista. */
  var ADULT = /(\bxxx\b|\badult[oa]s?\b|\bporn[o0-9a-z]*\b|\ber[oó]tic[oa]s?\b|\bhentai\b|\bonlyfans\b|\bputaria\b|\bsex(o|ual|ualidade)\b|\+18\b|\b18\s*anos\b|\uD83D\uDD1E)/i;

  var unlocked = false;   /* nunca persiste: cada inicio do app comeca bloqueado */

  /* Cache por lista: evita ler o localStorage (e varrer categorias) para cada item. */
  var ctx = { key: null, listAdult: false, cat: {} };

  function catsOf(t) { var c = (App.catalog.data.cats || {})[t]; return c || []; }

  function refreshCtx() {
    /* a lista que manda e a do catalogo em memoria (durante a troca de lista elas podem divergir) */
    var l = App.catalog.listId ? App.lists.get(App.catalog.listId) : null;
    if (!l) l = App.lists.active();
    ctx.key = (l && l.id ? l.id : '-') + '|' + (App.catalog.listId || '-');
    ctx.listAdult = !!(l && ADULT.test(l.name || ''));
    ctx.cat = {};
  }

  function context() {
    if (ctx.key === null) refreshCtx();
    return ctx;
  }

  App.bus.on('catalog', function () { ctx.key = null; });

  function catName(t, id) {
    var a = catsOf(t), i;
    for (i = 0; i < a.length; i++) if (a[i].id === id) return a[i].name;
    return '';
  }

  function isAdultCat(t, id) {
    var c = context(), k = t + '|' + id;
    if (!(k in c.cat)) c.cat[k] = ADULT.test(catName(t, id));
    return c.cat[k];
  }

  function paint() { App.bus.emit('parental', !App.parental.locked()); App.bus.emit('catalog'); }

  /* PIN em PBKDF2-SHA256 (>= 150 mil iteracoes, salt de 16 bytes) para poder
     viajar para a nuvem sem guardar o PIN em texto. Importante: um PIN de 4
     digitos tem 10 mil combinacoes — o hash protege contra leitura casual do
     armazenamento, NAO contra forca bruta. Quem segura o ataque e o limite de
     tentativas e o fato de tudo acontecer no aparelho, nunca no servidor.
     O formato antigo (sl.pinS selado) continua aceito para nao quebrar quem
     ja tinha PIN, e continua sendo gravado para o app da TV. */
  var PIN_ITER = 150000, PIN_SALT = 16;

  function toHex(buf) {
    var a = new Uint8Array(buf), s = '', i;
    for (i = 0; i < a.length; i++) s += (a[i] + 0x100).toString(16).slice(1);
    return s;
  }
  function fromHex(hex) {
    var s = String(hex || ''), out = new Uint8Array(Math.floor(s.length / 2)), i;
    for (i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16) || 0;
    return out;
  }
  function enc(text) { return new TextEncoder().encode(text); }
  function same(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    var diff = 0, i;
    for (i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /* hash em hex, ou '' quando o navegador nao tem WebCrypto (contexto inseguro). */
  function derivePin(pin, saltHex) {
    var subtle = g.crypto && g.crypto.subtle;
    if (!subtle || !saltHex) return Promise.resolve('');
    return subtle.importKey('raw', enc(String(pin)), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) {
        return subtle.deriveBits(
          { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PIN_ITER, hash: 'SHA-256' },
          key, 256
        );
      })
      .then(toHex, function () { return ''; });
  }

  App.parental = {
    LEN: 4,

    /* --- estado --- */
    hasPin: function () { return !!(App.store.get('pinH', '') || App.store.get('pinS', '')); },
    enabled: function () { return !!App.store.get('pinOn', false) && App.parental.hasPin(); },
    unlocked: function () { return unlocked; },
    locked: function () { return App.parental.enabled() && !unlocked; },

    /* --- classificacao --- */
    isAdultText: function (s) { return ADULT.test(String(s == null ? '' : s)); },
    isAdultCat: function (t, id) { return isAdultCat(t, id); },
    isAdult: function (it) {
      if (!it) return false;
      if (ADULT.test(String(it.n || ''))) return true;
      if (it.c && isAdultCat(it.t, it.c)) return true;
      return context().listAdult;
    },
    adultHist: function (h) {
      var it = h && App.catalog.find(h.t, h.id);
      return it ? App.parental.isAdult(it) : (App.parental.isAdultText(h && h.n) || context().listAdult);
    },

    /* --- filtro de exibicao (bloqueado esconde; liberado devolve tudo) --- */
    filter: function (arr) {
      if (!App.parental.locked()) return arr || [];
      return (arr || []).filter(function (it) { return !App.parental.isAdult(it); });
    },
    filterHist: function (arr) {
      if (!App.parental.locked()) return arr || [];
      return (arr || []).filter(function (h) { return !App.parental.adultHist(h); });
    },
    filterCats: function (t) {
      var a = catsOf(t);
      if (!App.parental.locked()) return a;
      return a.filter(function (c) { return !ADULT.test(c.name); });
    },

    /* --- senha --- */
    setPin: function (pin) {
      var salt = new Uint8Array(PIN_SALT), saltHex = '';
      try {
        if (g.crypto && g.crypto.getRandomValues) { g.crypto.getRandomValues(salt); saltHex = toHex(salt); }
      } catch (e) { saltHex = ''; }
      return derivePin(pin, saltHex).then(function (hash) {
        var sealP = App.secrets.seal(String(pin)).then(function (sealed) {
          /* formato antigo: mantem o app da TV funcionando */
          if (sealed) App.store.set('pinS', sealed);
        });
        return sealP.then(function () {
          if (hash && saltHex) {
            App.store.set('pinH', hash);
            App.store.set('pinSalt', saltHex);
          }
          App.store.set('pinOn', true);
          unlocked = false;   /* ja entra bloqueado: e o efeito esperado ao definir a senha */
          paint();
          return true;
        });
      });
    },
    check: function (pin) {
      var hash = App.store.get('pinH', '');
      if (hash) {
        var salt = App.store.get('pinSalt', '');
        if (!salt) return Promise.resolve(false);
        return derivePin(pin, salt).then(function (calc) { return !!calc && same(calc, hash); });
      }
      if (!App.parental.hasPin()) return Promise.resolve(false);
      return App.secrets.open(App.store.get('pinS', '')).then(function (real) { return !!real && real === String(pin); });
    },
    enable: function (on) {
      App.store.set('pinOn', !!on);
      unlocked = !on;
      paint();
    },
    clear: function () {
      App.store.del('pinS'); App.store.del('pinH'); App.store.del('pinSalt');
      App.store.set('pinOn', false); unlocked = true; paint();
    },

    /* --- sessao --- */
    unlock: function () { unlocked = true; paint(); },
    lock: function () { unlocked = false; paint(); },

    /* Pede a senha quando o item e adulto e o bloqueio esta ativo. */
    guard: function (it) {
      if (!App.parental.locked() || !App.parental.isAdult(it)) return Promise.resolve(true);
      return App.ui.pinAsk({
        title: 'Conteúdo adulto',
        msg: 'Digite a senha para liberar o conteúdo adulto.'
      }).then(function (ok) {
        if (ok) App.parental.unlock();
        return ok;
      });
    }
  };
})(window);
