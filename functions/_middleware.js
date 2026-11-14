/* Gate do Space IPTV no edge (Cloudflare Pages Functions).
 *
 * Toda requisição que chega aqui (/, /index.html, /login.html, /api/*) passa por:
 *   1. checagem de CSRF (Origin/Sec-Fetch-Site) nos métodos que escrevem;
 *   2. verificação LOCAL do token de acesso (HMAC, sem banco por requisição);
 *   3. refresh pelo cookie opaco quando o acesso expirou (1 tentativa, com giro);
 *   4. redirect para /login.html quando não há sessão, 401 em /api/*;
 *   5. resposta decorada com no-store, Vary: Cookie e CSP.
 *
 * Os dois cookies são HttpOnly: nenhum token chega ao JavaScript da página.
 */

import {
  COOKIE_AT, COOKIE_RT, fail, text, parseCookies, safeNext, isSecureRequest,
  clearCookie, appendCookies, baseHeaders, CSP
} from './_lib/http.js';
import { config as dbConfig } from './_lib/db.js';
import { verifyToken, hasSecret } from './_lib/token.js';
import { refreshSession } from './_lib/session.js';

const PUBLIC_PATHS = [
  '/login.html',
  '/web/css/login.css',
  '/web/js/login.js',
  '/favicon.ico',
  '/robots.txt',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/forgot',
  '/api/auth/capabilities'
];

function normalizePath(pathname) {
  let p = String(pathname || '/');
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
  return p || '/';
}

function isPublic(path) {
  for (let i = 0; i < PUBLIC_PATHS.length; i++) if (PUBLIC_PATHS[i] === path) return true;
  return false;
}

function isApi(path) {
  return path === '/api' || path.indexOf('/api/') === 0;
}

function isPageRequest(request, path) {
  if (path === '/' || path === '/index.html') return true;
  if (/\.html$/i.test(path)) return true;
  const accept = request.headers.get('Accept') || '';
  return accept.toLowerCase().indexOf('text/html') >= 0;
}

/* CSRF: SameSite=Lax é a primeira defesa; aqui recusamos origem diferente.
   Requisições sem Origin (curl, teste) seguem — quem protege é o cookie SameSite
   e a ausência de CORS na API. */
function csrfOk(request) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  let self = '';
  try { self = new URL(request.url).origin; } catch (e) { return false; }
  const origin = request.headers.get('Origin');
  if (origin) {
    if (origin === self) return true;
    return false;
  }
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

function redirect(location, cookies) {
  const headers = baseHeaders();
  headers.set('Location', location);
  return appendCookies(new Response(null, { status: 302, headers: headers }), cookies || []);
}

function withEdgeHeaders(response, options) {
  const headers = new Headers(response.headers);
  if (options && options.noStore) {
    headers.set('Cache-Control', 'no-store');
    headers.append('Vary', 'Cookie');
  }
  const type = headers.get('Content-Type') || '';
  if (options && options.csp && type.toLowerCase().indexOf('text/html') >= 0) {
    headers.set('Content-Security-Policy', CSP);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);
  const secure = isSecureRequest(request);

  /* 1. CSRF antes de qualquer coisa que escreve. */
  if (isApi(path) && !csrfOk(request)) {
    return fail('forbidden', 'Origem não permitida para esta requisição.', 403);
  }

  /* Sem configuração não há como autenticar: falha explícita nas rotas de API. */
  if (isApi(path) && (!hasSecret(env) || !dbConfig(env).configured) && !isPublic(path)) {
    return fail('not_configured', 'Servidor sem configuração de banco/segredo. Fale com o administrador.', 503);
  }

  const cookies = parseCookies(request);
  const accessToken = cookies[COOKIE_AT] || '';
  const refreshToken = cookies[COOKIE_RT] || '';
  let setCookies = [];
  let payload = null;

  if (accessToken && hasSecret(env)) {
    payload = await verifyToken(accessToken, env.AUTH_SECRET);
  }

  /* 3. Access token expirado/ausente: tenta UMA vez o refresh token. */
  if (!payload && refreshToken && hasSecret(env) && dbConfig(env).configured) {
    let refreshed = null;
    try {
      refreshed = await refreshSession(env, refreshToken, request, secure);
    } catch (e) {
      refreshed = null;
    }
    if (refreshed) {
      payload = await verifyToken(refreshed.accessToken, env.AUTH_SECRET);
      setCookies = refreshed.cookies || [];
    } else {
      setCookies = [clearCookie(COOKIE_AT, secure), clearCookie(COOKIE_RT, secure)];
    }
  }

  /* 5. Logado tentando ver o login: manda para o app. */
  if (payload && path === '/login.html') {
    return redirect(safeNext(url.searchParams.get('next')), setCookies);
  }

  /* 2. Públicos: seguem direto (o login precisa funcionar sem sessão). */
  if (isPublic(path)) {
    const response = await next();
    return appendCookies(withEdgeHeaders(response, { noStore: true, csp: true }), setCookies);
  }

  if (!payload) {
    if (isApi(path)) {
      return appendCookies(fail('unauthorized', 'Sessão expirada. Entre de novo.'), setCookies);
    }
    if (isPageRequest(request, path)) {
      const wanted = path + (url.search || '');
      return redirect('/login.html?next=' + encodeURIComponent(safeNext(wanted)), setCookies);
    }
    return appendCookies(text('Não autorizado.', 401), setCookies);
  }

  /* 4. Sessão válida: a rota recebe a identidade vinda do token (nunca do corpo). */
  context.data = context.data || {};
  context.data.auth = { payload: payload, token: accessToken };

  const response = await next();
  return appendCookies(withEdgeHeaders(response, { noStore: true, csp: true }), setCookies);
}
