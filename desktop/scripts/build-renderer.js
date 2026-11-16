#!/usr/bin/env node
/* Monta o renderer do Space IPTV Desktop em `desktop/dist/renderer`.
 *
 * Reaproveita SEM copiar código de terceiros: copia o núcleo `tv/` e os módulos
 * do app web usados pelo desktop, mais a camada própria `src/renderer/`.
 * O admin (`web/js/screens/admin.js`) fica de fora de propósito.
 *
 * Zero dependências. Uso: node scripts/build-renderer.js [--quiet]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP, '..');
const OUT = path.join(DESKTOP, 'dist', 'renderer');
const SRC = path.join(DESKTOP, 'src', 'renderer');

/* Arquivos do app web carregados pelo desktop. `web/js/upload.js` é trocado por
 * `src/renderer/js/upload-desktop.js`; `web/js/screens/admin.js` nunca entra. */
const WEB_JS = ['keys.js', 'pointers.js', 'net.js', 'session.js', 'sync.js', 'player.js', 'login.js'];
const WEB_CSS = ['web.css', 'login.css'];

const REQUIRED = [
  'index.html',
  'login.html',
  'js/bootstrap.js',
  'js/desktop-config.js',
  'js/upload-desktop.js',
  'css/desktop.css',
  'tv/css/design-system.css',
  'tv/css/app.css',
  'web/js/login.js',
  'web/js/shell.js',
  'web/js/player.js',
  'web/vendor/hls.min.js',
  'web/vendor/mpegts.min.js',
  'css/downloads.css',
  'js/downloads.js',
  'js/scrollbar.js',
  'css/epg.css',
  'js/epg/epg-parse.js',
  'js/epg/epg.js',
  'js/epg/guide-screen.js',
  'js/epg/live-epg.js'
];

function log(...args) {
  if (!process.argv.includes('--quiet')) console.log(...args);
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to, filter) {
  const entries = fs.readdirSync(from, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(from, entry.name);
    const dstPath = path.join(to, entry.name);
    if (filter && !filter(entry, srcPath)) continue;
    if (entry.isDirectory()) copyDir(srcPath, dstPath, filter);
    else if (entry.isFile()) copyFile(srcPath, dstPath);
  }
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n++;
  }
  return n;
}

function main() {
  if (!fs.existsSync(path.join(ROOT, 'tv', 'js', 'core', 'util.js'))) {
    throw new Error('repositório inesperado: tv/js/core/util.js não encontrado em ' + ROOT);
  }
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  /* 1. núcleo compartilhado da TV (JS, CSS, fontes, ícone) */
  copyDir(path.join(ROOT, 'tv', 'js'), path.join(OUT, 'tv', 'js'));
  copyDir(path.join(ROOT, 'tv', 'css'), path.join(OUT, 'tv', 'css'));
  copyDir(path.join(ROOT, 'tv', 'fonts'), path.join(OUT, 'tv', 'fonts'));
  copyFile(path.join(ROOT, 'tv', 'icon.png'), path.join(OUT, 'tv', 'icon.png'));

  /* 2. app web: shell, player e vendor (sem admin, sem upload web) */
  copyDir(path.join(ROOT, 'web', 'vendor'), path.join(OUT, 'web', 'vendor'));
  for (const name of WEB_JS) {
    copyFile(path.join(ROOT, 'web', 'js', name), path.join(OUT, 'web', 'js', name));
  }
  copyFile(path.join(ROOT, 'web', 'js', 'shell.js'), path.join(OUT, 'web', 'js', 'shell.js'));
  for (const name of WEB_CSS) {
    copyFile(path.join(ROOT, 'web', 'css', name), path.join(OUT, 'web', 'css', name));
  }

  /* 3. camada desktop (HTML, scripts e CSS próprios) por cima */
  copyDir(SRC, OUT, (entry) => entry.name !== '.gitkeep');

  const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(OUT, rel)));
  if (missing.length) {
    throw new Error('renderer incompleto; faltam: ' + missing.join(', '));
  }

  const total = countFiles(OUT);
  log('renderer montado em ' + path.relative(ROOT, OUT) + ' (' + total + ' arquivos)');
  log('  núcleo: tv/js + tv/css + tv/fonts');
  log('  web: ' + WEB_JS.join(', ') + ', shell.js, vendor, css');
  log('  desktop: src/renderer (admin.web fora do pacote)');
}

try {
  main();
} catch (err) {
  console.error('[build-renderer] ' + (err && err.message ? err.message : err));
  process.exitCode = 1;
}
