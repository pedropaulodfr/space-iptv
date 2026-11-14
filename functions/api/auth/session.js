/* GET /api/auth/session — quem está logado, segundo o token já validado pelo
   middleware. Aproveita para marcar o último acesso no perfil. */

import { fail, json } from '../../_lib/http.js';
import { loadProfile } from '../../_lib/session.js';

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed', message: 'Método não permitido.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET', 'Cache-Control': 'no-store' }
    });
  }

  const authData = (context.data && context.data.auth) || null;
  if (!authData || !authData.payload) {
    return fail('unauthorized', 'Sessão expirada. Entre de novo.');
  }

  try {
    const user = await loadProfile(context.env, authData.payload.u, true);
    if (!user) return fail('unauthorized', 'Sessão expirada. Entre de novo.');
    return json({ user: user });
  } catch (e) {
    return fail('upstream_error', 'Não foi possível carregar sua conta agora.');
  }
}
