/* Acesso ao Postgres do Neon pelas Pages Functions, sem driver e sem dependência.
 *
 * O Neon expõe SQL por HTTP no endpoint /sql:
 *   POST https://<host>/sql   { query, params } ou { queries: [...] } (transação)
 *   header "Neon-Connection-String: postgresql://..."
 *
 * Toda consulta roda em uma transação curta que define `app.uid` e `app.role`;
 * as policies de RLS usam esses valores, então o banco também barra acesso a
 * linha de outro dono (não só o `if` do endpoint).
 *
 * O cliente conecta com o papel `space_app` (DML apenas, sem DDL).
 */

const TIMEOUT_MS = 12000;

export function config(env) {
  const url = String(env.NEON_APP_URL || '').trim();
  let host = '';
  try { host = url ? new URL(url).host : ''; } catch (e) { host = ''; }
  return {
    url: url,
    host: host,
    endpoint: host ? 'https://' + host + '/sql' : '',
    configured: !!(url && host)
  };
}

async function post(env, body) {
  const cfg = config(env);
  if (!cfg.configured) {
    const err = new Error('db_not_configured');
    err.code = 'not_configured';
    throw err;
  }
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;
  let res;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Neon-Connection-String': cfg.url,
        'Neon-Raw-Text-Output': 'true'
      },
      body: JSON.stringify(body),
      signal: signal
    });
  } catch (e) {
    const err = new Error('upstream_error');
    err.code = 'upstream_error';
    err.detail = e && e.name;
    throw err;
  }
  const text = await res.text();
  if (res.status !== 200) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    const err = new Error((parsed && parsed.message) || 'db_error');
    err.code = 'db';
    err.status = res.status;
    err.pgCode = parsed && parsed.code;
    err.pgMessage = parsed && parsed.message;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/* Contexto de execução: quem é o usuário e em que modo a transação roda.
 *   role: 'auth'  (login, refresh, sessão)  |  'admin'  |  'user'
 * Sem uid/role a transação roda como 'anon' e nenhuma policy libera linha. */
function preamble(context) {
  const ctx = context || {};
  return {
    query: "select set_config('app.uid', $1, true) as uid, set_config('app.role', $2, true) as role",
    params: [ctx.uid || '', ctx.role || 'anon']
  };
}

/* Executa várias instruções em UMA transação e devolve os resultados na ordem. */
export async function tx(env, context, statements) {
  const list = Array.isArray(statements) ? statements : [statements];
  const data = await post(env, { queries: [preamble(context)].concat(list) });
  const results = data && Array.isArray(data.results) ? data.results : [];
  return results.slice(1);
}

/* Uma instrução; devolve as linhas. */
export async function query(env, context, sql, params) {
  const results = await tx(env, context, [{ query: sql, params: params || [] }]);
  return (results[0] && results[0].rows) || [];
}

export async function one(env, context, sql, params) {
  const rows = await query(env, context, sql, params);
  return rows.length ? rows[0] : null;
}

/* O driver HTTP devolve tudo como texto: estes helpers normalizam. */
export function asBool(value) {
  if (value === true || value === 't' || value === 'true' || value === 1) return true;
  return false;
}

export function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function asJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (e) { return null; }
}

/* Traduz erro do Postgres para o código do contrato da API. */
export function errorCode(err) {
  if (!err) return 'upstream_error';
  if (err.code === 'not_configured') return 'not_configured';
  if (err.pgCode === '23505') return 'conflict';
  if (err.pgCode === '42501') return 'forbidden';
  if (err.pgCode === '23503') return 'invalid_input';
  if (err.pgCode === '23514' || err.pgCode === '22P02') return 'invalid_input';
  return 'upstream_error';
}
