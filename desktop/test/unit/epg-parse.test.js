/* Testes unitários do parser XMLTV incremental (`src/renderer/js/epg/epg-parse.js`).
 *
 * Contrato (CONTRACTS.md §3.5 + combinado com o agente epg):
 *   new Parser({defaultOffsetMin}).feed(chunk) ... .end()
 *     -> {channels:[{id,names,icon}], programmes:[{c,s,e,t,d,cat}],
 *         stats:{duplicates,invalidDates,ignored,truncated}}
 *   parse(texto, opcoes) idem; XMLTV vazio/lixo => lança { code:'invalid' }.
 *   Datas sem offset usam defaultOffsetMin (minutos), dedupe por (canal, inicio)
 *   e por (nome normalizado, inicio).
 *
 * Fixtures em `desktop/test/fixtures/xmltv-*` são do agente epg — apenas leitura.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const util = require('../helpers/util');

const MODULE = util.desktopPath('src', 'renderer', 'js', 'epg', 'epg-parse.js');
const FIX = util.desktopPath('test', 'fixtures');

function read(name) { return fs.readFileSync(path.join(FIX, name), 'utf8'); }
function gzBytes(name) { return fs.readFileSync(path.join(FIX, name)); }

/** Carrega o módulo do zero (o UMD guarda estado em global.App). */
function freshApi() {
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

function parseOk(api, text, opts) {
  try {
    return api.parse(text, opts);
  } catch (e) {
    if (e && e.code === 'invalid') throw new Error('parser devolveu invalid inesperadamente');
    throw e;
  }
}

function expectInvalid(api, text) {
  let caught = null;
  try { api.parse(text); } catch (e) { caught = e; }
  assert.ok(caught, 'esperava lançar {code:invalid} e não lançou');
  assert.equal(caught.code, 'invalid');
}

function titles(res) { return res.programmes.map((p) => p.t); }

/* A suíte roda com App global limpo; a API "principal" é o fallback do Node. */
delete global.App;
const api = freshApi();

test('API UMD é carregável no Node e expõe o contrato', () => {
  assert.equal(typeof api.Parser, 'function');
  assert.equal(typeof api.parse, 'function');
  assert.equal(typeof api.parseDate, 'function');
  assert.equal(typeof api.normName, 'function');
  assert.equal(typeof api.decodeEntities, 'function');
});

test('fixture básica: canais e programas esperados', () => {
  const res = parseOk(api, read('xmltv-basic.xml'));
  assert.equal(res.channels.length, 5);
  assert.equal(res.channels[0].id, 'globo.br');
  assert.deepEqual(res.channels[0].names.slice(), ['Globo', 'Globo HD']);
  assert.equal(res.programmes.length, 9);
  const ts = titles(res);
  assert.ok(ts.includes('Jornal Nacional'));
  assert.ok(!ts.includes('Jornal Nacional (duplicado)'), 'duplicado exato removido');
  assert.ok(!ts.includes('Jornal Nacional (UTC)'), 'mesmo instante UTC removido');
  assert.ok(!ts.includes('Jornal Nacional (nome repetido)'), 'duplicado por nome removido');
  assert.ok(!ts.includes('Start invalido'));
  assert.ok(!ts.includes('Sem canal'));
});

test('entidades XML, entidades HTML tortas e CDATA são decodificadas', () => {
  const res = parseOk(api, read('xmltv-basic.xml'));
  const jn = res.programmes.find((p) => p.t === 'Jornal Nacional');
  assert.ok(jn);
  assert.equal(jn.d, 'Notícias & entrevistas do dia.');
  assert.equal(jn.cat, 'Notícias');
  assert.ok(res.programmes.some((p) => p.t === 'A Praça é Nossa'), 'CDATA preservado');
  const ratinho = res.programmes.find((p) => p.t === 'Programa do Ratinho');
  assert.equal(ratinho.d, 'Silvio & cia — auditório.');
  assert.equal(api.decodeEntities('&amp;&#233;&#x2014;&nbsp;'), '&é— ');
  assert.equal(api.decodeEntities('&amp;'), '&');
});

test('programa sem stop mantém e=0; sobrepostos são mantidos', () => {
  const res = parseOk(api, read('xmltv-basic.xml'));
  const semFim = res.programmes.find((p) => p.t === 'Programa sem fim');
  assert.ok(semFim);
  assert.equal(semFim.e, 0);
  const globo = res.programmes.filter((p) => p.c === 'globo.br');
  assert.equal(globo.length, 4);
  assert.ok(globo.some((p) => p.t === 'Novela das Nove'));
});

test('feed em pedaços arbitrários = resultado do arquivo inteiro', () => {
  const text = read('xmltv-basic.xml');
  const whole = parseOk(api, text);
  for (const size of [1, 2, 7, 13, 64, 1000]) {
    const p = new api.Parser();
    for (let i = 0; i < text.length; i += size) p.feed(text.slice(i, i + size));
    const got = p.end();
    assert.equal(got.channels.length, whole.channels.length, 'canais chunk=' + size);
    assert.equal(got.programmes.length, whole.programmes.length, 'programas chunk=' + size);
    assert.deepEqual(titles(got), titles(whole), 'títulos chunk=' + size);
  }
});

test('chunks que cortam tags, comentários, CDATA e entidades', () => {
  const xml = '<?xml version="1.0"?><tv>' +
    '<channel id="a"><display-name>Canal &amp; A</display-name></channel>' +
    '<!-- comentário > com -->' +
    '<programme start="20261114120000 -0300" stop="20261114130000 -0300" channel="a">' +
    '<title><![CDATA[Título & especial]]></title><desc>a &amp; b</desc></programme></tv>';
  const whole = api.parse(xml);
  for (const size of [1, 3, 5, 9, 17]) {
    const p = new api.Parser();
    for (let i = 0; i < xml.length; i += size) p.feed(xml.slice(i, i + size));
    const got = p.end();
    assert.equal(got.programmes.length, 1, 'chunk=' + size);
    assert.equal(got.programmes[0].t, 'Título & especial');
    assert.equal(got.programmes[0].d, 'a & b');
    assert.deepEqual(got.channels, whole.channels);
  }
});

test('fuso: +0000, +0530, -0300, virada de dia, +1400 e sem segundos', () => {
  const res = parseOk(api, read('xmltv-tz.xml'));
  const by = {};
  for (const p of res.programmes) by[p.t] = p;
  assert.equal(by['UTC meio-dia'].s, Date.UTC(2026, 10, 14, 12, 0, 0));
  assert.equal(by['Índia'].s, Date.UTC(2026, 10, 14, 6, 30, 0));
  assert.equal(by['Brasília'].s, Date.UTC(2026, 10, 14, 15, 0, 0));
  assert.equal(by['Virada'].s, Date.UTC(2026, 10, 15, 2, 30, 0));
  assert.equal(by['Virada'].e, Date.UTC(2026, 10, 15, 3, 30, 0));
  assert.equal(by['Kiritimati'].s, Date.UTC(2026, 10, 13, 10, 0, 0));
  assert.equal(by['Sem segundos'].s, Date.UTC(2026, 10, 15, 8, 30, 0));
});

test('programa sem offset usa defaultOffsetMin (0 padrão, configurável)', () => {
  const res0 = parseOk(api, read('xmltv-tz.xml'));
  const semFuso0 = res0.programmes.find((p) => p.t === 'Sem fuso');
  assert.equal(semFuso0.s, Date.UTC(2026, 10, 14, 16, 0, 0));

  const res1 = parseOk(api, read('xmltv-tz.xml'), { defaultOffsetMin: -180 });
  const semFuso1 = res1.programmes.find((p) => p.t === 'Sem fuso');
  assert.equal(semFuso1.s, Date.UTC(2026, 10, 14, 19, 0, 0));
});

test('parseDate: formatos aceitos e inválidos', () => {
  assert.equal(api.parseDate('20261114180000 +0000'), Date.UTC(2026, 10, 14, 18, 0, 0));
  assert.equal(api.parseDate('20261114180000 -0330'), Date.UTC(2026, 10, 14, 21, 30, 0));
  assert.equal(api.parseDate('202611141800'), Date.UTC(2026, 10, 14, 18, 0, 0));
  assert.equal(api.parseDate('20261114180000+0200'), Date.UTC(2026, 10, 14, 16, 0, 0));
  assert.equal(api.parseDate('20261314180000 +0000'), null);
  assert.equal(api.parseDate('amanhã'), null);
  assert.equal(api.parseDate(''), null);
});

test('nome normalizado: sem acento/caixa/espaço/pontuação', () => {
  assert.equal(api.normName('Época'), 'epoca');
  assert.equal(api.normName('GLOBO  HD'), 'globohd');
  assert.equal(api.normName('A Praça é Nossa'), 'apracaenossa');
  assert.equal(api.normName('ESPN-2 (HD)'), 'espn2hd');
  assert.equal(api.normName(''), '');
});

test('fixture com acentos preserva nomes', () => {
  const res = parseOk(api, read('xmltv-accent.xml'));
  assert.equal(res.channels[0].names[0], 'Época');
  assert.equal(api.normName(res.channels[0].names[0]), 'epoca');
  assert.equal(res.programmes.length, 3);
});

test('XML truncado não explode e devolve o que conseguiu', () => {
  const res = parseOk(api, read('xmltv-truncated.xml'));
  assert.equal(res.channels.length, 5);
  assert.ok(res.programmes.length >= 8, 'programas antes do corte: ' + res.programmes.length);
  assert.equal(typeof res.stats.truncated, 'boolean');
});

test('XMLTV vazio => {code:invalid}', () => {
  expectInvalid(api, read('xmltv-empty.xml'));
});

test('texto que não é XMLTV => {code:invalid}', () => {
  expectInvalid(api, read('xmltv-invalid.xml'));
});

test('gzip real (.xml.gz) descomprime para XMLTV válido', () => {
  const raw = zlib.gunzipSync(gzBytes('xmltv-gzip.xml.gz')).toString('utf8');
  assert.deepEqual(gzBytes('xmltv-gzip.xml.gz').subarray(0, 2), Buffer.from([0x1f, 0x8b]));
  const res = parseOk(api, raw);
  assert.equal(res.channels.length, 2);
  assert.equal(res.programmes.length, 3);
  assert.equal(titles(res)[0], 'Programa Gzip');
});

test('garante que o parser não depende de DOMParser/XMLHttpRequest', () => {
  assert.equal(typeof global.DOMParser, 'undefined');
  assert.equal(typeof global.XMLHttpRequest, 'undefined');
  const res = parseOk(api, '<tv><channel id="x"><display-name>X</display-name></channel></tv>');
  assert.equal(res.channels.length, 1);
});

test('channel id repetido junta nomes sem duplicar canal', () => {
  const xml = '<tv><channel id="a"><display-name>A</display-name></channel>' +
    '<channel id="a"><display-name>A2</display-name></channel>' +
    '<programme start="20261114120000 +0000" stop="20261114130000 +0000" channel="a"><title>X</title></programme></tv>';
  const res = parseOk(api, xml);
  assert.equal(res.channels.length, 1);
  assert.deepEqual(res.channels[0].names.slice(), ['A', 'A2']);
});

test('comentários, DOCTYPE com subset interno e declaração XML são tolerados', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE tv SYSTEM "xmltv.dtd" [ <!ENTITY foo "bar"> ]>\n' +
    '<!-- comentário com > dentro -->\n' +
    '<tv><channel id="a"><display-name>A</display-name></channel>' +
    '<programme start="20261114120000 +0000" stop="20261114130000 +0000" channel="a"><title>Com &amp; sem</title></programme></tv>';
  const res = parseOk(api, xml);
  assert.equal(res.programmes.length, 1);
  assert.equal(res.programmes[0].t, 'Com & sem');
});

test('stats: duplicates/invalidDates/ignored/truncated coerentes', () => {
  const res = parseOk(api, read('xmltv-basic.xml'));
  assert.ok(res.stats.duplicates >= 3, 'duplicatas contabilizadas: ' + res.stats.duplicates);
  assert.ok(res.stats.invalidDates >= 1, 'start inválido contabilizado');
  assert.ok(res.stats.ignored >= 1, 'programa sem canal contabilizado');
  assert.equal(typeof res.stats.truncated, 'boolean');
});

test('App.norm do núcleo é usado quando existe (compatível com o navegador)', () => {
  delete global.App;
  api.normName('Época'); // fallback próprio = 'epoca'
  global.App = { norm: (s) => 'x' + String(s).toLowerCase() };
  try {
    const apiWithApp = freshApi();
    assert.equal(apiWithApp.normName('Época'), 'xpoca');
  } finally {
    delete global.App;
    freshApi();
  }
});
