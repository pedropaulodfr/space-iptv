/* POST /api/auth/login — única porta de entrada.
 *
 * Erro de credencial é sempre a mesma resposta (conta inexistente, senha errada
 * ou conta desativada), com limite de tentativas por e-mail/IP. A senha é
 * conferida no Postgres por crypt() (bcrypt custo 12, pgcrypto): o hash nunca
 * sai do banco e a senha nunca é registrada em log. */

import {
  fail, json, readJson, isEmail, isSecureRequest, methodNotAllowed, appendCookies, defaultMessage
} from '../../_lib/http.js';
import { config as dbConfig, one, query, asBool } from '../../_lib/db.js';
import { createSession, userFromRow } from '../../_lib/session.js';
import { hasSecret } from '../../_lib/token.js';

const INVALID = 'E-mail ou senha inválidos.';
const WINDOW = '15 minutes';
const MAX_FAILURES = 8;

function invalid() { return fail('invalid_credentials', INVALID); }

function clientIp(request) {
  return String(request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '').split(',')[0].trim().slice(0, 60);
}

async function tooManyFailures(env, email, ip) {
  const row = await one(env, { role: 'auth' },
    "select count(*)::int as n from login_attempts where ok = false and at > now() - interval '" + WINDOW + "' " +
    'and (lower(email) = lower($1) or ($2 <> \'\' and ip = $2))', [email, ip]);
  return row ? Number(row.n) >= MAX_FAILURES : false;
}

async function recordAttempt(env, email, ip, ok) {
  try {
    await query(env, { role: 'auth' },
      'insert into login_attempts (email, ip, ok) values (lower($1), $2, $3)', [email, ip, !!ok]);
  } catch (e) { /* não bloqueia o login por falha de telemetria */ }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return methodNotAllowed('POST');

  if (!dbConfig(env).configured || !hasSecret(env)) {
    return fail('not_configured', 'Login não configurado neste servidor. Fale com o administrador.');
  }

  const body = await readJson(request, 4096);
  if (!body.ok) return fail('invalid_input', 'Dados inválidos.');
  const email = typeof body.value.email === 'string' ? body.value.email.trim().toLowerCase() : '';
  const password = typeof body.value.password === 'string' ? body.value.password : '';
  if (!isEmail(email) || !password || password.length > 200) return invalid();

  const ip = clientIp(request);

  try {
    if (await tooManyFailures(env, email, ip)) {
      return fail('rate_limited', defaultMessage('rate_limited'), 429, { 'Retry-After': '900' });
    }

    const row = await one(env, { role: 'auth' },
      'select id, email, name, role, disabled, ok from public.verify_password($1, $2)', [email, password]);

    const ok = !!(row && asBool(row.ok));
    const disabled = !!(row && asBool(row.disabled));
    await recordAttempt(env, email, ip, ok && !disabled);

    if (!ok || disabled) return invalid();

    const user = userFromRow(row);
    const session = await createSession(env, user, request, isSecureRequest(request));

    await query(env, { role: 'auth' }, 'update app_users set last_sign_in_at = now() where id = $1', [user.id]);

    return appendCookies(json({ user: user }), session.cookies);
  } catch (e) {
    if (e && e.code === 'not_configured') return fail('not_configured', defaultMessage('not_configured'));
    return fail('upstream_error', defaultMessage('upstream_error'));
  }
}
