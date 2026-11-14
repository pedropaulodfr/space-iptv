/* /media-proxy — repetidor de mídia para contornar mixed content/CORS no navegador.
 *
 * O navegador fala apenas HTTPS com o mesmo host do app; a Function busca a
 * origem (HTTP ou HTTPS) e devolve bytes. Isso resolve o caso de listas que
 * entregam streams http:// ou com certificado autoassinado, sem expor um proxy
 * aberto:
 *   - exige sessão válida (o middleware já bloqueia, e conferimos de novo);
 *   - só aceita hosts da variável MEDIA_PROXY_HOSTS;
 *   - só GET/HEAD, http/https, sem credenciais na URL;
 *   - repassa Range e faz streaming (não carrega o arquivo inteiro);
 *   - reescreve playlists HLS (URI, KEY, MAP, MEDIA) para o próprio proxy.
 *
 * Não registra a URL/query completa. Não repassa cookies do navegador.
 */
import { authFromContext } from './_lib/session.js';

const MAX_URL = 4096;
const MAX_PLAYLIST = 8 * 1024 * 1024;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

function text(status, message) {
  return new Response(message, {
    status: status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function hosts(env) {
  return String(env.MEDIA_PROXY_HOSTS || '')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
}

function allowedHost(env, hostname) {
  const list = hosts(env);
  const host = String(hostname || '').toLowerCase();
  return list.some(function (h) { return host === h || host.slice(-(h.length + 1)) === '.' + h; });
}

function passHeaders(upstream, includeLength) {
  const h = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) h.set('Content-Type', ct);
  if (includeLength) {
    const len = upstream.headers.get('content-length');
    if (len && /^\d+$/.test(len)) h.set('Content-Length', len);
  }
  const cr = upstream.headers.get('content-range');
  if (cr) h.set('Content-Range', cr);
  const ar = upstream.headers.get('accept-ranges');
  if (ar) h.set('Accept-Ranges', ar);
  const etag = upstream.headers.get('etag');
  if (etag) h.set('ETag', etag);
  const lm = upstream.headers.get('last-modified');
  if (lm) h.set('Last-Modified', lm);
  h.set('Cache-Control', 'private, max-age=0, no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  return h;
}

function proxyUri(uri, base, appOrigin) {
  if (!uri) return null;
  let abs;
  try { abs = new URL(uri, base); } catch (e) { return null; }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
  return appOrigin + '/media-proxy?url=' + encodeURIComponent(abs.href);
}

/* Reescreve linhas de URI e atributos URI="..." de playlists HLS. */
function rewritePlaylist(body, base, appOrigin) {
  const lines = String(body).replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    let next = line;
    if (trimmed && trimmed.charAt(0) !== '#') {
      const p = proxyUri(trimmed, base, appOrigin);
      if (p) next = p;
    } else if (trimmed.indexOf('#EXT') === 0) {
      next = line.replace(/URI=("([^"]*)"|'([^']*)')/g, function (match, quoted, dq, sq) {
        const p = proxyUri(dq != null ? dq : sq, base, appOrigin);
        return p ? 'URI="' + p + '"' : match;
      });
    }
    out.push(next);
  }
  return out.join('\n');
}

function isPlaylist(contentType, pathname) {
  return /mpegurl|x-mpegurl|vnd\.apple/i.test(contentType || '') || /\.m3u8?$/i.test(pathname || '');
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!authFromContext(context)) return json(401, { error: 'unauthorized' });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(405, { error: 'method_not_allowed' });
  }

  const appOrigin = new URL(request.url).origin;
  const raw = new URL(request.url).searchParams.get('url');
  if (!raw || raw.length > MAX_URL) return text(400, 'Parâmetro url ausente ou inválido.');

  let target;
  try { target = new URL(raw); } catch (e) { return text(400, 'URL inválida.'); }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return text(400, 'Apenas http:// e https://.');
  }
  if (target.username || target.password) return text(400, 'URL com credenciais não é permitida.');
  if (target.pathname.indexOf('/media-proxy') === 0) return text(400, 'Recursão no proxy não é permitida.');
  if (!allowedHost(env, target.hostname)) {
    return text(403, 'Host não autorizado neste proxy. Configure MEDIA_PROXY_HOSTS.');
  }

  const headers = new Headers();
  headers.set('Accept', request.headers.get('Accept') || '*/*');
  headers.set('Accept-Encoding', 'identity');
  headers.set('User-Agent', BROWSER_UA);
  headers.set('Referer', target.origin + '/');
  const range = request.headers.get('Range');
  if (range) headers.set('Range', range);
  const ifRange = request.headers.get('If-Range');
  if (ifRange) headers.set('If-Range', ifRange);

  let upstream;
  try {
    upstream = await fetch(target.href, {
      method: request.method,
      redirect: 'follow',
      headers: headers
    });
  } catch (e) {
    return text(502, 'Não foi possível acessar o servidor de origem.');
  }

  const finalUrl = upstream.url || target.href;
  const final = new URL(finalUrl);
  if (!allowedHost(env, final.hostname)) {
    return text(403, 'Redirecionamento para host não autorizado.');
  }

  if (request.method === 'HEAD' || !upstream.body) {
    return new Response(null, { status: upstream.status, headers: passHeaders(upstream, true) });
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (upstream.status === 200 && isPlaylist(contentType, final.pathname)) {
    const body = await upstream.text();
    if (body.length > MAX_PLAYLIST) return text(502, 'Playlist grande demais.');
    const rewritten = rewritePlaylist(body, finalUrl, appOrigin);
    return new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': String(new TextEncoder().encode(rewritten).length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: passHeaders(upstream, true)
  });
}
