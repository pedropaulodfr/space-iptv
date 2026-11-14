/* /api/admin/users/:id — edita (PATCH) e exclui (DELETE) uma conta.
 *
 * Invariantes:
 *   1. ninguém desativa, rebaixa ou exclui a própria conta (403);
 *   2. sempre sobra pelo menos 1 admin ativo (409);
 *   3. excluir apaga os dados por cascata e não pode ser desfeito;
 *   4. desativar/rebaixar/resetar revoga as sessões (o refresh para na hora). */

import {
  fail, json, readJson, cleanText, defaultMessage, methodNotAllowed
} from '../../../_lib/http.js';
import { config as dbConfig } from '../../../_lib/db.js';
import {
  requireAdmin, getUser, countActiveAdmins, updateUser, deleteUser, writeAudit, auditMessage
} from '../../../_lib/admin.js';
import { revokeAllSessions } from '../../../_lib/session.js';

async function handlePatch(context, id) {
  const env = context.env;
  const actor = context.data.auth.payload;
  const body = await readJson(context.request, 4096);
  if (!body.ok) return fail('invalid_input', 'Dados inválidos.');

  let target;
  try {
    target = await getUser(env, id);
  } catch (e) {
    return fail('upstream_error', defaultMessage('upstream_error'));
  }
  if (!target) return fail('not_found', 'Usuário não encontrado.');

  const isSelf = target.id === actor.u;
  const wantsRole = body.value.role !== undefined;
  const wantsDisabled = body.value.disabled !== undefined;
  const wantsName = body.value.name !== undefined;

  if (wantsRole && body.value.role !== 'admin' && body.value.role !== 'user') {
    return fail('invalid_input', 'Papel inválido.');
  }
  if (wantsDisabled && typeof body.value.disabled !== 'boolean') {
    return fail('invalid_input', 'Estado inválido.');
  }

  const nextRole = wantsRole ? body.value.role : target.role;
  const nextDisabled = wantsDisabled ? body.value.disabled : target.disabled;
  const nextName = wantsName ? cleanText(body.value.name, 80) : target.name;

  if (wantsName && !nextName) return fail('invalid_input', 'Informe o nome do usuário.');
  if (isSelf && wantsRole && nextRole !== target.role) {
    return fail('forbidden', 'Você não pode mudar o papel da própria conta.');
  }
  if (isSelf && wantsDisabled && nextDisabled !== target.disabled) {
    return fail('forbidden', 'Você não pode desativar ou reativar a própria conta.');
  }

  const demoting = target.role === 'admin' && nextRole !== 'admin';
  const disabling = nextDisabled && !target.disabled;
  if (demoting || (disabling && target.role === 'admin')) {
    const admins = await countActiveAdmins(env);
    if (admins <= 1) {
      return fail('conflict', 'Esta é a última conta de administrador ativa. Promova outra conta antes.', 409);
    }
  }

  const fields = {};
  if (wantsName) fields.name = nextName;
  if (wantsRole) fields.role = nextRole;
  if (wantsDisabled) fields.disabled = nextDisabled;

  try {
    const user = await updateUser(env, id, fields);
    if (!user) return fail('not_found', 'Usuário não encontrado.');

    if (disabling || demoting) await revokeAllSessions(env, id);

    if (demoting) {
      await writeAudit(env, {
        actorId: actor.u, action: 'user.role', targetId: id, targetEmail: target.email,
        detail: { from: target.role, to: nextRole }
      });
    }
    if (disabling || (wantsDisabled && nextDisabled !== target.disabled)) {
      await writeAudit(env, {
        actorId: actor.u, action: 'user.disable', targetId: id, targetEmail: target.email,
        detail: { disabled: nextDisabled }
      });
    }
    if (wantsName && nextName !== target.name) {
      await writeAudit(env, {
        actorId: actor.u, action: 'user.name', targetId: id, targetEmail: target.email,
        detail: { name: nextName }
      });
    }

    return json({ user: user });
  } catch (e) {
    await writeAudit(env, {
      actorId: actor.u, action: 'user.disable', targetId: id, targetEmail: target.email,
      detail: { error: (e && (e.pgCode || e.message)) || 'error' }
    });
    return fail('upstream_error', auditMessage(e));
  }
}

async function handleDelete(context, id) {
  const env = context.env;
  const actor = context.data.auth.payload;

  let target;
  try {
    target = await getUser(env, id);
  } catch (e) {
    return fail('upstream_error', defaultMessage('upstream_error'));
  }
  if (!target) return fail('not_found', 'Usuário não encontrado.');
  if (target.id === actor.u) return fail('forbidden', 'Você não pode excluir a própria conta.');

  if (target.role === 'admin' && !target.disabled) {
    const admins = await countActiveAdmins(env);
    if (admins <= 1) {
      return fail('conflict', 'Esta é a última conta de administrador ativa. Promova outra conta antes.', 409);
    }
  }

  try {
    const removed = await deleteUser(env, id);
    if (!removed) return fail('not_found', 'Usuário não encontrado.');
    await writeAudit(env, {
      actorId: actor.u, action: 'user.delete', targetId: id, targetEmail: target.email, detail: {}
    });
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'Vary': 'Cookie' } });
  } catch (e) {
    await writeAudit(env, {
      actorId: actor.u, action: 'user.delete', targetId: id, targetEmail: target.email,
      detail: { error: (e && (e.pgCode || e.message)) || 'error' }
    });
    return fail('upstream_error', auditMessage(e));
  }
}

export async function onRequest(context) {
  const guard = requireAdmin(context);
  if (guard.error) return guard.error;
  if (!dbConfig(context.env).configured) {
    return fail('not_configured', 'Banco não configurado neste servidor.');
  }

  const id = String((context.params && context.params.id) || '');
  if (!id) return fail('not_found', 'Usuário não encontrado.');

  const method = context.request.method;
  if (method === 'PATCH') return handlePatch(context, id);
  if (method === 'DELETE') return handleDelete(context, id);
  if (method === 'GET') {
    const user = await getUser(context.env, id);
    if (!user) return fail('not_found', 'Usuário não encontrado.');
    return json({ user: user });
  }
  return methodNotAllowed('GET, PATCH, DELETE');
}
