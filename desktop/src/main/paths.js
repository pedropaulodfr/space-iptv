/* Sanitização de nomes e containment de caminhos do Space IPTV Desktop.
 *
 * Regras (CONTRACTS.md §4):
 *  - nada de `..`, separadores ou caracteres inválidos do Windows (`<>:"/\|?*`),
 *    caracteres de controle, nomes reservados (CON, PRN, AUX, NUL, COM1-9, LPT1-9),
 *    pontos/espaços no fim e limite de ~80 caracteres;
 *  - colisão de pasta → sufixo " (2)", " (3)"...;
 *  - todo caminho resolvido precisa continuar DENTRO de `downloadsDir`
 *    (checagem lexical e, quando o alvo existe, também via realpath).
 *
 * Este módulo é puro (exceto as funções de disco `ensureDir`, `freeBytes` e
 * `assertRealInside`) e não depende de Electron, para poder ser testado com `node`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

/** Limite de caracteres de um nome de pasta/arquivo (contrato: ~80). */
const MAX_NAME = 80;
/** Nome usado quando a sanitização não sobra nada útil. */
const FALLBACK_NAME = 'Midia';

/* Nomes especiais do Windows — qualquer extensão ("CON.txt" também é especial). */
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
/* Caracteres proibidos no Windows + controles C0/C1 e DEL. */
const INVALID_CHARS_RE = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g;

class PathError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'PathError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Nomes                                                                      */
/* -------------------------------------------------------------------------- */

/* Corta em `max` sem partir par substituto (emoji no meio de um nome). */
function cutChars(s, max) {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/**
 * Sanitiza um nome de pasta/arquivo (não um caminho relativo).
 * @param {string} raw
 * @param {{max?:number, fallback?:string}} [opts]
 * @returns {string} nome utilizável no Windows, nunca vazio
 */
function sanitizeName(raw, opts) {
  const o = opts || {};
  const max = Number.isFinite(o.max) ? Math.max(8, Math.min(240, Math.floor(o.max))) : MAX_NAME;
  const fallback = sanitizeFallback(o.fallback);

  let s = raw == null ? '' : String(raw);
  /* normalização opcional: preserva acentos (Inter/Orbitron exibem normalmente),
     mas junta espaços estranhos e remove o resto que o Windows recusa. */
  try { s = s.normalize ? s.normalize('NFC') : s; } catch (e) { /* sem normalize */ }
  s = s.replace(INVALID_CHARS_RE, ' ');
  s = s.replace(/[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g, ' ').trim();
  s = s.replace(/^[. ]+/g, '');           /* esconde nomes tipo ".hidden" e ".." */
  s = s.replace(/[. ]+$/g, '');           /* Windows remove pontos/espaços finais */
  if (!s) s = fallback;
  s = cutChars(s, max).replace(/[. ]+$/g, '');
  if (!s) s = fallback;
  if (RESERVED_RE.test(s)) s = '_' + s;
  if (s.length > max) s = cutChars(s, max);
  return s;
}

function sanitizeFallback(fallback) {
  let f = fallback == null ? '' : String(fallback).replace(INVALID_CHARS_RE, ' ').replace(/[. ]+$/g, '').trim();
  if (!f || RESERVED_RE.test(f)) f = FALLBACK_NAME;
  return cutChars(f, MAX_NAME);
}

/** Verdadeiro quando o nome precisa de sanitização (usado em testes e mensagens). */
function needsSanitize(name) {
  return sanitizeName(name) !== String(name == null ? '' : name);
}

/** Prefixo numérico com 2 dígitos (temporada/episódio). */
function pad2(n) {
  const v = Math.max(1, Math.floor(Number(n) || 1));
  return v < 10 ? '0' + v : String(v);
}

/**
 * Aplica sufixo " (n)" respeitando o limite de caracteres.
 * @param {string} base
 * @param {number} n
 * @param {number} [max]
 */
function suffixName(base, n, max) {
  const limit = Number.isFinite(max) ? Math.max(8, Math.floor(max)) : MAX_NAME;
  const suffix = ' (' + n + ')';
  const head = cutChars(String(base == null ? '' : base), Math.max(1, limit - suffix.length)).replace(/[. ]+$/g, '');
  return (head || FALLBACK_NAME) + suffix;
}

/**
 * Escolhe um nome livre dentro de `taken`, com comparação sem diferenciar
 * maiúsculas (Windows). `taken` pode ser array de nomes ou Set.
 * @param {string} base
 * @param {Iterable<string>|Set<string>|string[]} taken
 * @param {{max?:number}} [opts]
 */
function uniqueName(base, taken, opts) {
  const max = opts && Number.isFinite(opts.max) ? Math.max(8, Math.floor(opts.max)) : MAX_NAME;
  const used = new Set();
  if (taken) {
    if (typeof taken[Symbol.iterator] === 'function') {
      for (const name of taken) used.add(String(name).toLowerCase());
    }
  }
  const first = truncateWithSanitize(base, max);
  let candidate = first;
  let n = 1;
  while (used.has(candidate.toLowerCase())) {
    n++;
    candidate = suffixName(first, n, max);
  }
  return candidate;
}

function truncateWithSanitize(base, max) {
  const s = sanitizeName(base, { max });
  return s;
}

/**
 * Nome da pasta de um item baixado (uma entrada por filme/episódio).
 * @param {{kind?:string, title?:string, seriesTitle?:string, year?:string|number,
 *          season?:number, episode?:number, episodeTitle?:string}} item
 * @param {Iterable<string>|Set<string>|string[]} [taken]
 */
function buildDirName(item, taken) {
  const it = item || {};
  const isEpisode = String(it.kind || 'movie') === 'episode';
  const title = sanitizeName(it.title || it.seriesTitle || 'Item', { max: 66 });
  const year = /^(19|20)\d{2}$/.test(String(it.year == null ? '' : it.year).trim())
    ? String(it.year).trim().slice(0, 4)
    : '';
  let base;
  if (isEpisode) {
    base = title + (year ? ' (' + year + ')' : '') + ' - T' + pad2(it.season) + 'E' + pad2(it.episode);
    if (it.episodeTitle) base += ' - ' + sanitizeName(it.episodeTitle, { max: 36 });
  } else {
    base = title + (year ? ' (' + year + ')' : '');
  }
  return uniqueName(base, taken, { max: MAX_NAME });
}

/* -------------------------------------------------------------------------- */
/* Containment                                                                */
/* -------------------------------------------------------------------------- */

/** Resolve `base` e `target` (lexical) e testa se `target` é descendente estrito. */
function isInside(base, target) {
  if (typeof base !== 'string' || typeof target !== 'string' || !base || !target) return false;
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return !!rel && !path.isAbsolute(rel) && rel !== '..' && rel.slice(0, 3) !== '..' + path.sep;
}

/** Igual a isInside, mas aceita `target` == `base`. */
function contains(base, target) {
  if (typeof base !== 'string' || typeof target !== 'string' || !base || !target) return false;
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && rel.slice(0, 3) !== '..' + path.sep);
}

/**
 * Valida um caminho relativo (com separador `/`) para uso em manifesto/rota
 * `/offline/<id>/<rel>`. Rejeita: vazio, absoluto, `..`/`.`, unidade (`:`),
 * `\`, NUL, segmentos com ponto/espaço no fim e extensão exótica aceita.
 * @param {string} rel
 * @returns {string} caminho normalizado (sempre com `/`)
 * @throws {PathError}
 */
function normalizeRelPath(rel) {
  if (typeof rel !== 'string' || !rel) throw new PathError('PATH_INVALID', 'Caminho vazio.');
  if (rel.length > 1024) throw new PathError('PATH_INVALID', 'Caminho grande demais.');
  if (rel.indexOf('\0') >= 0) throw new PathError('PATH_INVALID', 'Caminho inválido.');
  /* manifestos/rotas usam sempre "/" e caminho relativo: nada de barra invertida,
     caminho absoluto, unidade Windows, "./" ou ".." em NENHUMA posição. */
  if (rel.indexOf('\\') >= 0) throw new PathError('PATH_TRAVERSAL', 'Caminho inválido.');
  if (rel.charAt(0) === '/') throw new PathError('PATH_TRAVERSAL', 'Caminho inválido.');
  if (/^[A-Za-z]:/.test(rel)) throw new PathError('PATH_TRAVERSAL', 'Caminho inválido.');
  const parts = rel.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw new PathError('PATH_TRAVERSAL', 'Caminho inválido.');
    if (part.indexOf(':') >= 0) throw new PathError('PATH_TRAVERSAL', 'Caminho inválido.');
    if (part.indexOf('\0') >= 0) throw new PathError('PATH_INVALID', 'Caminho inválido.');
    if (/[. ]$/.test(part)) throw new PathError('PATH_TRAVERSAL', 'Caminho inválido.');
    if (part.length > 180) throw new PathError('PATH_INVALID', 'Nome grande demais.');
    if (/[<>"|?*]/.test(part)) throw new PathError('PATH_TRAVERSAL', 'Caminho inválido.');
  }
  return parts.join('/');
}

/** Verdadeiro quando `rel` é um caminho relativo seguro (ver normalizeRelPath). */
function isSafeRelPath(rel) {
  try {
    normalizeRelPath(rel);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Resolve `rel` dentro de `base`; lança se escapar (lexicalmente).
 * @param {string} base
 * @param {string} rel
 * @returns {string} caminho absoluto
 * @throws {PathError}
 */
function resolveInside(base, rel) {
  if (typeof base !== 'string' || !base) throw new PathError('PATH_INVALID', 'Pasta-base inválida.');
  const clean = normalizeRelPath(rel);
  const target = path.resolve(base, clean.split('/').join(path.sep));
  if (!isInside(base, target)) throw new PathError('PATH_TRAVERSAL', 'Caminho fora da pasta de downloads.');
  return target;
}

/**
 * Garante que `target` (que deve existir) continua dentro de `base` também
 * depois de resolver symlinks/junctions (realpath).
 * @param {string} base
 * @param {string} target
 * @returns {Promise<string>} realpath de target
 * @throws {PathError}
 */
async function assertRealInside(base, target) {
  let realBase;
  let realTarget;
  try {
    realBase = await fsp.realpath(base);
  } catch (e) {
    throw new PathError('PATH_INVALID', 'Pasta de downloads não encontrada.');
  }
  try {
    realTarget = await fsp.realpath(target);
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new PathError('PATH_NOT_FOUND', 'Arquivo não encontrado.');
    throw new PathError('PATH_INVALID', 'Não foi possível validar o caminho.');
  }
  if (!contains(realBase, realTarget)) {
    throw new PathError('PATH_TRAVERSAL', 'Caminho fora da pasta de downloads.');
  }
  return realTarget;
}

/**
 * Resolve a pasta de um item (`downloadsDir/<dirName>`) validando containment.
 * Não cria nada em disco.
 * @param {string} downloadsDir
 * @param {string} dirName
 * @returns {string}
 * @throws {PathError}
 */
function itemDir(downloadsDir, dirName) {
  const clean = sanitizeName(dirName, { max: MAX_NAME });
  if (clean !== String(dirName == null ? '' : dirName)) {
    throw new PathError('PATH_INVALID', 'Nome de pasta inválido.');
  }
  return resolveInside(downloadsDir, clean);
}

/* -------------------------------------------------------------------------- */
/* Disco                                                                      */
/* -------------------------------------------------------------------------- */

/** Cria a pasta (recursivo) e devolve o caminho absoluto. */
async function ensureDir(dir) {
  if (typeof dir !== 'string' || !dir) throw new PathError('PATH_INVALID', 'Pasta inválida.');
  await fsp.mkdir(dir, { recursive: true });
  return path.resolve(dir);
}

/**
 * Espaço livre em bytes na unidade de `dir` (null quando o SO/Node não informa).
 * Lança ENOENT se a pasta não existir (quem chama garante que existe).
 * @param {string} dir
 * @returns {Promise<number|null>}
 */
async function freeBytes(dir) {
  if (typeof fsp.statfs !== 'function') return null;
  let st;
  try {
    st = await fsp.statfs(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') throw e;
    return null;
  }
  const bsize = Number(st.bsize);
  const avail = Number(st.bavail != null ? st.bavail : st.bfree);
  if (!Number.isFinite(bsize) || !Number.isFinite(avail) || bsize <= 0) return null;
  return bsize * avail;
}

/* -------------------------------------------------------------------------- */
/* Utilidades de exibição (mensagens do main em pt-BR)                        */
/* -------------------------------------------------------------------------- */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Formata bytes em pt-BR ("1,2 GB"). */
function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '—';
  if (v < 1024) return Math.round(v) + ' B';
  let value = v;
  let i = 0;
  while (value >= 1024 && i < UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 1;
  return value.toFixed(digits).replace('.', ',') + ' ' + UNITS[i];
}

/**
 * Redige uma URL para log/mensagem: mantém só a origem.
 * Nunca use a URL crua em log (credenciais Xtream ficam no caminho).
 */
function redactUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol + '//' + u.host + '/...';
  } catch (e) {
    return '(url inválida)';
  }
}

/** Extensão em minúsculas, sem o ponto ('' quando não há). */
function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name == null ? '' : name).split('?')[0].split('#')[0]);
  return m ? m[1].toLowerCase() : '';
}

module.exports = {
  MAX_NAME,
  FALLBACK_NAME,
  PathError,
  sanitizeName,
  needsSanitize,
  uniqueName,
  suffixName,
  buildDirName,
  pad2,
  isInside,
  contains,
  normalizeRelPath,
  isSafeRelPath,
  resolveInside,
  assertRealInside,
  itemDir,
  ensureDir,
  freeBytes,
  formatBytes,
  redactUrl,
  extOf
};
