/* /api/admin/users — lista (GET) e cria (POST) contas.
 * Exige app.role = 'admin' no token; toda ação grava em admin_audit. */

import {
  fail, json, readJson, isEmail, cleanText, tempPassword, defaultMessage, methodNotAllowed
} from '../../../_lib/http.js';
import { config as dbConfig } from '../../../_lib/db.js';
import { requireAdmin, listUsers, createUser, writeAudit, auditMessage } from '../../../_lib/admin.js';

const MIN_PASSWORD = 10;

async function handleList(context) {
  const url = new URL(context.request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('perPage'), 10) || 25));
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);

  try {
    const data = await listUsers(context.env, { page: page, perPage: perPage, q: q });
    return json({ users: data.users, total: data.total, page: data.page, perPage: data.perPage });
  } catch (e) {
    if (e && e.code === 'not_configured') return fail('not_configured', defaultMessage('not_configured'));
    return fail('upstream_error', defaultMessage('upstream_error'));
  }
}

async function handleCreate(context) {
  const env = context.env;
  const actor = context.data.auth.payload;
  const body = await readJson(context.request, 4096);
  if (!body.ok) return fail('invalid_input', 'Dados inválidos.');

  const email = typeof body.value.email === 'string' ? body.value.email.trim().toLowerCase() : '';
  const name = cleanText(body.value.name, 80);
  const role = body.value.role === 'admin' ? 'admin' : 'user';
  const given = typeof body.value.password === 'string' ? body.value.password : '';

  if (!isEmail(email)) return fail('invalid_input', 'Informe um e-mail válido.');
  if (!name) return fail('invalid_input', 'Informe o nome do usuário.');
  if (given && given.length < MIN_PASSWORD) {
    return fail('invalid_input', 'A senha precisa ter pelo menos ' + MIN_PASSWORD + ' caracteres.');
  }
  if (given.length > 200) return fail('invalid_input', 'A senha é grande demais.');

  const password = given || tempPassword(16);
  const generated = !given;

  try {
    const user = await createUser(env, { email: email, name: name, role: role, password: password });
    await writeAudit(env, {
      actorId: actor.u,
      actorEmail: '',
      action: 'user.create',
      targetId: user.id,
      targetEmail: email,
      detail: { role: role }
    });
    return json({ user: user, tempPassword: generated ? password : null }, 201);
  } catch (e) {
    await writeAudit(env, {
      actorId: actor.u,
      action: 'user.create',
      targetEmail: email,
      detail: { role: role, error: (e && (e.pgCode || e.message)) || 'error' }
    });
    return fail(e && e.pgCode === '23505' ? 'conflict' : 'upstream_error', auditMessage(e),
      e && e.pgCode === '23505' ? 409 : 502);
  }
}

export async function onRequest(context) {
  const guard = requireAdmin(context);
  if (guard.error) return guard.error;
  if (!dbConfig(context.env).configured) {
    return fail('not_configured', 'Banco não configurado neste servidor.');
  }

  const method = context.request.method;
  if (method === 'GET') return handleList(context);
  if (method === 'POST') return handleCreate(context);
  return methodNotAllowed('GET, POST');
}
