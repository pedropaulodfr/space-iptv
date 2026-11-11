/* Testes do monitor de saude dos canais (roda no PC, com stubs do App).
   Uso: node tools\test-health.js */
'use strict';

global.window = global;   /* health.js termina com })(window); */

var total = 0, falhas = 0;
function ok(cond, nome, extra) {
  total++;
  if (cond) console.log('  ok      ' + nome);
  else { falhas++; console.log('  FALHOU  ' + nome + (extra ? '   [' + extra + ']' : '')); }
}
function eq(a, b, nome) { ok(a === b, nome, 'recebido ' + JSON.stringify(a) + ' esperado ' + JSON.stringify(b)); }

/* ---------- ambiente falso ---------- */
var calls = { probes: [], active: 0, maxActive: 0 };
var state = { script: null, emits: [], playerTouched: 0 };
var storeData = {};   /* "localStorage" falso, para testar persistencia da preferencia */

var App = {
  isOnline: function () { return true; },
  store: {
    get: function (k, d) { return Object.prototype.hasOwnProperty.call(storeData, k) ? JSON.parse(JSON.stringify(storeData[k])) : d; },
    set: function (k, v) { storeData[k] = JSON.parse(JSON.stringify(v)); return true; },
    del: function (k) { delete storeData[k]; }
  },
  lists: {
    active: function () { return { id: 'L1', name: 'Lista Teste', type: 'm3u' }; },
    get: function () { return { id: 'L1' }; }
  },
  catalog: {
    listId: 'L1',
    find: function () { return null; },
    urls: function (item) { return Promise.resolve(['http://srv.test/' + item.id]); }
  },
  http: {
    probe: function (url) {
      calls.probes.push(url);
      calls.active++;
      if (calls.active > calls.maxActive) calls.maxActive = calls.active;
      var spec = (state.script && state.script(url)) || { ok: true, kind: 'ts', ttfb: 100 };
      var settle = null, settled = false;
      function finish(r) {
        if (settled) return;
        settled = true;
        calls.active--;
        var o = { status: 200 }, k;
        for (k in r) o[k] = r[k];
        settle(o);
      }
      var p = new Promise(function (res) {
        settle = res;
        setTimeout(function () { finish(spec); }, spec.delay == null ? 10 : spec.delay);
      });
      p.abort = function () { finish({ ok: false, code: 'abort', status: 0, inconclusive: true }); };
      return p;
    }
  },
  bus: {
    on: function () {}, off: function () {},
    emit: function (ev, d) { if (ev === 'health') state.emits.push(d); }
  },
  fmtDate: function (t) { return new Date(t).toISOString(); }
};
global.App = App;

require('../tv/js/services/health.js');
var health = App.health;   /* health.js se pendura em App, nao em module.exports */

function item(id, t) { return { id: id, t: t || 'live', n: 'Canal ' + id }; }
function fresh(extra) {
  health.reset();
  health.setEnabled(true);
  health.configure({
    concurrency: 3, timeout: 1000, retry: 0, cache: 60000, green: 1200, yellow: 3000,
    playbackWindow: 600000, playbackSlow: 3000, hlsSegment: true, maxQueue: 80, maxRecords: 6000
  });
  if (extra) health.configure(extra);
  calls.probes.length = 0;
  calls.maxActive = 0;
  state.emits.length = 0;
  state.script = null;
}

/* recarrega o modulo como se o app tivesse sido reaberto (mesmo armazenamento) */
function loadFresh() {
  delete require.cache[require.resolve('../tv/js/services/health.js')];
  require('../tv/js/services/health.js');
  return App.health;
}

var passos = [];
function proximo() { var f = passos.shift(); if (f) f(); }

/* ---------- 1. identificacao dos canais ---------- */
passos.push(function () {
  console.log('\n== 1. identificacao dos canais da categoria ==');
  fresh();
  var add = health.observe({ id: 'L1' }, [item('a'), item('a'), item('b'), { id: 'm1', t: 'movie' }, null]);
  eq(add, 2, 'so canais ao vivo e sem duplicar');
  health.idle().then(proximo);
});

/* ---------- 2/3. disponibilidade e tempo de resposta ---------- */
passos.push(function () {
  console.log('\n== 2/3. disponibilidade e tempo de resposta ==');
  fresh();
  state.script = function (url) {
    if (url.indexOf('/a') >= 0) return { ok: true, kind: 'ts', ttfb: 300 };
    if (url.indexOf('/b') >= 0) return { ok: true, kind: 'ts', ttfb: 2000 };
    return { ok: true, kind: 'ts', ttfb: 6000 };
  };
  health.observe('L1', [item('a'), item('b'), item('c')]);
  health.idle().then(function () {
    eq(health.state(item('a')).state, 'green', 'resposta rapida -> verde');
    eq(health.state(item('b')).state, 'yellow', 'resposta moderada -> amarelo');
    eq(health.state(item('c')).state, 'orange', 'resposta lenta -> laranja');
    eq(health.state(item('a')).ttfb, 300, 'tempo de resposta em ms gravado');
    proximo();
  });
});

/* ---------- 2b. stream TS reconhecido (regressao do bug "nao parece stream") ---------- */
passos.push(function () {
  console.log('\n== 2b. stream TS/video nao pode virar "nao parece stream" ==');
  fresh();
  state.script = function (url) {
    if (url.indexOf('/v') >= 0) return { ok: true, kind: 'video', ttfb: 900 };   /* cabecalho video/mp2t, corpo ainda vazio */
    if (url.indexOf('/h') >= 0) return { ok: true, kind: 'html', status: 200 };  /* pagina HTML no lugar do video */
    return { ok: false, code: 'http', status: 404, kind: 'html' };
  };
  health.observe('L1', [item('v'), item('h'), item('n')]);
  health.idle().then(function () {
    eq(health.state(item('v')).state, 'green', 'kind video com resposta rapida -> saudavel');
    eq(health.state(item('h')).state, 'orange', 'HTML no lugar do video -> instavel');
    eq(health.state(item('n')).state, 'orange', 'HTTP 404 -> instavel');
    ok(/404/.test(health.state(item('n')).detail), 'detalhe do 404 correto');
    proximo();
  });
});

/* ---------- 4/5/6/7. falhas, timeout, HTTP e CORS ---------- */
passos.push(function () {
  console.log('\n== 4/5/6. falha isolada, timeout e erro HTTP ==');
  fresh();
  state.script = function (url) {
    if (url.indexOf('/a') >= 0) return { ok: false, code: 'network', status: 0 };
    if (url.indexOf('/b') >= 0) return { ok: false, code: 'timeout', status: 0 };
    return { ok: false, code: 'http', status: 403 };
  };
  health.observe('L1', [item('a'), item('b'), item('c')]);
  health.idle().then(function () {
    eq(health.state(item('a')).state, 'orange', 'uma falha de rede NAO vira offline');
    eq(health.state(item('b')).state, 'orange', 'timeout -> instavel');
    eq(health.state(item('c')).state, 'orange', 'HTTP 403 -> instavel');
    ok(/403/.test(health.state(item('c')).detail), 'detalhe cita o codigo HTTP');
    proximo();
  });
});

passos.push(function () {
  console.log('\n== falha repetida vira offline ==');
  fresh({ cache: 0 });
  state.script = function () { return { ok: false, code: 'network', status: 0 }; };
  health.observe('L1', [item('a')]);
  health.idle().then(function () {
    var primeira = health.state(item('a')).state;
    health.observe('L1', [item('a')]);
    health.idle().then(function () {
      eq(primeira, 'orange', '1a falha: instavel');
      eq(health.state(item('a')).state, 'red', '2a falha seguida: offline');
      proximo();
    });
  });
});

passos.push(function () {
  console.log('\n== 7. bloqueio de acesso (CORS) ==');
  fresh();
  state.script = function () { return { ok: false, code: 'opaque', status: 0, inconclusive: true }; };
  health.observe('L1', [item('a')]);
  health.idle().then(function () {
    eq(health.state(item('a')).state, 'gray', 'CORS/bloqueio -> nao verificado');
    eq(health.state(item('a')).failures, 0, 'CORS nao conta como falha');
    proximo();
  });
});

/* ---------- 8/9. fila e concorrencia ---------- */
passos.push(function () {
  console.log('\n== 8/9. fila e limite de verificacoes simultaneas ==');
  fresh();
  state.script = function () { return { ok: true, kind: 'ts', ttfb: 100, delay: 40 }; };
  var lote = [], i;
  for (i = 0; i < 12; i++) lote.push(item('c' + i));
  health.observe('L1', lote);
  health.idle().then(function () {
    ok(calls.maxActive <= 3, 'no maximo 3 em paralelo', 'max=' + calls.maxActive);
    eq(calls.probes.length, 12, 'todos os 12 canais foram verificados');
    proximo();
  });
});

/* ---------- 10. cache ---------- */
passos.push(function () {
  console.log('\n== 10. cache ==');
  fresh();
  state.script = function () { return { ok: true, kind: 'ts', ttfb: 100 }; };
  health.observe('L1', [item('a')]);
  health.idle().then(function () {
    var antes = calls.probes.length;
    health.observe('L1', [item('a')]);
    health.idle().then(function () {
      eq(calls.probes.length, antes, 'resultado recente nao e reverificado');
      health.configure({ cache: 0 });
      health.observe('L1', [item('a')]);
      health.idle().then(function () {
        eq(calls.probes.length, antes + 1, 'cache expirado verifica de novo');
        proximo();
      });
    });
  });
});

/* ---------- 11. cancelamento ---------- */
passos.push(function () {
  console.log('\n== 11. cancelamento ao trocar de categoria ==');
  fresh();
  state.script = function () { return { ok: true, kind: 'ts', ttfb: 100, delay: 120 }; };
  health.observe('L1', [item('x1'), item('x2'), item('x3')]);
  health.cancel();
  health.idle().then(function () {
    eq(health.state(item('x1')).checkedAt, 0, 'cancelado nao grava resultado');
    eq(state.emits.length, 0, 'nenhum evento de saude apos cancelar');
    proximo();
  });
});

/* ---------- 12. indicador visual ---------- */
passos.push(function () {
  console.log('\n== 12. indicador visual ==');
  fresh();
  state.script = function () { return { ok: true, kind: 'ts', ttfb: 100 }; };
  health.observe('L1', [item('a')]);
  health.idle().then(function () {
    var dot = { className: '', title: '', attrs: {}, setAttribute: function (k, v) { this.attrs[k] = v; } };
    health.paint(dot, item('a'));
    ok(/hdot/.test(dot.className) && /green/.test(dot.className), 'paint aplica classe do estado', dot.className);
    eq(dot.attrs['data-state'], 'green', 'paint expoe data-state');
    ok(/Saud/.test(dot.title), 'paint monta o texto explicativo');
    proximo();
  });
});

/* ---------- 13. player ---------- */
passos.push(function () {
  console.log('\n== 13. integracao com o player ==');
  fresh({ cache: 0 });
  health.playback(item('p'), true, false);
  eq(health.state(item('p')).state, 'green', 'reproducao OK -> saudavel');
  ok(/Reprodu/.test(health.state(item('p')).detail), 'detalhe indica reproducao confirmada');
  health.playback(item('q'), false);
  eq(health.state(item('q')).state, 'orange', '1a falha do player -> instavel');
  health.playback(item('q'), false);
  eq(health.state(item('q')).state, 'red', '2a falha do player -> offline');
  ok(state.emits.length >= 3, 'eventos de saude emitidos');
  eq(state.playerTouched, 0, 'o monitor nunca abre o player nem o AVPlay');
  proximo();
});

/* ---------- 14. pausa/retomada ---------- */
passos.push(function () {
  console.log('\n== 14. pausa e retomada (nao interfere na reproducao) ==');
  fresh();
  state.script = function () { return { ok: true, kind: 'ts', ttfb: 100 }; };
  health.pause();
  health.observe('L1', [item('a')]);
  eq(calls.probes.length, 0, 'pausado nao dispara verificacao');
  health.resume();
  health.idle().then(function () {
    eq(calls.probes.length, 1, 'resume processa a fila');
    proximo();
  });
});

/* ---------- 15. HLS ---------- */
passos.push(function () {
  console.log('\n== 15. HLS: manifesto + segmento ==');
  fresh();
  state.script = function (url) {
    if (/seg1\.ts/.test(url)) return { ok: true, kind: 'ts', ttfb: 150 };          /* segmento */
    return { ok: true, kind: 'hls', ttfb: 200, text: '#EXTM3U\n#EXTINF:-1,\nseg1.ts\n' }; /* manifesto */
  };
  health.observe('L1', [item('h')]);
  health.idle().then(function () {
    eq(health.state(item('h')).state, 'green', 'manifesto + segmento OK -> saudavel');
    ok(calls.probes.length >= 2, 'o segmento do manifesto foi verificado', calls.probes.join(' , '));

    fresh();
    state.script = function (url) {
      if (/seg1\.ts/.test(url)) return { ok: false, code: 'network', status: 0 };   /* segmento falha */
      return { ok: true, kind: 'hls', ttfb: 200, text: '#EXTM3U\n#EXTINF:-1,\nseg1.ts\n' };
    };
    health.observe('L1', [item('h')]);
    health.idle().then(function () {
      eq(health.state(item('h')).state, 'orange', 'segmento falhou -> instavel');
      ok(/segmento/.test(health.state(item('h')).detail), 'detalhe cita o segmento');

      proximo();
    });
  });
});

/* ---------- 16. interruptor: padrao e persistencia ---------- */
passos.push(function () {
  console.log('\n== 16. interruptor: ligado por padrao e persistencia ==');
  delete storeData.healthOn;                              /* instalacao nova: chave ausente */
  health = loadFresh();
  eq(health.enabled(), true, 'sem preferencia salva = ligado (padrao)');
  eq(health.stats().enabled, true, 'stats expoe o estado atual');

  health.setEnabled(false);
  eq(health.enabled(), false, 'setEnabled(false) desliga na hora');
  eq(storeData.healthOn, false, 'preferencia gravada no armazenamento');
  health = loadFresh();
  eq(health.enabled(), false, 'continua desligado depois de reabrir o app');
  eq(health.stats().enabled, false, 'stats acompanha a preferencia');
  proximo();
});

/* ---------- 17. desligado nao inicia verificacoes ---------- */
passos.push(function () {
  console.log('\n== 17. desligado nao inicia verificacoes ==');
  fresh();
  health.setEnabled(false);
  state.script = function () { return { ok: true, kind: 'ts', ttfb: 100 }; };
  eq(health.observe('L1', [item('a'), item('b')]), 0, 'observe nao enfileira com o monitor desligado');
  health.idle().then(function () {
    eq(calls.probes.length, 0, 'nenhuma requisicao em segundo plano');
    eq(health.stats().queued, 0, 'fila vazia');
    proximo();
  });
});

/* ---------- 18. desligar cancela pendentes ---------- */
passos.push(function () {
  console.log('\n== 18. desligar interrompe verificacoes pendentes ==');
  fresh();
  state.script = function () { return { ok: true, kind: 'ts', ttfb: 100, delay: 120 }; };
  health.observe('L1', [item('x1'), item('x2'), item('x3')]);
  health.setEnabled(false);
  health.idle().then(function () {
    eq(health.state(item('x1')).checkedAt, 0, 'resultado da verificacao cancelada nao e gravado');
    eq(state.emits.length, 0, 'nenhum evento de saude depois de desligar');
    eq(health.stats().queued, 0, 'fila limpa ao desligar');
    proximo();
  });
});

/* ---------- 19. religar respeita o cache ---------- */
passos.push(function () {
  console.log('\n== 19. religar retoma respeitando o cache ==');
  fresh();
  state.script = function () { return { ok: true, kind: 'ts', ttfb: 200 }; };
  health.observe('L1', [item('k1')]);
  health.idle().then(function () {
    var antes = calls.probes.length;
    eq(antes, 1, 'verificou uma vez');
    health.setEnabled(false);
    health.setEnabled(true);
    health.observe('L1', [item('k1')]);
    health.idle().then(function () {
      eq(calls.probes.length, antes, 'cache valido evita reverificar ao religar');
      eq(health.state(item('k1')).state, 'green', 'resultado anterior continua valido');
      health.setEnabled(false);
      health.setEnabled(true);
      health.observe('L1', [item('k1')]);
      health.idle().then(function () {
        eq(calls.probes.length, antes, 'ligar/desligar repetido nao duplica requisicoes');
        eq(health.stats().queued, 0, 'sem fila duplicada');
        proximo();
      });
    });
  });
});

/* ---------- extra. estatisticas ---------- */
passos.push(function () {
  console.log('\n== extra. estatisticas ==');
  var st = health.stats();
  ok(st.records >= 1, 'stats conta registros');
  ok(typeof st.queued === 'number' && typeof st.inflight === 'number', 'stats traz fila e em execucao');

  console.log('\n----------------------------------------');
  console.log(falhas === 0 ? 'TODOS OS ' + total + ' TESTES PASSARAM' : falhas + ' de ' + total + ' testes falharam');
  process.exit(falhas === 0 ? 0 : 1);
});

proximo();
