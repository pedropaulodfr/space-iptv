'use strict';
/* Testes da correção do caminho de downloads corrompido (mojibake) e do
 * saneamento de pastas. O bug: `reg query` era lido como UTF-8 e "í" virava
 * U+FFFD, criando "D:\V\uFFFDdeos". O app agora lê o registro como UTF-16
 * (`reg export`) e move a pasta antiga para o caminho correto. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../../src/main/config.js');

function tmpDir(t, name) {
  const dir = path.join(os.tmpdir(), 'space-cfg-' + process.pid + '-' + Date.now() + '-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  return dir;
}

test('mangledPathOf troca apenas caracteres não-ASCII por U+FFFD', () => {
  assert.equal(config.mangledPathOf('D:\\Vídeos\\Space IPTV'), 'D:\\V\uFFFDdeos\\Space IPTV');
  assert.equal(config.mangledPathOf('D:\\Videos\\Space IPTV'), '');
});

test('checkWritableDir rejeita caminho com U+FFFD (não cria pasta corrompida)', () => {
  const out = config.checkWritableDir(path.join(os.tmpdir(), 'V\uFFFDdeos'));
  assert.equal(out.ok, false);
  assert.match(out.error, /corrompido|codifica/i);
});

test('repairMangledDownloadsDir renomeia pasta corrompida para o caminho correto', (t) => {
  const root = tmpDir(t, 'rename');
  const good = path.join(root, 'Vídeos', 'Space IPTV');
  const bad = path.join(root, 'V\uFFFDdeos', 'Space IPTV');
  fs.mkdirSync(path.join(bad, '.space-iptv'), { recursive: true });
  fs.writeFileSync(path.join(bad, '.space-iptv', 'index.json'), '{"items":[]}', 'utf8');
  fs.writeFileSync(path.join(bad, 'video.mp4'), 'abc', 'utf8');

  const res = config.repairMangledDownloadsDir(good);
  assert.ok(res && res.moved, 'devolve que moveu');
  assert.equal(fs.existsSync(path.join(good, '.space-iptv', 'index.json')), true);
  assert.equal(fs.existsSync(path.join(good, 'video.mp4')), true);
  assert.equal(fs.existsSync(path.join(root, 'V\uFFFDdeos')), false, 'pasta-pai corrompida removida quando vazia');
});

test('repairMangledDownloadsDir faz merge quando o caminho correto já existe', (t) => {
  const root = tmpDir(t, 'merge');
  const good = path.join(root, 'Vídeos', 'Space IPTV');
  const bad = path.join(root, 'V\uFFFDdeos', 'Space IPTV');
  fs.mkdirSync(good, { recursive: true });
  fs.writeFileSync(path.join(good, 'existente.txt'), 'ok', 'utf8');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'antigo.txt'), 'ok', 'utf8');
  fs.writeFileSync(path.join(bad, 'existente.txt'), 'nao sobrescreve', 'utf8');

  const res = config.repairMangledDownloadsDir(good);
  assert.ok(res && res.moved);
  assert.equal(fs.readFileSync(path.join(good, 'antigo.txt'), 'utf8'), 'ok');
  assert.equal(fs.readFileSync(path.join(good, 'existente.txt'), 'utf8'), 'ok', 'arquivo existente preservado');
});

test('repairMangledDownloadsDir não mexe em caminho sem variante corrompida', () => {
  assert.equal(config.repairMangledDownloadsDir(path.join(os.tmpdir(), 'Space IPTV Audit Normal')), null);
});

test('readRegistryDownloadsDir preserva acentos (quando a chave existe)', (t) => {
  if (process.platform !== 'win32') return;
  const value = config.readRegistryDownloadsDir();
  if (!value) return;               /* máquina sem a chave do instalador */
  assert.equal(value.indexOf('\uFFFD'), -1, 'nenhum caractere de substituição: ' + value);
});
