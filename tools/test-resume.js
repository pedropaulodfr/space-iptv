/* Testes do "iniciar no ultimo canal assistido" (roda no PC, com um stub do App).
   Uso: node tools\test-resume.js */
'use strict';

var path = require('path');
var RESUME = path.join(__dirname, '..', 'tv', 'js', 'services', 'resume.js');

var total = 0, falhas = 0;
function ok(cond, nome, extra) {
  total++;
  if (cond) { console.log('  ok      ' + nome); }
  else { falhas++; console.log('  FALHOU  ' + nome + (extra ? '   [' + extra + ']' : '')); }
}

function makeApp() {
  var state = {
    store: {}, listId: 'L1', active: { id: 'L1', name: 'Lista Teste' },
    items: [
      { t: 'live', id: 'ch1', n: 'Canal 1', c: 'cat-geral' },
      { t: 'live', id: 'ch2', n: 'Canal 2', c: 'cat-geral' },
      { t: 'live', id: 'chAdulto', n: 'Canal X', c: 'cat-adulto' },
      { t: 'movie', id: 'mv1', n: 'Filme 1', c: 'cat-filmes' }
    ],
    adults: { chAdulto: true },
    writes: 0, emits: []
  };
  var App = {
    store: {
      get: function (k, d) { return Object.prototype.hasOwnProperty.call(state.store, k) ? JSON.parse(JSON.stringify(state.store[k])) : d; },
      set: function (k, v) { state.writes++; state.store[k] = JSON.parse(JSON.stringify(v)); return true; },
      del: function (k) { delete state.store[k]; }
    },
    lists: { active: function () { return state.active; } },
    catalog: {
      get listId() { return state.listId; },
      find: function (t, id) { return state.items.filter(function (i) { return i.t === t && i.id === id; })[0] || null; },
      items: function (t, c) { return state.items.filter(function (i) { return i.t === t && (!c || i.c === c); }); }
    },
    parental: { isAdult: function (it) { return !!(it && state.adults[it.id]); } },
    bus: { emit: function (ev) { state.emits.push(ev); } }
  };
  return { App: App, state: state };
}

/* recarrega o modulo como se fosse uma nova sessao do app (mesmo armazenamento) */
function load(App) {
  global.App = App;
  delete require.cache[require.resolve(RESUME)];
  return require(RESUME);
}

console.log('\n== padrao de fabrica ==');
var A = makeApp(), state = A.state, R = load(A.App);
ok(R.enabled() === false, 'preferencia desabilitada por padrao');
ok(R.get() === null, 'sem registro no primeiro uso');
ok(R.decide().reason === 'off', 'decide: nao tenta retomar com a preferencia off');
ok(R.startup() === null, 'startup: fluxo padrao');

console.log('\n== registro do ultimo canal ==');
R.set(A.App.catalog.find('live', 'ch1'));
ok(R.get() && R.get().id === 'ch1', 'registra o canal assistido');
ok(R.get().list === 'L1', 'guarda a lista de origem (id estavel, nao nome/posicao)');
var escritas = state.writes;
R.set(A.App.catalog.find('live', 'ch1'));
ok(state.writes === escritas, 'nao regrava o mesmo canal (evita gravacoes desnecessarias)');
R.set(A.App.catalog.find('movie', 'mv1'));
ok(R.get().id === 'ch1', 'filme (VOD) nao sobrescreve o ultimo canal');
R.set(A.App.catalog.find('live', 'ch2'));
ok(R.get().id === 'ch2', 'troca de canal atualiza o registro');
R = load(A.App);
ok(R.get() && R.get().id === 'ch2', 'registro sobrevive ao reinicio do app');

console.log('\n== preferencia habilitada com canal comum ==');
R.setEnabled(true);
R = load(A.App);
ok(R.enabled() === true, 'preferencia persiste entre sessoes');
var d = R.decide();
ok(d.ok === true && d.reason === 'ok' && d.item.id === 'ch2', 'decide: retoma o canal comum');
R._resetSession();
var s1 = R.startup(), s2 = R.startup();
ok(s1 && s1.id === 'ch2', 'startup devolve o canal a abrir');
ok(s2 === null, 'startup nao devolve de novo (evita abrir o player duas vezes)');

console.log('\n== preferencia desabilitada ==');
R.setEnabled(false);
R = load(A.App);
ok(R.decide().reason === 'off', 'decide: fluxo padrao com a preferencia off');
ok(R.startup() === null, 'startup: nao abre nada');

console.log('\n== sem registro salvo ==');
R.clear();
R.setEnabled(true);
R = load(A.App);
ok(R.decide().reason === 'no-record', 'decide: sem registro');
ok(R.startup() === null, 'startup: fluxo padrao');

console.log('\n== canal removido / indisponivel ==');
R.set(A.App.catalog.find('live', 'ch1'));
state.items = state.items.filter(function (i) { return i.id !== 'ch1'; });
R._resetSession();
ok(R.decide().reason === 'missing', 'decide: canal nao existe mais no catalogo');
ok(R.startup() === null, 'startup: fluxo padrao sem erro');
ok(R.get() && R.get().id === 'ch1', 'registro e preservado mesmo com o canal ausente');

console.log('\n== registro de outra lista ==');
R.set(A.App.catalog.find('live', 'ch2'));
state.listId = 'L2'; state.active = { id: 'L2', name: 'Outra lista' };
R._resetSession();
ok(R.decide().reason === 'missing', 'registro de outra lista nao retoma');
ok(R.startup() === null, 'startup: fluxo padrao');
state.listId = 'L1'; state.active = { id: 'L1', name: 'Lista Teste' };

console.log('\n== canal adulto (regra de seguranca) ==');
R.set(A.App.catalog.find('live', 'chAdulto'));
R.setEnabled(true);
R = load(A.App);
var ad = R.decide();
ok(ad.ok === false && ad.reason === 'adult', 'adulto nunca e retomado automaticamente');
ok(R.startup() === null, 'startup: fluxo padrao para o canal adulto');
ok(R.get() && R.get().id === 'chAdulto', 'registro do canal adulto NAO e apagado');

console.log('\n== prioridade: adulto vence a preferencia ==');
var antes = R.enabled();
R._resetSession();
ok(antes === true && R.startup() === null, 'mesmo habilitado, adulto nao toca');

console.log('\n----------------------------------------');
console.log(falhas === 0 ? 'TODOS OS ' + total + ' TESTES PASSARAM' : falhas + ' de ' + total + ' testes falharam');
process.exit(falhas === 0 ? 0 : 1);
