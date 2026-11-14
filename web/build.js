#!/usr/bin/env node
/* Space IPTV - build estatico da versao web (zero dependencias).
 *
 * Uso:
 *   node web/build.js                    -> dist/web
 *   node web/build.js --out dist/web2    -> outro destino (relativo a raiz do repo)
 *   BUILD_OUT=dist/web2 node web/build.js
 *   node web/build.js --help
 *
 * O que e copiado (sem bundler, sem minificacao, sem transformacao):
 *   web/index.html                -> <out>/index.html
 *   web/js, web/css, web/vendor   -> <out>/web/js|css|vendor
 *   tv/js, tv/css, tv/fonts       -> <out>/tv/js|css|fonts
 *   tv/icon.png                   -> <out>/tv/icon.png
 *
 * Os caminhos dentro do index.html sao relativos, entao o resultado funciona em
 * http://host/ e em http://host/repo/ (GitHub Pages). Servidor, build, README,
 * docs, dist/, state/ e capturas NAO entram no destino.
 *
 * O script e idempotente: valida as fontes, limpa o destino e copia de novo.
 * Se faltar fonte essencial ou referencia, falha com mensagem clara; na validacao
 * das fontes o destino atual nem chega a ser apagado.
 * No fim imprime a contagem de arquivos/bytes e o caminho final.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'dist', 'web');
const OUT_ENV = 'BUILD_OUT';

/* Fontes copiadas. `label` agrupa a contagem no resumo final. */
const SOURCES = [
  { from: 'web/index.html', to: 'index.html', kind: 'file', label: 'html' },
  { from: 'web/js', to: 'web/js', kind: 'dir', label: 'web' },
  { from: 'web/css', to: 'web/css', kind: 'dir', label: 'web' },
  { from: 'web/vendor', to: 'web/vendor', kind: 'dir', label: 'web' },
  { from: 'tv/js', to: 'tv/js', kind: 'dir', label: 'tv' },
  { from: 'tv/css', to: 'tv/css', kind: 'dir', label: 'tv' },
  { from: 'tv/fonts', to: 'tv/fonts', kind: 'dir', label: 'tv' },
  { from: 'tv/icon.png', to: 'tv/icon.png', kind: 'file', label: 'tv' }
];

/* Arquivos sem os quais o app nao funciona, mesmo que o diretorio exista. */
const MUST_EXIST = [
  'web/index.html',
  'web/js/keys.js',
  'web/js/pointers.js',
  'web/js/net.js',
  'web/js/player.js',
  'web/js/shell.js',
  'web/css/web.css',
  'web/vendor/hls.min.js',
  'web/vendor/mpegts.min.js',
  'tv/css/design-system.css',
  'tv/css/app.css',
  'tv/js/core/util.js',
  'tv/js/core/starfield.js',
  'tv/js/storage/store.js',
  'tv/js/api/http.js',
  'tv/js/services/catalog.js',
  'tv/icon.png'
];

/* Nada disso pode aparecer no destino: sao ferramentas de desenvolvimento. */
const FORBIDDEN = [/^(?:.*\/)?server\.js$/i, /^(?:.*\/)?build\.js$/i, /^(?:.*\/)?smoke\.js$/i, /\.md$/i];

/* Pastas que nunca podem ser o destino: limpar apagaria as fontes. */
const PROTECTED_DIRS = ['web', 'tv', 'tools', 'celular', 'projetor'];

function fail(message, outTouched) {
  console.error('');
  console.error('erro: ' + message);
  console.error(outTouched
    ? 'Build cancelado; o destino foi limpo e ficou incompleto.'
    : 'Build cancelado; nada no destino foi alterado.');
  console.error('');
  process.exitCode = 1;
  throw new BuildError(message);
}

class BuildError extends Error {}

function usage() {
  return [
    'Space IPTV - build estatico da versao web (zero dependencias)',
    '',
    'Uso: node web/build.js [--out <pasta>] [--help]',
    '',
    '  --out <pasta>   destino do build (padrao: ' + path.relative(ROOT, DEFAULT_OUT).replace(/\\/g, '/') + ')',
    '                  caminho relativo a raiz do repositorio; env ' + OUT_ENV + ' tambem vale',
    '  --help, -h      esta ajuda',
    '',
    'Copia index.html, web/{js,css,vendor} e tv/{js,css,fonts,icon.png}, sem bundler.',
    'O build e idempotente: limpa o destino e copia de novo.'
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Argumentos                                                                 */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const cfg = { out: process.env[OUT_ENV] || DEFAULT_OUT, help: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      cfg.help = true;
    } else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new BuildError('faltou o valor de --out');
      cfg.out = value;
    } else if (arg.indexOf('--out=') === 0) {
      cfg.out = arg.slice('--out='.length);
    } else {
      throw new BuildError('argumento desconhecido: ' + arg);
    }
  }
  if (!cfg.help && (!cfg.out || !String(cfg.out).trim())) {
    throw new BuildError('destino vazio (use --out <pasta>)');
  }
  return cfg;
}

/* Resolve o destino e recusa caminhos que destruiriam as fontes ou o repo. */
function resolveOut(raw) {
  const abs = path.resolve(ROOT, String(raw));
  if (abs === ROOT) throw new BuildError('o destino nao pode ser a raiz do repositorio');
  const rel = path.relative(ROOT, abs);
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.indexOf('..' + path.sep) === 0) {
    throw new BuildError('o destino precisa ficar dentro do repositorio (ex.: dist/web)');
  }
  const first = rel.split(path.sep)[0].toLowerCase();
  if (PROTECTED_DIRS.indexOf(first) >= 0) {
    throw new BuildError('o destino nao pode ficar dentro de ' + first + '/ (limparia as fontes)');
  }
  return abs;
}

/* -------------------------------------------------------------------------- */
/* Validacao das fontes                                                       */
/* -------------------------------------------------------------------------- */

function missingSources() {
  const missing = [];
  for (const src of SOURCES) {
    const abs = path.join(ROOT, src.from);
    let ok = false;
    try {
      const st = fs.statSync(abs);
      ok = src.kind === 'dir' ? st.isDirectory() : st.isFile();
    } catch (e) { ok = false; }
    if (!ok) missing.push(src.from + (src.kind === 'dir' ? '/' : ''));
  }
  return missing;
}

function missingFiles() {
  const missing = [];
  for (const rel of MUST_EXIST) {
    try {
      if (!fs.statSync(path.join(ROOT, rel)).isFile()) missing.push(rel);
    } catch (e) { missing.push(rel); }
  }
  return missing;
}

function validateSources() {
  const missing = missingSources();
  if (missing.length) fail('faltam arquivos essenciais: ' + missing.join(', '));
  const files = missingFiles();
  if (files.length) fail('faltam arquivos essenciais: ' + files.join(', '));
}

/* -------------------------------------------------------------------------- */
/* Copia                                                                      */
/* -------------------------------------------------------------------------- */

function copyRecursive(fromAbs, toAbs, stats, label) {
  const st = fs.statSync(fromAbs);
  if (st.isDirectory()) {
    fs.mkdirSync(toAbs, { recursive: true });
    const entries = fs.readdirSync(fromAbs, { withFileTypes: true }).sort(function (a, b) {
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    for (const entry of entries) {
      copyRecursive(path.join(fromAbs, entry.name), path.join(toAbs, entry.name), stats, label);
    }
    return;
  }
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.copyFileSync(fromAbs, toAbs);
  stats.files += 1;
  stats.bytes += st.size;
  stats.byLabel[label] = (stats.byLabel[label] || 0) + 1;
}

function cleanOut(outAbs) {
  fs.rmSync(outAbs, { recursive: true, force: true });
  fs.mkdirSync(outAbs, { recursive: true });
}

function copyAll(outAbs) {
  const stats = { files: 0, bytes: 0, byLabel: {} };
  for (const src of SOURCES) {
    copyRecursive(path.join(ROOT, src.from), path.join(outAbs, src.to), stats, src.label);
  }
  return stats;
}

/* -------------------------------------------------------------------------- */
/* Validacao do destino                                                       */
/* -------------------------------------------------------------------------- */

function walk(abs, base, out) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(abs)) walk(path.join(abs, entry), base, out);
    return out;
  }
  out.push(path.relative(base, abs).replace(/\\/g, '/'));
  return out;
}

/* Referencias relativas de src/href do HTML e url() dos CSS precisam existir. */
function checkReferences(outAbs) {
  const missing = [];
  const htmlFile = path.join(outAbs, 'index.html');

  const html = fs.readFileSync(htmlFile, 'utf8');
  const refRe = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = refRe.exec(html))) {
    const ref = m[1].trim();
    if (!ref || ref.charAt(0) === '#' || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.indexOf('//') === 0) continue;
    const rel = ref.split('#')[0].split('?')[0].replace(/^\.?\//, '');
    if (!rel) continue;
    if (!fs.existsSync(path.join(outAbs, rel))) missing.push(rel + ' (index.html)');
  }

  const cssFiles = walk(outAbs, outAbs, []).filter(function (rel) { return /\.css$/i.test(rel); });
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  for (const rel of cssFiles) {
    const css = fs.readFileSync(path.join(outAbs, rel), 'utf8');
    let u;
    urlRe.lastIndex = 0;
    while ((u = urlRe.exec(css))) {
      const ref = u[2].trim();
      if (!ref || ref.charAt(0) === '#' || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.indexOf('//') === 0) continue;
      const target = path.resolve(path.dirname(path.join(outAbs, rel)), ref.split('#')[0].split('?')[0]);
      if (!fs.existsSync(target)) missing.push(ref + ' (' + rel + ')');
    }
  }
  return missing;
}

function checkForbidden(outAbs) {
  const found = [];
  for (const rel of walk(outAbs, outAbs, [])) {
    for (const re of FORBIDDEN) {
      if (re.test(rel)) { found.push(rel); break; }
    }
  }
  return found;
}

function validateOutput(outAbs) {
  const refs = checkReferences(outAbs);
  if (refs.length) fail('o build ficou com referencias quebradas: ' + refs.slice(0, 8).join(', '), true);
  const forbidden = checkForbidden(outAbs);
  if (forbidden.length) fail('o destino tem arquivo de desenvolvimento: ' + forbidden.join(', '), true);
}

/* -------------------------------------------------------------------------- */
/* Relatorio                                                                  */
/* -------------------------------------------------------------------------- */

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' KB';
  return (n / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB';
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function report(outAbs, stats) {
  const labels = ['html', 'web', 'tv'];
  const names = { html: 'index.html', web: 'web/ (js, css, vendor)', tv: 'tv/ (js, css, fonts, icon.png)' };
  console.log('');
  console.log('Space IPTV - build web');
  console.log('  origem:  ' + ROOT);
  console.log('  destino: ' + outAbs);
  console.log('');
  for (const key of labels) {
    const count = stats.byLabel[key] || 0;
    console.log('  ' + names[key] + ': ' + count + ' arquivo' + (count === 1 ? '' : 's'));
  }
  console.log('');
  console.log('  total: ' + stats.files + ' arquivos, ' + fmtBytes(stats.bytes));
  console.log('  pronto: ' + rel(outAbs) + '/ (sirva esta pasta como estatico)');
  console.log('');
}

/* -------------------------------------------------------------------------- */
/* Principal                                                                  */
/* -------------------------------------------------------------------------- */

function main() {
  let cfg;
  try {
    cfg = parseArgs(process.argv);
  } catch (e) {
    console.error('erro: ' + e.message);
    console.error('');
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (cfg.help) { console.log(usage()); return; }

  let outAbs;
  try {
    outAbs = resolveOut(cfg.out);
  } catch (e) {
    if (e instanceof BuildError) {
      console.error('erro: ' + e.message);
      process.exitCode = 2;
      return;
    }
    throw e;
  }

  try {
    validateSources();
    cleanOut(outAbs);
    const stats = copyAll(outAbs);
    validateOutput(outAbs);
    report(outAbs, stats);
  } catch (e) {
    if (e instanceof BuildError) {
      if (!process.exitCode) process.exitCode = 1;
      return;
    }
    console.error('');
    console.error('erro: ' + (e && e.message ? e.message : 'falha inesperada no build'));
    if (e && e.stack && process.env.BUILD_DEBUG) console.error(e.stack);
    console.error('Build interrompido.');
    console.error('');
    process.exitCode = 1;
  }
}

main();
