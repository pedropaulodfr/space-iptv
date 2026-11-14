/* POST /api/auth/logout — revoga a sessão (refresh token) e apaga os cookies.
   Idempotente: sem sessão também responde 204. */

import { parseCookies, isSecureRequest, clearCookie, appendCookies, COOKIE_AT, COOKIE_RT } from '../../_lib/http.js';
import { config as dbConfig } from '../../_lib/db.js';
import { revokeSession } from '../../_lib/session.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed', message: 'Método não permitido.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST', 'Cache-Control': 'no-store' }
    });
  }

  const secure = isSecureRequest(request);
  const cookies = parseCookies(request);

  if (cookies[COOKIE_RT] && dbConfig(env).configured) {
    try { await revokeSession(env, cookies[COOKIE_RT]); } catch (e) { /* logout local mesmo assim */ }
  }

  const cleared = appendCookies(new Response(null, { status: 204 }), [
    clearCookie(COOKIE_AT, secure),
    clearCookie(COOKIE_RT, secure)
  ]);
  const headers = new Headers(cleared.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Vary', 'Cookie');
  return new Response(null, { status: 204, headers: headers });
}
