/* Administração de contas: listar, criar, editar, desativar, excluir e auditar.
 * Tudo roda como app_role = 'admin' — as policies de RLS deixam o admin ler
 * app_users, mas continuam barrando qualquer acesso aos dados dos usuários. */

import { fail, isUuid, cleanText } from './http.js';
import { query, one, tx, asBool, errorCode } from './db.js';

const MAX_PAGE = 100;

export function requireAdmin(context) {
  const authData = (context.data && context.data.auth) || null;
  const payload = authData && authData.payload;
  if (!payload) return { error: fail('unauthorized', 'Sessão expirada. Entre de novo.') };
  if (payload.r !== 'admin') {
    return { error: fail('forbidden', 'Apenas administradores podem usar esta área.') };
  }
  return { payload: payload };
}

export function toAdminUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email || '',
    name: row.name || '',
    role: row.role === 'admin' ? 'admin' : 'user',
    disabled: asBool(row.disabled),
    createdAt: row.created_at || null,
    lastSignInAt: row.last_sign_in_at || null,
    lastSeenAt: row.last_seen_at || null
  };
}

function likePattern(q) {
  return '%' + String(q || '').replace(/[\\%_]/g, function (c) { return '\\' + c; }).toLowerCase() + '%';
}

export async function listUsers(env, options) {
  const opts = options || {};
  const page = Math.max(1, Number(opts.page) || 1);
  const perPage = Math.min(MAX_PAGE, Math.max(1, Number(opts.perPage) || 25));
  const q = String(opts.q || '').trim().toLowerCase().slice(0, 80);
  const pattern = q ? likePattern(q) : '';
  const offset = (page - 1) * perPage;

  const results = await tx(env, { role: 'admin' }, [
    {
      query:
        "select id, email, name, role, disabled, created_at, last_seen_at, last_sign_in_at " +
        "from app_users where ($1 = '' or lower(email) like $1 or lower(name) like $1) " +
        "order by created_at asc limit $2 offset $3",
      params: [pattern, perPage, offset]
    },
    {
      query: "select count(*)::int as total from app_users where ($1 = '' or lower(email) like $1 or lower(name) like $1)",
      params: [pattern]
    }
  ]);

  const rows = results[0] ? results[0].rows : [];
  const totalRow = results[1] && results[1].rows ? results[1].rows[0] : null;
  return {
    users: rows.map(toAdminUser),
    total: totalRow ? Number(totalRow.total) : rows.length,
    page: page,
    perPage: perPage
  };
}

export async function getUser(env, id) {
  if (!isUuid(id)) return null;
  const row = await one(env, { role: 'admin' },
    'select id, email, name, role, disabled, created_at, last_seen_at, last_sign_in_at from app_users where id = $1', [id]);
  return toAdminUser(row);
}

export async function countActiveAdmins(env) {
  const row = await one(env, { role: 'admin' },
    "select count(*)::int as n from app_users where role = 'admin' and disabled = false");
  return row ? Number(row.n) : 0;
}

export async function createUser(env, input) {
  const rows = await query(env, { role: 'admin' },
    'insert into app_users (email, name, role, password_hash) values (lower($1), $2, $3, public.hash_password($4)) ' +
    'returning id, email, name, role, disabled, created_at, last_seen_at, last_sign_in_at',
    [input.email, input.name, input.role, input.password]);
  return toAdminUser(rows[0]);
}

export async function updateUser(env, id, fields) {
  const sets = [];
  const params = [];
  let i = 1;
  if (fields.name !== undefined) { sets.push('name = $' + (i++)); params.push(fields.name); }
  if (fields.role !== undefined) { sets.push('role = $' + (i++)); params.push(fields.role); }
  if (fields.disabled !== undefined) { sets.push('disabled = $' + (i++)); params.push(!!fields.disabled); }
  if (fields.password !== undefined) { sets.push('password_hash = public.hash_password($' + (i++) + ')'); params.push(fields.password); }
  if (!sets.length) return getUser(env, id);
  sets.push('updated_at = now()');
  params.push(id);
  const rows = await query(env, { role: 'admin' },
    'update app_users set ' + sets.join(', ') + ' where id = $' + i +
    ' returning id, email, name, role, disabled, created_at, last_seen_at, last_sign_in_at', params);
  return toAdminUser(rows[0]);
}

export async function deleteUser(env, id) {
  const rows = await query(env, { role: 'admin' }, 'delete from app_users where id = $1 returning id', [id]);
  return rows.length > 0;
}

export async function listAudit(env, limit) {
  const rows = await query(env, { role: 'admin' },
    'select id, actor_id, actor_email, action, target_id, target_email, detail, at ' +
    'from admin_audit order by at desc limit $1', [Math.min(200, Math.max(1, Number(limit) || 50))]);
  return rows;
}

export async function writeAudit(env, entry) {
  try {
    await query(env, { role: 'admin' },
      'insert into admin_audit (actor_id, actor_email, action, target_id, target_email, detail) ' +
      'values ($1,$2,$3,$4,$5,$6)',
      [
        entry.actorId || null,
        entry.actorEmail || '',
        entry.action,
        entry.targetId || null,
        entry.targetEmail || '',
        JSON.stringify(entry.detail || {})
      ]);
    return true;
  } catch (e) {
    return false;
  }
}

export function auditMessage(err) {
  const code = errorCode(err);
  if (code === 'conflict') return 'Já existe uma conta com este e-mail.';
  if (code === 'forbidden') return 'O banco recusou a operação para este contexto.';
  if (code === 'invalid_input') return 'Os dados não respeitam as regras do banco.';
  return 'Não foi possível concluir a operação no banco.';
}

/* Exportado para os testes de unidade das regras. */
export { cleanText };
