/* Ultimo canal assistido e preferencia "iniciar no ultimo canal" (desligada por padrao).
   Guarda o id estavel do canal + a lista de origem (nunca posicao ou nome) no localStorage
   do app (prefixo sl.), o mesmo mecanismo usado por listas/favoritos/historico. */
(function (g) {
  'use strict';
  var App = g.App;

  var KEY = 'lastCh';        /* { list, t:'live', id, ts } */
  var PREF = 'resumeLast';   /* booleano; ausente = desligado */
  var tentou = false;        /* garante uma unica tentativa de retomada por sessao */

  function activeId() { return App.catalog.listId || (App.lists.active() || {}).id || ''; }

  App.resume = {
    /* Registra o canal que comecou a tocar. So ao vivo. Nao grava se for o mesmo. */
    set: function (it) {
      if (!it || it.t !== 'live' || !it.id) return;
      var cur = App.resume.get(), l = activeId();
      if (cur && cur.id === it.id && cur.list === l) return;
      App.store.set(KEY, { list: l, t: 'live', id: it.id, ts: Date.now() });
      App.bus.emit('resume', { item: it });
    },
    /* Registro salvo (ou null). Nunca e apagado por causa de classificacao adulta. */
    get: function () {
      var r = App.store.get(KEY, null);
      return (r && r.id && r.t === 'live') ? r : null;
    },
    clear: function () { App.store.del(KEY); App.bus.emit('resume', null); },

    /* Preferencia: desligada por padrao */
    enabled: function () { return App.store.get(PREF, false) === true; },
    setEnabled: function (on) { App.store.set(PREF, !!on); App.bus.emit('resume', { enabled: !!on }); },

    /* Canal correspondente no catalogo carregado (id estavel + mesma lista). */
    candidate: function () {
      var r = App.resume.get();
      if (!r) return null;
      if (r.list && r.list !== activeId()) return null;
      return App.catalog.find('live', r.id);
    },

    /* Decisao de retomada, com o motivo (facilita testar e diagnosticar).
       Ordem: preferencia -> registro existe -> canal ainda existe -> nao e adulto. */
    decide: function () {
      if (!App.resume.enabled()) return { ok: false, reason: 'off', item: null };
      var r = App.resume.get();
      if (!r) return { ok: false, reason: 'no-record', item: null };
      var it = App.resume.candidate();
      if (!it) return { ok: false, reason: 'missing', item: it || null };
      /* Regra de seguranca: adulto NUNCA retoma automaticamente (independe do controle parental estar ligado).
         A classificacao usa categoria/lista do item, nao so o nome (App.parental.isAdult). */
      if (App.parental && App.parental.isAdult(it)) return { ok: false, reason: 'adult', item: it };
      return { ok: true, reason: 'ok', item: it };
    },

    /* Chamada uma unica vez na inicializacao: devolve o canal a abrir ou null.
       O flag evita inicializacoes duplicadas do player. */
    startup: function () {
      if (tentou) return null;
      tentou = true;
      var d = App.resume.decide();
      return d.ok ? d.item : null;
    },

    /* usado pelos testes: reinicia o flag de sessao */
    _resetSession: function () { tentou = false; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = App.resume;
})(typeof window !== 'undefined' ? window : global);
