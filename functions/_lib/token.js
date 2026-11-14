/* Token de acesso assinado (HMAC-SHA256) e utilitários de sessão.
 *
 * Formato: v1.<payload-base64url>.<assinatura-base64url>
 * Payload: { u: <user id>, r: <role>, s: <session id>, e: <exp unix>, i: <iat> }
 *
 * A verificação é local (WebCrypto), sem banco por requisição. A revogação de
 * verdade fica no refresh token, que é opaco e checado em app_sessions.
 */

const MAX_TOKEN = 4096;

function b64urlEncode(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  let s = String(text || '');
  if (!s || /[^A-Za-z0-9_-]/.test(s)) return null;
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    return null;
  }
}

function enc(text) { return new TextEncoder().encode(text); }

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function hasSecret(env) {
  return typeof (env && env.AUTH_SECRET) === 'string' && env.AUTH_SECRET.length >= 32;
}

export async function signToken(payload, secret, now) {
  const seconds = Math.floor((typeof now === 'number' ? now : Date.now()) / 1000);
  const body = Object.assign({}, payload, { i: seconds });
  const encoded = b64urlEncode(enc(JSON.stringify(body)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc('v1.' + encoded));
  return 'v1.' + encoded + '.' + b64urlEncode(sig);
}

export async function verifyToken(token, secret, now) {
  const raw = String(token || '');
  if (!raw || raw.length > MAX_TOKEN) return null;
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const payloadBytes = b64urlDecode(parts[1]);
  const sig = b64urlDecode(parts[2]);
  if (!payloadBytes || !sig) return null;
  let ok = false;
  try {
    const key = await hmacKey(secret);
    ok = await crypto.subtle.verify('HMAC', key, sig, enc('v1.' + parts[1]));
  } catch (e) {
    ok = false;
  }
  if (!ok) return null;
  let payload = null;
  try { payload = JSON.parse(new TextDecoder().decode(payloadBytes)); } catch (e) { return null; }
  if (!payload || typeof payload.u !== 'string' || !payload.u) return null;
  const seconds = Math.floor((typeof now === 'number' ? now : Date.now()) / 1000);
  if (typeof payload.e !== 'number' || payload.e <= seconds) return null;
  if (payload.r !== 'admin' && payload.r !== 'user') return null;
  return payload;
}

/* Hash do refresh token: o banco guarda só o SHA-256, nunca o token. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc(String(text)));
  const arr = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += (arr[i] + 0x100).toString(16).slice(1);
  return out;
}

/* Token opaco de 32 bytes (base64url) para o cookie de refresh. */
export function randomToken(bytes) {
  const arr = new Uint8Array(bytes || 32);
  crypto.getRandomValues(arr);
  return b64urlEncode(arr);
}
