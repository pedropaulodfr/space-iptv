/* POST /api/admin/users/:id/password — reset administrativo de senha.
 * A senha temporária é gerada com CSPRNG, mostrada UMA vez e nunca gravada em
 * log. Todas as sessões do alvo são revogadas. Para a própria conta, use
 * /api/auth/password (que pede a senha atual). */

import { fail, json, readJson, tempPassword, methodNotAllowed } from '../../../../_lib/http.js';
import { config as dbConfig } from '../../../../_lib/db.js';
import { requireAdmin, getUser, updateUser, writeAudit, auditMessage } from '../../../../_lib/admin.js';
import { revokeAllSessions } from '../../../../_lib/session.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return methodNotAllowed('POST');

  const guard = requireAdmin(context);
  if (guard.error) return guard.error;
  if (!dbConfig(env).configured) return fail('not_configured', 'Banco não configurado neste servidor.');

  const id = String((context.params && context.params.id) || '');
  const actor = context.data.auth.payload;

  if (id === actor.u) {
    return fail('forbidden', 'Para trocar a sua própria senha, use "Alterar minha senha" em Configurações.');
  }

  const target = await getUser(env, id);
  if (!target) return fail('not_found', 'Usuário não encontrado.');

  const body = await readJson(request, 2048);
  const given = body.ok && typeof body.value.password === 'string' ? body.value.password : '';
  if (given && given.length < 10) return fail('invalid_input', 'A senha precisa ter pelo menos 10 caracteres.');
  if (given.length > 200) return fail('invalid_input', 'A senha é grande demais.');

  const password = given || tempPassword(16);
  const generated = !given;

  try {
    const user = await updateUser(env, id, { password: password });
    if (!user) return fail('not_found', 'Usuário não encontrado.');
    await revokeAllSessions(env, id);
    await writeAudit(env, {
      actorId: actor.u, action: 'user.password', targetId: id, targetEmail: target.email,
      detail: { generated: generated }
    });
    return json({ tempPassword: generated ? password : null });
  } catch (e) {
    await writeAudit(env, {
      actorId: actor.u, action: 'user.password', targetId: id, targetEmail: target.email,
      detail: { error: (e && (e.pgCode || e.message)) || 'error' }
    });
    return fail('upstream_error', auditMessage(e));
  }
}
