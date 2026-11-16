/* Testes unitários de `src/main/paths.js` — sanitização, colisão e containment.
 * Contrato: CONTRACTS.md §4 (nome de pasta seguro dentro de downloadsDir).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const util = require('../helpers/util');
const paths = require(util.desktopPath('src', 'main', 'paths.js'));

test('sanitizeName: remove caracteres inválidos do Windows', () => {
  assert.equal(paths.sanitizeName('Filme: Ação? <2026> | "x"'), 'Filme Ação 2026 x');
  assert.equal(paths.sanitizeName('a/b\\c'), 'a b c');
  assert.equal(paths.sanitizeName('a\tb\nc'), 'a b c');
  assert.equal(paths.sanitizeName('ponto. final.'), 'ponto. final');
  assert.equal(paths.sanitizeName('  espaços  '), 'espaços');
});

test('sanitizeName: nomes reservados do Windows ganham prefixo', () => {
  for (const raw of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'lpt9', 'CON.txt']) {
    const out = paths.sanitizeName(raw);
    assert.equal(out.charAt(0), '_', raw + ' -> ' + out);
    assert.ok(/^_(con|prn|aux|nul|com[1-9]|lpt[1-9])/i.test(out), raw + ' -> ' + out);
  }
});

test('sanitizeName: nunca vazio, nunca "." ou "..", respeita o limite', () => {
  assert.equal(paths.sanitizeName(''), paths.FALLBACK_NAME);
  assert.equal(paths.sanitizeName(null), paths.FALLBACK_NAME);
  assert.equal(paths.sanitizeName('...'), paths.FALLBACK_NAME);
  assert.equal(paths.sanitizeName('..'), paths.FALLBACK_NAME);
  assert.equal(paths.sanitizeName('.hidden'), 'hidden');
  const long = paths.sanitizeName('x'.repeat(300));
  assert.ok(long.length <= paths.MAX_NAME, 'tamanho ' + long.length);
  const fallback = paths.sanitizeName('<<<>>>', { fallback: 'Video' });
  assert.equal(fallback, 'Video');
});

test('sanitizeName: mantém acentos (pt-BR) e corta sem partir emoji', () => {
  assert.equal(paths.sanitizeName('Época Ação'), 'Época Ação');
  const s = paths.sanitizeName('🎬'.repeat(100), { max: 10 });
  assert.ok(s.length <= 10);
  // não deve terminar com metade de um par substituto
  assert.notEqual(s.charCodeAt(s.length - 1) >= 0xd800 && s.charCodeAt(s.length - 1) <= 0xdbff, true);
});

test('needsSanitize aponta quando o nome não é seguro', () => {
  assert.equal(paths.needsSanitize('Filme Limpo'), false);
  assert.equal(paths.needsSanitize('Filme: ruim'), true);
  assert.equal(paths.needsSanitize('CON'), true);
});

test('uniqueName: colisão vira " (2)", " (3)" e compara sem caixa', () => {
  assert.equal(paths.uniqueName('Filme', []), 'Filme');
  assert.equal(paths.uniqueName('Filme', ['filme']), 'Filme (2)');
  assert.equal(paths.uniqueName('Filme', ['Filme', 'FILME (2)']), 'Filme (3)');
  const out = paths.uniqueName('x'.repeat(100), []);
  assert.ok(out.length <= paths.MAX_NAME);
});

test('suffixName respeita o limite de 80 caracteres', () => {
  const out = paths.suffixName('y'.repeat(100), 12, paths.MAX_NAME);
  assert.ok(out.length <= paths.MAX_NAME, 'tamanho ' + out.length);
  assert.ok(out.endsWith(' (12)'));
});

test('buildDirName: filme com ano e episódio com temporada/episódio', () => {
  assert.equal(paths.buildDirName({ kind: 'movie', title: 'Matrix', year: 1999 }), 'Matrix (1999)');
  assert.equal(paths.buildDirName({ kind: 'movie', title: 'Sem Ano', year: 'abc' }), 'Sem Ano');
  assert.equal(
    paths.buildDirName({ kind: 'episode', title: 'Série X', season: 1, episode: 2 }),
    'Série X - T01E02'
  );
  assert.equal(
    paths.buildDirName({ kind: 'episode', title: 'Série X', season: 2, episode: 10, episodeTitle: 'Final' }),
    'Série X - T02E10 - Final'
  );
  // colisão de nome usa o "taken"
  assert.equal(
    paths.buildDirName({ kind: 'movie', title: 'Matrix', year: 1999 }, ['Matrix (1999)']),
    'Matrix (1999) (2)'
  );
});

test('isInside/contains: containment lexical', () => {
  const base = path.resolve(util.TMP_ROOT, 'base-fake');
  const inside = path.join(base, 'a', 'b');
  const outside = path.resolve(util.TMP_ROOT, 'outra-fake', 'x');
  assert.equal(paths.isInside(base, inside), true);
  assert.equal(paths.isInside(base, base), false, 'isInside é descendente estrito');
  assert.equal(paths.contains(base, base), true);
  assert.equal(paths.contains(base, inside), true);
  assert.equal(paths.isInside(base, outside), false);
  assert.equal(paths.contains(base, outside), false);
  assert.equal(paths.isInside(base, base + 'x'), false, 'prefixo de string não é containment');
  assert.equal(paths.isInside('', inside), false);
  assert.equal(paths.isInside(base, ''), false);
});

test('normalizeRelPath: aceita caminhos relativos seguros', () => {
  assert.equal(paths.normalizeRelPath('video.mp4'), 'video.mp4');
  assert.equal(paths.normalizeRelPath('segments/seg0.ts'), 'segments/seg0.ts');
  assert.equal(paths.normalizeRelPath('a/b/c/init.mp4'), 'a/b/c/init.mp4');
  assert.equal(paths.isSafeRelPath('playlist.m3u8'), true);
});

test('normalizeRelPath: recusa traversal, absolutos, unidade, volta e caracteres ruins', () => {
  const bad = [
    '../x', 'a/../../b', '..', '.', '/etc/passwd', 'C:/x', 'C:x', 'a\\b',
    'a//b', 'a/./b', 'a/b.', 'a/b ', 'a/b:stream', 'a/<b>.ts', 'a/b?x.ts',
    'a/|.ts', 'a/\u0000b.ts', 'x'.repeat(200) + '.ts'
  ];
  for (const rel of bad) {
    assert.throws(() => paths.normalizeRelPath(rel), (e) => e && (e.code === 'PATH_TRAVERSAL' || e.code === 'PATH_INVALID'), 'deveria recusar ' + JSON.stringify(rel));
    assert.equal(paths.isSafeRelPath(rel), false, 'isSafeRelPath ' + JSON.stringify(rel));
  }
  assert.throws(() => paths.normalizeRelPath(''), (e) => e.code === 'PATH_INVALID');
  assert.throws(() => paths.normalizeRelPath(null), (e) => e.code === 'PATH_INVALID');
});

test('resolveInside: resolve e nunca sai da base', (t) => {
  const base = util.makeTmp(t, 'paths-resolve');
  const target = paths.resolveInside(base, 'segments/seg0.ts');
  assert.equal(target, path.join(base, 'segments', 'seg0.ts'));
  assert.throws(() => paths.resolveInside(base, '../fora.ts'), (e) => e.code === 'PATH_TRAVERSAL');
  assert.throws(() => paths.resolveInside('', 'a.ts'), (e) => e.code === 'PATH_INVALID');
});

test('assertRealInside: valida realpath e recusa alvo fora da base', async (t) => {
  const base = util.makeTmp(t, 'paths-real');
  const sub = path.join(base, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, 'video.mp4');
  fs.writeFileSync(file, 'x');

  assert.equal(await paths.assertRealInside(base, file), fs.realpathSync(file));
  await assert.rejects(paths.assertRealInside(base, path.join(base, 'nao-existe.mp4')), (e) => e.code === 'PATH_NOT_FOUND');

  const other = util.makeTmp(t, 'paths-fora');
  const outside = path.join(other, 'fora.mp4');
  fs.writeFileSync(outside, 'x');
  await assert.rejects(paths.assertRealInside(base, outside), (e) => e.code === 'PATH_TRAVERSAL');
});

test('itemDir: nome precisa ser exatamente o sanitizado', (t) => {
  const base = util.makeTmp(t, 'paths-item');
  assert.equal(paths.itemDir(base, 'Filme (2026)'), path.join(base, 'Filme (2026)'));
  assert.throws(() => paths.itemDir(base, '../x'), (e) => e.code === 'PATH_INVALID' || e.code === 'PATH_TRAVERSAL');
  assert.throws(() => paths.itemDir(base, 'a/b'), (e) => e.code === 'PATH_INVALID' || e.code === 'PATH_TRAVERSAL');
  assert.throws(() => paths.itemDir(base, 'CON'), (e) => e.code === 'PATH_INVALID');
});

test('ensureDir cria recursivamente e devolve caminho absoluto', async (t) => {
  const base = util.makeTmp(t, 'paths-ensure');
  const dir = path.join(base, 'a', 'b', 'c');
  const out = await paths.ensureDir(dir);
  assert.equal(out, path.resolve(dir));
  assert.equal(fs.statSync(dir).isDirectory(), true);
  await assert.rejects(paths.ensureDir(''), (e) => e.code === 'PATH_INVALID');
});

test('freeBytes devolve número ou null (nunca quebra)', async (t) => {
  const base = util.makeTmp(t, 'paths-free');
  const n = await paths.freeBytes(base);
  assert.ok(n === null || (typeof n === 'number' && n >= 0), 'freeBytes=' + n);
  await assert.rejects(paths.freeBytes(path.join(base, 'nao-existe')), (e) => e.code === 'ENOENT');
});

test('formatBytes formata em pt-BR', () => {
  assert.equal(paths.formatBytes(0), '0 B');
  assert.equal(paths.formatBytes(1536), '1,5 KB');
  assert.equal(paths.formatBytes(-1), '—');
  assert.equal(paths.formatBytes('abc'), '—');
});

test('redactUrl nunca devolve credenciais nem query', () => {
  const out = paths.redactUrl('http://user:senha@example.com:8080/live/u/p/1.ts?token=abc');
  assert.equal(out, 'http://example.com:8080/...');
  assert.ok(out.indexOf('senha') < 0 && out.indexOf('token') < 0 && out.indexOf('abc') < 0);
  assert.equal(paths.redactUrl('não é url'), '(url inválida)');
});

test('extOf: extensão em minúsculas, sem query/hash', () => {
  assert.equal(paths.extOf('video.MP4'), 'mp4');
  assert.equal(paths.extOf('a/b.ts?x=1'), 'ts');
  assert.equal(paths.extOf('playlist.m3u8#x'), 'm3u8');
  assert.equal(paths.extOf('sem_extensao'), '');
  assert.equal(paths.extOf(null), '');
});

test('pad2: sempre 2 dígitos e mínimo 1', () => {
  assert.equal(paths.pad2(1), '01');
  assert.equal(paths.pad2(10), '10');
  assert.equal(paths.pad2(0), '01');
  assert.equal(paths.pad2('7'), '07');
});
