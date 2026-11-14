/* /media-proxy/ping — detecta o proxy de mídia sem expor a origem. */
import { authFromContext } from '../_lib/session.js';

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export async function onRequest(context) {
  if (!authFromContext(context)) return json(401, { ok: false, error: 'unauthorized' });
  if (context.request.method !== 'GET') return json(405, { ok: false, error: 'method_not_allowed' });
  const hosts = String(context.env.MEDIA_PROXY_HOSTS || '')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
  return json(200, { ok: true, proxy: 'cloudflare-pages', version: '1.0.0', hosts: hosts });
}
