/* GET /api/admin/audit?limit=50 — últimos eventos administrativos. */

import { fail, json, defaultMessage, methodNotAllowed } from '../../_lib/http.js';
import { config as dbConfig } from '../../_lib/db.js';
import { requireAdmin, listAudit } from '../../_lib/admin.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return methodNotAllowed('GET');

  const guard = requireAdmin(context);
  if (guard.error) return guard.error;
  if (!dbConfig(env).configured) return fail('not_configured', 'Banco não configurado neste servidor.');

  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));

  try {
    const events = await listAudit(env, limit);
    return json({ events: events });
  } catch (e) {
    return fail('upstream_error', defaultMessage('upstream_error'));
  }
}
