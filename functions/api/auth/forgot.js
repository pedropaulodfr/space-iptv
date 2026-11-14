/* POST /api/auth/forgot — recuperação de senha.
 *
 * O Space IPTV no Neon não tem provedor de e-mail: a recuperação é feita pelo
 * administrador (tela de Administração → Redefinir senha), que devolve uma senha
 * temporária exibida uma única vez. O endpoint é honesto e responde 503
 * not_configured; /api/auth/capabilities informa recovery:false e a tela de
 * login esconde o link. */

import { fail, methodNotAllowed } from '../../_lib/http.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') return methodNotAllowed('POST');
  return fail(
    'not_configured',
    'A recuperação por e-mail não está disponível. Peça ao administrador para redefinir sua senha.',
    503
  );
}
