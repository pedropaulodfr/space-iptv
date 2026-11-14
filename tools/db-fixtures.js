#!/usr/bin/env node
/* Fixtures dos testes: create/clean users direto no Postgres do Neon, usando a
 * mesma conexão de aplicação (papel space_app) e o contexto app.uid/app.role.
 * Nada aqui roda em produção: os e-mails são sempre do domínio de teste. */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEST_DOMAIN = 'e2e.local';

function loadVars(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.replace(/^\uFEFF/, '').trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function loadEnv(extra) {
  const vars = loadVars(path.join(ROOT, '.dev.vars'));
  return Object.assign({}, vars, extra || {});
}

function config(env) {
  const url = String(env.NEON_APP_URL || '').trim();
  if (!url) throw new Error('NEON_APP_URL ausente (.dev.vars)');
  return { url: url, endpoint: 'https://' + new URL(url).host + '/sql' };
}

async function call(env, body) {
  const cfg = config(env);
  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': cfg.url,
      'Neon-Raw-Text-Output': 'true'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (res.status !== 200) {
    let detail = text;
    try { detail = JSON.stringify(JSON.parse(text)); } catch (e) { /* texto */ }
    throw new Error('db ' + res.status + ': ' + detail);
  }
  return text ? JSON.parse(text) : null;
}

async function tx(env, ctx, statements) {
  const preamble = {
    query: "select set_config('app.uid', $1, true), set_config('app.role', $2, true)",
    params: [(ctx && ctx.uid) || '', (ctx && ctx.role) || 'anon']
  };
  const data = await call(env, { queries: [preamble].concat(statements) });
  return (data.results || []).slice(1);
}

async function rows(env, ctx, query, params) {
  const res = await tx(env, ctx, [{ query: query, params: params || [] }]);
  return (res[0] && res[0].rows) || [];
}

/* Remove tudo que os testes criaram (cascata leva dados e sessões). */
async function cleanup(env) {
  await rows(env, { role: 'admin' },
    "delete from app_users where lower(email) like '%@' || $1 returning id", [TEST_DOMAIN]);
}

/* Cria (ou recria) uma conta de teste com senha conhecida. */
async function seedUser(env, input) {
  const email = String(input.email || '').toLowerCase();
  if (email.indexOf('@' + TEST_DOMAIN) < 0) throw new Error('e-mail de teste precisa terminar em @' + TEST_DOMAIN);
  await rows(env, { role: 'admin' }, 'delete from app_users where lower(email) = $1', [email]);
  const res = await tx(env, { role: 'auth' }, [{
    query:
      'insert into app_users (email, name, role, password_hash, disabled) ' +
      'values (lower($1), $2, $3, public.hash_password($4), $5) returning id',
    params: [email, input.name || email.split('@')[0], input.role === 'admin' ? 'admin' : 'user',
      input.password, !!input.disabled]
  }]);
  const row = res[0] && res[0].rows && res[0].rows[0];
  if (!row) throw new Error('não criou o usuário de teste');
  return row.id;
}

async function count(env, table) {
  const res = await rows(env, { role: 'admin' }, 'select count(*)::int as n from ' + table);
  return res.length ? Number(res[0].n) : 0;
}

module.exports = { ROOT, TEST_DOMAIN, loadVars, loadEnv, tx, rows, cleanup, seedUser, count };
