/* Testes unitários de `src/main/manifest.js` — JSON atômico, índice da biblioteca,
 * tolerância a corrupção e remoção gerenciada (containment).
 * Contrato: CONTRACTS.md §4.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const util = require('../helpers/util');
const manifest = require(util.desktopPath('src', 'main', 'manifest.js'));
const paths = require(util.desktopPath('src', 'main', 'paths.js'));

const ID = 'a1b2c3d4';

function baseManifest(over) {
  return Object.assign({
    version: 1,
    id: ID,
    kind: 'movie',
    title: 'Filme de Teste',
    subtitle: 'Legendado',
    poster: 'https://example.invalid/poster.jpg',
    listId: 'lista-1',
    itemId: 'item-1',
    createdAt: 1763150000000,
    completedAt: 1763150100000,
    durationSec: 5400,
    engine: 'mp4',
    files: [
      { path: 'video.mp4', size: 1024 },
      { path: 'playlist.m3u8', size: 256 }
    ],
    playlist: { master: '', variant: '' },
    sizeBytes: 1280,
    offlineUrl: '/offline/' + ID + '/video.mp4',
    status: 'done'
  }, over || {});
}

test('constantes do layout offline', () => {
  assert.equal(manifest.VERSION, 1);
  assert.equal(manifest.INDEX_DIR, '.space-iptv');
  assert.equal(manifest.INDEX_FILE, 'index.json');
  assert.equal(manifest.INDEX_BAK, 'index.json.bak');
  assert.equal(manifest.MANIFEST_FILE, 'manifest.json');
  assert.deepEqual(manifest.KINDS, ['movie', 'episode']);
  assert.deepEqual(manifest.ENGINES, ['mp4', 'hls']);
  assert.ok(manifest.STATUSES.includes('done'));
  assert.equal(manifest.indexPath('C:/dl'), path.join('C:/dl', '.space-iptv', 'index.json'));
  assert.equal(manifest.manifestPath('C:/dl/x'), path.join('C:/dl/x', 'manifest.json'));
});

test('normalizeManifest: válido preserva campos e força drm "none"', () => {
  const out = manifest.normalizeManifest(baseManifest({ drm: 'widevine', unknown: 'x' }));
  assert.equal(out.id, ID);
  assert.equal(out.kind, 'movie');
  assert.equal(out.title, 'Filme de Teste');
  assert.equal(out.drm, 'none', 'drm sempre none (DRM é recusado antes)');
  assert.equal(out.status, 'done');
  assert.equal(out.sizeBytes, 1280);
  assert.equal(out.files.length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'unknown'), false);
});

test('normalizeManifest: descarta arquivos inválidos/duplicados e sha inválido', () => {
  const out = manifest.normalizeManifest(baseManifest({
    files: [
      { path: 'video.mp4', size: 10 },
      { path: 'video.mp4', size: 10 },
      { path: '../fora.mp4', size: 99 },
      { path: 'a/b.ts', size: 5, sha256: 'zzz' },
      { path: 'a/b.ts', size: 5 },
      { path: '', size: 1 },
      null
    ],
    sizeBytes: 0
  }));
  assert.deepEqual(out.files.map((f) => f.path), ['video.mp4', 'a/b.ts']);
  assert.equal(Object.prototype.hasOwnProperty.call(out.files[1], 'sha256'), false, 'sha inválido removido');
  assert.ok(out.sizeBytes >= 15, 'sizeBytes nunca menor que a soma: ' + out.sizeBytes);
});

test('normalizeManifest: inválidos viram null', () => {
  for (const raw of [null, undefined, [], 'x', {}, { id: 'curto' }, { id: ID, kind: 'outro', title: 'x' }, { id: ID, kind: 'movie' }]) {
    assert.equal(manifest.normalizeManifest(raw), null, JSON.stringify(raw));
  }
});

test('writeManifest/readManifest: roundtrip atômico', async (t) => {
  const dir = util.makeTmp(t, 'manifest-roundtrip');
  const itemDir = path.join(dir, 'Filme');
  const written = await manifest.writeManifest(itemDir, baseManifest());
  assert.equal(written.id, ID);
  const read = await manifest.readManifest(itemDir);
  assert.equal(read.id, ID);
  assert.deepEqual(read.files, written.files);
  const leftovers = fs.readdirSync(itemDir).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'nenhum .tmp pode sobrar');
});

test('writeManifest: manifesto inválido lança e não grava', async (t) => {
  const dir = util.makeTmp(t, 'manifest-invalid');
  const itemDir = path.join(dir, 'item');
  await assert.rejects(manifest.writeManifest(itemDir, { id: 'x' }));
  assert.equal(fs.existsSync(path.join(itemDir, 'manifest.json')), false);
});

test('readManifest: corrupção é tolerada (null, sem exceção)', async (t) => {
  const dir = util.makeTmp(t, 'manifest-corrupt');
  const itemDir = path.join(dir, 'item');
  fs.mkdirSync(itemDir, { recursive: true });
  fs.writeFileSync(path.join(itemDir, 'manifest.json'), '{ quebrado', 'utf8');
  assert.equal(await manifest.readManifest(itemDir), null);
  fs.writeFileSync(path.join(itemDir, 'manifest.json'), '', 'utf8');
  assert.equal(await manifest.readManifest(itemDir), null);
  assert.equal(await manifest.readManifest(path.join(dir, 'nao-existe')), null);
});

test('readJsonSafe: tolera BOM, arquivo grande e ausente', async (t) => {
  const dir = util.makeTmp(t, 'manifest-json');
  const file = path.join(dir, 'a.json');
  fs.writeFileSync(file, '\uFEFF{"ok":1}', 'utf8');
  assert.deepEqual(await manifest.readJsonSafe(file), { ok: 1 });
  assert.equal(await manifest.readJsonSafe(path.join(dir, 'nenhum.json')), null);
  assert.equal(await manifest.readJsonSafe(file, { maxBytes: 2 }), null);
});

test('writeFileAtomic: cria pastas, grava e lê de volta', async (t) => {
  const dir = util.makeTmp(t, 'manifest-atomic');
  const file = path.join(dir, 'sub', 'dados.bin');
  await manifest.writeFileAtomic(file, Buffer.from('conteúdo', 'utf8'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'conteúdo');
});

test('normalizeIndex: descarta entradas quebradas e ids duplicados', () => {
  const index = manifest.normalizeIndex({
    items: [
      { id: ID, dirName: 'Item', status: 'done', progress: 2, kind: 'movie' },
      { id: ID, dirName: 'Outro', status: 'done' },
      { id: 'b1b2c3d4', dirName: '../fora', status: 'done' },
      { id: 'c1c2c3d4', dirName: 'Sem status' },
      null
    ]
  });
  assert.equal(index.items.length, 2);
  assert.equal(index.items[0].id, ID);
  assert.equal(index.items[0].progress, 1, 'progress é clampado em [0,1]');
  assert.equal(index.items[1].id, 'c1c2c3d4');
  assert.equal(index.items[1].status, 'error', 'status inválido vira error');
  assert.equal(manifest.normalizeIndex(null), null);
  assert.equal(manifest.normalizeIndex({ items: 'x' }), null);
});

test('indexEntryFromManifest: status/progresso vindos do estado corrente', () => {
  const entry = manifest.indexEntryFromManifest(baseManifest(), 'Filme de Teste', {
    status: 'paused', progress: 0.5, bytes: 100, totalBytes: 200
  });
  assert.equal(entry.id, ID);
  assert.equal(entry.dirName, 'Filme de Teste');
  assert.equal(entry.status, 'paused');
  assert.equal(entry.progress, 0.5);
  assert.equal(entry.bytes, 100);
  assert.equal(entry.totalBytes, 200);
});

test('saveIndex/loadIndex: grava, lê e cria backup da versão anterior', async (t) => {
  const dir = util.makeTmp(t, 'manifest-index');
  const index = { version: 1, updatedAt: 0, items: [{ id: ID, dirName: 'Item', status: 'done', title: 'T', kind: 'movie', createdAt: 1, progress: 1 }] };

  const saved = await manifest.saveIndex(dir, index);
  assert.ok(saved.updatedAt > 0);
  const loaded = await manifest.loadIndex(dir);
  assert.equal(loaded.source, 'main');
  assert.equal(loaded.corrupt, false);
  assert.equal(loaded.index.items.length, 1);

  // segunda gravação cria .bak com a versão anterior
  index.items.push({ id: 'b1b2c3d4', dirName: 'Item 2', status: 'done', title: 'T2', kind: 'movie', createdAt: 2, progress: 1 });
  await manifest.saveIndex(dir, index);
  assert.equal(fs.existsSync(manifest.backupIndexPath(dir)), true);
  const loaded2 = await manifest.loadIndex(dir);
  assert.equal(loaded2.index.items.length, 2);
});

test('loadIndex: índice corrompido cai para o .bak', async (t) => {
  const dir = util.makeTmp(t, 'manifest-bak');
  const index = { version: 1, updatedAt: 0, items: [{ id: ID, dirName: 'Item', status: 'done', title: 'T', kind: 'movie', createdAt: 1, progress: 1 }] };
  await manifest.saveIndex(dir, index);
  await manifest.saveIndex(dir, index); // gera .bak
  fs.writeFileSync(manifest.indexPath(dir), '{ corrompido', 'utf8');
  const loaded = await manifest.loadIndex(dir);
  assert.equal(loaded.source, 'backup');
  assert.equal(loaded.corrupt, true);
  assert.equal(loaded.index.items.length, 1);
});

test('loadIndex: sem índice, reconstrói pelos manifestos das pastas', async (t) => {
  const dir = util.makeTmp(t, 'manifest-rebuild');
  await manifest.writeManifest(path.join(dir, 'Filme A'), baseManifest());
  await manifest.writeManifest(path.join(dir, 'Filme B'), baseManifest({ id: 'b1b2c3d4', title: 'Filme B' }));
  // pasta com manifesto corrompido não pode derrubar a reconstrução
  fs.mkdirSync(path.join(dir, 'Quebrado'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Quebrado', 'manifest.json'), 'nope', 'utf8');
  fs.mkdirSync(path.join(dir, '.space-iptv'), { recursive: true });

  const loaded = await manifest.loadIndex(dir);
  assert.equal(loaded.source, 'rebuilt');
  assert.equal(loaded.index.items.length, 2);
  const titles = loaded.index.items.map((i) => i.title).sort();
  assert.deepEqual(titles, ['Filme B', 'Filme de Teste']);

  // loadIndex não grava; quem persiste é o saveIndex/createStore
  await manifest.saveIndex(dir, loaded.index);
  const loadedAgain = await manifest.loadIndex(dir);
  assert.equal(loadedAgain.source, 'main', 'reconstrução foi persistida');
});

test('loadIndex: índice inexistente e sem itens => empty', async (t) => {
  const dir = util.makeTmp(t, 'manifest-empty');
  const loaded = await manifest.loadIndex(dir);
  assert.equal(loaded.source, 'empty');
  assert.deepEqual(loaded.index.items, []);
});

test('createStore: read/update serializados e invalidate', async (t) => {
  const dir = util.makeTmp(t, 'manifest-store');
  const store = manifest.createStore(dir);

  const empty = await store.read();
  assert.deepEqual(empty.items, []);

  await store.update((index) => {
    index.items.push({ id: ID, dirName: 'Filme', title: 'Filme', kind: 'movie', status: 'done', progress: 1, createdAt: 1 });
    return 'ok';
  });
  assert.equal((await store.read()).items.length, 1);

  // dois updates concorrentes: o segundo vê o resultado do primeiro
  await Promise.all([
    store.update((index) => { index.items.push({ id: 'b1b2c3d4', dirName: 'B', title: 'B', kind: 'movie', status: 'done', progress: 1, createdAt: 2 }); }),
    store.update((index) => { index.items.push({ id: 'c1c2c3d4', dirName: 'C', title: 'C', kind: 'movie', status: 'done', progress: 1, createdAt: 3 }); })
  ]);
  assert.equal((await store.read()).items.length, 3);

  store.invalidate();
  assert.equal((await store.read()).items.length, 3, 'releitura do disco mantém os itens');
});

test('deleteManagedItem: remove só a pasta do item dentro de downloadsDir', async (t) => {
  const dir = util.makeTmp(t, 'manifest-delete');
  const itemDir = path.join(dir, 'Filme');
  await manifest.writeManifest(itemDir, baseManifest());
  fs.writeFileSync(path.join(itemDir, 'video.mp4'), 'x');

  const out = await manifest.deleteManagedItem(dir, 'Filme');
  assert.equal(out.removed, true);
  assert.equal(fs.existsSync(itemDir), false);

  const again = await manifest.deleteManagedItem(dir, 'Filme');
  assert.equal(again.removed, false, 'item já removido não é erro');

  await assert.rejects(manifest.deleteManagedItem(dir, '../fora'), (e) => e.code === 'PATH_INVALID' || e.code === 'PATH_TRAVERSAL');
  await assert.rejects(manifest.deleteManagedItem(path.join(dir, 'nao-existe'), 'Filme'), (e) => e.code === 'PATH_NOT_FOUND');
});

test('deleteManagedItem: junction/symlink é removido sem apagar o destino', async (t) => {
  const dir = util.makeTmp(t, 'manifest-link');
  const outside = util.makeTmp(t, 'manifest-link-outside');
  fs.writeFileSync(path.join(outside, 'importante.txt'), 'não apagar');
  const link = path.join(dir, 'Item Linkado');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch (e) {
    t.skip('symlink/junction não suportado neste ambiente: ' + (e.code || e.message));
    return;
  }
  const out = await manifest.deleteManagedItem(dir, 'Item Linkado');
  assert.equal(out.removed, true);
  assert.equal(fs.existsSync(link), false, 'link removido');
  assert.equal(fs.existsSync(path.join(outside, 'importante.txt')), true, 'destino preservado');
});
