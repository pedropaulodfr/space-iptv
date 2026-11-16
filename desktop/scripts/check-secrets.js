#!/usr/bin/env node
/* Auditoria de segredos e de escopo do pacote desktop.
 *
 * Uso:
 *   node scripts/check-secrets.js            # audita src/ e dist/renderer (se existir)
 *   node scripts/check-secrets.js --dist      # exige dist/renderer + dist/desktop presentes
 *
 * Sai com código 1 se achar algo que não pode ir no pacote. Sem dependências.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DESKTOP = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP, '..');
const DIST_RENDERER = path.join(DESKTOP, 'dist', 'renderer');
const DIST_INSTALLER = path.join(ROOT, 'dist', 'desktop');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'tmp', 'dist', '.cache', 'build']);
const TEXT_EXT = new Set(['.js', '.html', '.css', '.json', '.md', '.yml', '.yaml', '.txt', '.nsh', '.ps1']);

/* Arquivos que nunca podem entrar no pacote. */
const FORBIDDEN_FILES = [
  /(^|[\\/])\.dev\.vars$/i,
  /(^|[\\/])\.env(\..*)?$/i,
  /(^|[\\/])\.env\.local$/i,
  /(^|[\\/])keystore\.properties$/i,
  /\.(pem|key|pfx|p12|jks|keystore)$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])config\.json$/i
];

/* Trechos de segredo/credencial que não podem aparecer em texto. */
const SECRET_PATTERNS = [
  { re: /AUTH_SECRET\s*[:=]\s*[0-9a-f]{32,}/i, why: 'AUTH_SECRET real' },
  { re: /NEON_(APP_|DATABASE_)?URL\s*[:=]\s*postgres/i, why: 'connection string Neon' },
  { re: /postgres(ql)?:\/\/[^\s"'<>]*:[^\s"'<>]*@/i, why: 'URI Postgres com senha' },
  { re: /neondb_owner[^a-z]/i, why: 'usuário dono do banco' },
  { re: /\bnpg_[A-Za-z0-9]{12,}\b/, why: 'senha de role Neon' },
  { re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, why: 'chave privada' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, why: 'token estilo OpenAI' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, why: 'token GitHub' }
];

const problems = [];
let scanned = 0;

function isIgnoredDir(name) {
  return IGNORE_DIRS.has(name);
}

function scanFile(file) {
  const rel = path.relative(DESKTOP, file);
  /* o próprio script contém os padrões de busca: não se auditar */
  if (path.basename(file) === 'check-secrets.js') return;
  for (const re of FORBIDDEN_FILES) {
    if (re.test(file)) problems.push(rel + ': arquivo proibido no pacote');
  }
  const ext = path.extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext)) return;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  scanned++;
  for (const rule of SECRET_PATTERNS) {
    if (rule.re.test(text)) problems.push(rel + ': possível ' + rule.why);
  }
}

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isIgnoredDir(entry.name)) continue;
      walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      scanFile(path.join(dir, entry.name));
    }
  }
}

/* Escopo: o admin da web não pode ir para o desktop. */
function checkScope() {
  const admin = path.join(DIST_RENDERER, 'web', 'js', 'screens', 'admin.js');
  if (fs.existsSync(admin)) problems.push('dist/renderer/web/js/screens/admin.js presente (admin deve ficar só na web)');
  if (fs.existsSync(DIST_RENDERER)) {
    const shell = path.join(DIST_RENDERER, 'web', 'js', 'shell.js');
    if (!fs.existsSync(shell)) problems.push('dist/renderer sem web/js/shell.js');
    const fonts = path.join(DIST_RENDERER, 'tv', 'fonts');
    if (fs.existsSync(fonts)) {
      const list = fs.readdirSync(fonts);
      if (!list.some((f) => /\.woff2$/i.test(f))) problems.push('dist/renderer/tv/fonts sem fontes locais (offline quebrado)');
    }
  }
}

function main() {
  console.log('[check-secrets] auditando ' + DESKTOP);
  walk(path.join(DESKTOP, 'src'));
  walk(path.join(DESKTOP, 'installer'));
  walk(path.join(DESKTOP, 'scripts'));
  if (fs.existsSync(DIST_RENDERER)) {
    walk(DIST_RENDERER);
    checkScope();
  } else if (process.argv.includes('--dist')) {
    problems.push('dist/renderer ausente (rode npm run build:renderer)');
  }
  if (process.argv.includes('--dist') && !fs.existsSync(DIST_INSTALLER)) {
    problems.push('dist/desktop ausente (rode npm run dist)');
  }

  if (problems.length) {
    console.error('[check-secrets] FALHOU (' + problems.length + '):');
    for (const p of problems) console.error('  - ' + p);
    process.exitCode = 1;
    return;
  }
  console.log('[check-secrets] OK — ' + scanned + ' arquivos de texto auditados, 0 segredo/escopo indevido.');
}

main();
