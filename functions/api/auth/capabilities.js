/* GET /api/auth/capabilities — o que a tela de login pode mostrar.
 *
 * `recovery` é sempre false neste servidor: não há SMTP, a recuperação é o reset
 * pelo administrador. `signup` é sempre false: cadastro público desligado, só o
 * admin cria conta. */

import { json, methodNotAllowed } from '../../_lib/http.js';

export async function onRequest(context) {
  if (context.request.method !== 'GET') return methodNotAllowed('GET');
  return json({ recovery: false, signup: false });
}
