/* Sessão do Space IPTV: token de acesso assinado + refresh opaco no Postgres.
 *
 *  sp_at  -> token HMAC (15 min), verificado localmente no edge, sem banco.
 *  sp_rt  -> token aleatório (30 dias); o banco guarda só o SHA-256, em
 *            app_sessions. É ele que permite revogar de verdade.
 */

import { COOKIE_AT, COOKIE_RT, cookie } from './http.js';
import { signToken, randomToken, sha256Hex } from './token.js';
import { query, one } from './db.js';

export const AT_TTL = 900;                  /* 15 min */
export const RT_TTL = 30 * 24 * 60 * 60;    /* 30 dias */

export function userFromPayload(payload) {
  if (!payload) return null;
  return { id: payload.u, role: payload.r === 'admin' ? 'admin' : 'user' };
}

export function authFromContext(context) {
  return (context && context.data && context.data.auth) || null;
}

export function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email || '',
    name: row.name || '',
    role: row.role === 'admin' ? 'admin' : 'user'
  };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function cookieHeader(name, value, maxAge, secure) {
  return cookie(name, value, { maxAge: maxAge, secure: secure });
}

/* Cria a sessão no banco e devolve tokens + cookies prontos. */
export async function createSession(env, user, request, secure) {
  const refreshToken = randomToken(32);
  const tokenHash = await sha256Hex(refreshToken);
  const expiresAt = new Date(Date.now() + RT_TTL * 1000).toISOString();
  const ua = (request && request.headers.get('User-Agent')) || '';

  const rows = await query(env, { role: 'auth' }, 
    'insert into app_sessions (user_id, token_hash, expires_at, user_agent) values ($1,$2,$3,$4) returning id',
    [user.id, tokenHash, expiresAt, String(ua).slice(0, 300)]);
  const sid = rows[0] && rows[0].id;
  if (!sid) throw new Error('session_not_created');

  const accessToken = await signToken({ u: user.id, r: user.role, s: sid, e: nowSeconds() + AT_TTL }, env.AUTH_SECRET);
  return {
    sid: sid,
    accessToken: accessToken,
    refreshToken: refreshToken,
    cookies: [
      cookieHeader(COOKIE_AT, accessToken, AT_TTL, secure),
      cookieHeader(COOKIE_RT, refreshToken, RT_TTL, secure)
    ]
  };
}

/* Valida o refresh token, gira o token e devolve a sessão renovada.
   Devolve null quando o token não vale mais (revogado, expirado, conta desativada). */
export async function refreshSession(env, refreshToken, request, secure) {
  if (!refreshToken) return null;
  const tokenHash = await sha256Hex(refreshToken);
  const row = await one(env, { role: 'auth' },
    'select s.id as sid, s.expires_at, s.revoked_at, u.id, u.email, u.name, u.role, u.disabled ' +
    'from app_sessions s join app_users u on u.id = s.user_id where s.token_hash = $1', [tokenHash]);
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.disabled === true || row.disabled === 't') return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;

  const user = userFromRow(row);
  const nextRefresh = randomToken(32);
  const nextHash = await sha256Hex(nextRefresh);
  const updated = await query(env, { role: 'auth' },
    'update app_sessions set token_hash = $2, last_used_at = now() where id = $1 and revoked_at is null returning id',
    [row.sid, nextHash]);
  if (!updated.length) return null;

  const accessToken = await signToken({ u: user.id, r: user.role, s: row.sid, e: nowSeconds() + AT_TTL }, env.AUTH_SECRET);
  return {
    user: user,
    sid: row.sid,
    accessToken: accessToken,
    refreshToken: nextRefresh,
    cookies: [
      cookieHeader(COOKIE_AT, accessToken, AT_TTL, secure),
      cookieHeader(COOKIE_RT, nextRefresh, RT_TTL, secure)
    ]
  };
}

/* Revoga a sessão do refresh token (logout). Idempotente. */
export async function revokeSession(env, refreshToken) {
  if (!refreshToken) return false;
  const tokenHash = await sha256Hex(refreshToken);
  const rows = await query(env, { role: 'auth' },
    'update app_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null returning id',
    [tokenHash]);
  return rows.length > 0;
}

/* Revoga todas as sessões de um usuário (troca de senha, desativação, exclusão). */
export async function revokeAllSessions(env, userId) {
  await query(env, { role: 'auth' },
    'update app_sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
}

/* Perfil do usuário logado (email/nome/papel) + marca de último acesso. */
export async function loadProfile(env, userId, touch) {
  const rows = await query(env, { uid: userId, role: 'user' },
    'update app_users set last_seen_at = now() where id = $1 returning id, email, name, role, last_seen_at', [userId]);
  if (rows.length) return userFromRow(rows[0]);
  if (!touch) return null;
  const row = await one(env, { uid: userId, role: 'user' },
    'select id, email, name, role from app_users where id = $1', [userId]);
  return userFromRow(row);
}
