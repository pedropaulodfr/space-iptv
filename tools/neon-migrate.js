#!/usr/bin/env node
/* Aplica um arquivo .sql no Neon pelo endpoint HTTP (sem driver, zero dependências).
 *
 * Uso:
 *   node tools/neon-migrate.js db/001_init.sql
 *   NEON_DATABASE_URL=postgresql://... node tools/neon-migrate.js db/001_init.sql
 *
 * O endpoint /sql do Neon usa prepared statements: cada item precisa ser UMA
 * instrução. Este script divide o arquivo respeitando strings, comentários e
 * blocos $$ ... $$ (funções) e envia em lotes transacionais.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHUNK = 40;

function loadVars(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

/* Divide em instruções por ';' fora de string, comentário e bloco $tag$. */
function splitStatements(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  let dollarTag = null;

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (dollarTag) {
      if (ch === '$') {
        let j = sql.indexOf('$', i + 1);
        if (j > i) {
          const tag = sql.slice(i, j + 1);
          if (tag === dollarTag) {
            cur += tag;
            i = j + 1;
            dollarTag = null;
            continue;
          }
        }
      }
      cur += ch;
      i++;
      continue;
    }

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === "'") {
      cur += ch;
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { cur += "''"; i += 2; continue; }
        cur += sql[i];
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === '"') {
      cur += ch;
      i++;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        cur += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }

    cur += ch;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function call(endpoint, conn, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': conn,
      'Neon-Raw-Text-Output': 'true'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (res.status !== 200) {
    let detail = text;
    try { detail = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* texto */ }
    throw new Error('HTTP ' + res.status + ': ' + detail);
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Uso: node tools/neon-migrate.js <arquivo.sql>');
    process.exitCode = 2;
    return;
  }
  const vars = Object.assign(loadVars(path.join(ROOT, '.dev.vars')), process.env);
  const conn = vars.NEON_DATABASE_URL;
  if (!conn) {
    console.error('NEON_DATABASE_URL ausente (.dev.vars ou ambiente).');
    process.exitCode = 2;
    return;
  }
  const endpoint = 'https://' + new URL(conn).host + '/sql';
  const sql = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
  const statements = splitStatements(sql);
  console.log('Aplicando ' + statements.length + ' instruções de ' + file + ' em ' + new URL(conn).host);

  let done = 0;
  for (let i = 0; i < statements.length; i += CHUNK) {
    const slice = statements.slice(i, i + CHUNK);
    try {
      await call(endpoint, conn, { queries: slice.map(function (q) { return { query: q }; }) });
    } catch (e) {
      const failing = slice.find(function (q) { return false; });
      console.error('Falha no lote ' + (i / CHUNK + 1) + ': ' + e.message);
      console.error('Primeira instrução do lote: ' + slice[0].slice(0, 160));
      process.exitCode = 1;
      return;
    }
    done += slice.length;
    console.log('  ' + done + '/' + statements.length);
  }
  console.log('Schema aplicado.');
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('falha: ' + e.message);
    process.exitCode = 1;
  });
}

module.exports = { splitStatements };
