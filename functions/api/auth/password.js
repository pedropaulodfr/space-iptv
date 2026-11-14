/* POST /api/auth/password — troca a própria senha.
 *
 * Reautentica com a senha atual antes de trocar (um cookie roubado não basta),
 * troca o hash em bcrypt e revoga TODAS as sessões, devolvendo uma nova para
 * este navegador. */

import {
  fail, readJson, isSecureRequest, appendCookies, defaultMessage
} from '../../_lib/http.js';
import { one, query, asBool, config as dbConfig } from '../../_lib/db.js';
import { createSession, revokeAllSessions, userFromRow } from '../../_lib/session.js';
import { hasSecret } from '../../_lib/token.js';

const MIN_PASSWORD = 10;

function noContent() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'Vary': 'Cookie' } });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed', message: 'Método não permitido.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST', 'Cache-Control': 'no-store' }
    });
  }

  const authData = (context.data && context.data.auth) || null;
  if (!authData || !authData.payload) return fail('unauthorized', 'Sessão expirada. Entre de novo.');
  if (!dbConfig(env).configured || !hasSecret(env)) return fail('not_configured', defaultMessage('not_configured'));

  const body = await readJson(request, 4096);
  if (!body.ok) return fail('invalid_input', 'Dados inválidos.');
  const current = typeof body.value.current === 'string' ? body.value.current : '';
  const next = typeof body.value.next === 'string' ? body.value.next : '';

  if (!current) return fail('invalid_input', 'Informe a senha atual.');
  if (next.length < MIN_PASSWORD) {
    return fail('invalid_input', 'A nova senha precisa ter pelo menos ' + MIN_PASSWORD + ' caracteres.');
  }
  if (next.length > 200) return fail('invalid_input', 'A nova senha é grande demais.');
  if (next === current) return fail('invalid_input', 'A nova senha precisa ser diferente da atual.');

  const uid = authData.payload.u;

  try {
    const own = await one(env, { uid: uid, role: 'user' }, 'select email from app_users where id = $1', [uid]);
    if (!own) return fail('unauthorized', 'Sessão expirada. Entre de novo.');

    const check = await one(env, { role: 'auth' },
      'select ok from public.verify_password($1, $2)', [own.email, current]);
    if (!check || !asBool(check.ok)) return fail('invalid_credentials', 'Senha atual incorreta.');

    const rows = await query(env, { uid: uid, role: 'user' },
      'update app_users set password_hash = public.hash_password($1), updated_at = now() where id = $2 ' +
      'returning id, email, name, role', [next, uid]);
    if (!rows.length) return fail('upstream_error', defaultMessage('upstream_error'));

    await revokeAllSessions(env, uid);
    const session = await createSession(env, userFromRow(rows[0]), request, isSecureRequest(request));
    return appendCookies(noContent(), session.cookies);
  } catch (e) {
    return fail('upstream_error', defaultMessage('upstream_error'));
  }
}
