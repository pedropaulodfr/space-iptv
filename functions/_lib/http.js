/* Utilidades HTTP das Pages Functions: JSON, erros, cookies, headers e validacao
   de "next". Sem dependencias e sem estado mutavel compartilhado. */

export const COOKIE_AT = 'sp_at';
export const COOKIE_RT = 'sp_rt';

/* Codigos de erro do contrato (secao 6 do PROMPT-LOGIN-ADMIN). */
const STATUS = {
  unauthorized: 401,
  forbidden: 403,
  invalid_credentials: 401,
  rate_limited: 429,
  account_disabled: 403,
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  upstream_error: 502,
  not_configured: 503,
  method_not_allowed: 405
};

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};

/* Mantenha igual a web/_headers (o HTML autenticado passa por context.next() e
   recebe estes headers do middleware; os estaticos recebem pelo _headers). */
export const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self'",
  "connect-src 'self' blob: data: https: http:",
  "media-src 'self' blob: data: https: http:",
  "worker-src 'self' blob:"
].join('; ');

export function baseHeaders(extra) {
  const h = new Headers();
  h.set('Cache-Control', 'no-store');
  h.set('Vary', 'Cookie');
  for (const name in SECURITY_HEADERS) h.set(name, SECURITY_HEADERS[name]);
  if (extra) for (const name in extra) h.set(name, extra[name]);
  return h;
}

export function json(data, status, extra) {
  const h = baseHeaders(extra);
  h.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data == null ? {} : data), { status: status || 200, headers: h });
}

export function text(body, status, extra) {
  const h = baseHeaders(extra);
  h.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(String(body == null ? '' : body), { status: status || 200, headers: h });
}

/* Erro do contrato: { error: "<code>", message: "<texto pt-BR>" }. */
export function fail(code, message, statusOverride, extra) {
  const status = statusOverride || STATUS[code] || 500;
  return json({ error: code, message: message || defaultMessage(code) }, status, extra);
}

export function defaultMessage(code) {
  switch (code) {
    case 'unauthorized': return 'Sessão expirada. Entre de novo.';
    case 'forbidden': return 'Você não tem permissão para esta ação.';
    case 'invalid_credentials': return 'E-mail ou senha inválidos.';
    case 'rate_limited': return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    case 'account_disabled': return 'Esta conta está desativada.';
    case 'invalid_input': return 'Dados inválidos.';
    case 'not_found': return 'Não encontrado.';
    case 'conflict': return 'A operação conflita com o estado atual.';
    case 'payload_too_large': return 'Requisição grande demais.';
    case 'upstream_error': return 'O serviço de autenticação não respondeu. Tente de novo.';
    case 'not_configured': return 'Recurso não configurado neste servidor.';
    case 'method_not_allowed': return 'Método não permitido.';
    default: return 'Erro inesperado.';
  }
}

export function methodNotAllowed(allowed) {
  return fail('method_not_allowed', 'Método não permitido.', 405, { Allow: allowed });
}

/* ---------- cookies ---------- */

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('Cookie') || '';
  if (!raw) return out;
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || out[name] !== undefined) continue;
    let value = part.slice(eq + 1).trim();
    if (value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') value = value.slice(1, -1);
    try { out[name] = decodeURIComponent(value); } catch (e) { out[name] = value; }
  }
  return out;
}

/* Cookie de sessao. Secure so em https (localhost em http continua funcionando). */
export function cookie(name, value, opts) {
  const o = opts || {};
  const parts = [name + '=' + encodeURIComponent(value)];
  parts.push('Path=' + (o.path || '/'));
  parts.push('HttpOnly');
  parts.push('SameSite=' + (o.sameSite || 'Lax'));
  if (o.secure) parts.push('Secure');
  if (typeof o.maxAge === 'number') parts.push('Max-Age=' + Math.max(0, Math.floor(o.maxAge)));
  if (o.expires) parts.push('Expires=' + new Date(o.expires).toUTCString());
  return parts.join('; ');
}

export function clearCookie(name, secure) {
  return cookie(name, '', { maxAge: 0, secure: secure });
}

export function isSecureRequest(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch (e) {
    return false;
  }
}

export function appendCookies(response, cookies) {
  if (!cookies || !cookies.length) return response;
  const headers = new Headers(response.headers);
  for (let i = 0; i < cookies.length; i++) headers.append('Set-Cookie', cookies[i]);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: headers });
}

/* ---------- corpo ---------- */

export async function readJson(request, limit) {
  const max = limit || 64 * 1024;
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > max) return { ok: false, code: 'payload_too_large' };
  let raw;
  try { raw = await request.text(); } catch (e) { return { ok: false, code: 'invalid_input' }; }
  if (raw.length > max) return { ok: false, code: 'payload_too_large' };
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'invalid_input' };
    return { ok: true, value: value };
  } catch (e) {
    return { ok: false, code: 'invalid_input' };
  }
}

/* ---------- validacao ---------- */

/* `next` so aceita caminho relativo do proprio site (sem open redirect). */
export function safeNext(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 300) return '/';
  if (s.charAt(0) !== '/') return '/';
  if (s.indexOf('//') === 0) return '/';
  if (s.indexOf('\\') >= 0) return '/';
  if (/[\u0000-\u001f\u007f]/.test(s)) return '/';
  let decoded;
  try { decoded = decodeURIComponent(s); } catch (e) { return '/'; }
  if (decoded.charAt(0) !== '/' || decoded.indexOf('//') === 0) return '/';
  if (decoded.indexOf('\\') >= 0) return '/';
  if (/^\/(?:[a-z][a-z0-9+.-]*:|\/)/i.test(decoded)) return '/';
  return s;
}

export function isEmail(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s.length < 5 || s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/* Senha temporaria forte: 16 caracteres, sem ambiguidade (0/O, 1/l/I). */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*-_+';

export function tempPassword(size) {
  const len = size || 16;
  const pool = PASSWORD_ALPHABET;
  /* 256 - (256 % 54) = 216: descarta o resto para o sorteio nao ficar enviesado */
  const limit = 256 - (256 % pool.length);
  const out = [];
  while (out.length < len) {
    const bytes = new Uint8Array(len * 2);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && out.length < len; i++) {
      if (bytes[i] < limit) out.push(pool.charAt(bytes[i] % pool.length));
    }
  }
  return out.join('');
}
