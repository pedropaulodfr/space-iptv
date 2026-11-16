/* Manifestos JSON atômicos e índice da biblioteca offline do Space IPTV Desktop.
 *
 * Layout (CONTRACTS.md §4):
 *   <downloadsDir>/.space-iptv/index.json       índice (versão + lista de itens)
 *   <downloadsDir>/.space-iptv/index.json.bak   cópia anterior (recuperação)
 *   <downloadsDir>/<slug>/manifest.json         manifesto do item
 *
 * Garantias:
 *  - escrita sempre `.tmp` + fsync + rename (nunca deixa JSON pela metade);
 *  - leitura tolerante: um manifesto corrompido não derruba a biblioteca;
 *    índice corrompido cai para o `.bak` e, em último caso, é reconstruído
 *    varrendo as pastas de itens;
 *  - remoção só de pastas gerenciadas dentro de `downloadsDir` (containment
 *    lexical + realpath, sem seguir junction/symlink para fora).
 *
 * Sem Electron e sem dependências externas: testável com `node --test`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const paths = require('./paths');

const fsp = fs.promises;

const VERSION = 1;
const INDEX_DIR = '.space-iptv';
const INDEX_FILE = 'index.json';
const INDEX_BAK = 'index.json.bak';
const MANIFEST_FILE = 'manifest.json';
const INDEX_MAX_BYTES = 32 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

const STATUSES = ['queued', 'downloading', 'paused', 'packaging', 'done', 'error', 'canceled'];
const KINDS = ['movie', 'episode'];
const ENGINES = ['mp4', 'hls'];

/* -------------------------------------------------------------------------- */
/* Escrita atômica                                                            */
/* -------------------------------------------------------------------------- */

function tmpPathFor(file) {
  return file + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
}

async function fsyncDirBestEffort(dir) {
  /* No Windows não é possível abrir diretório como arquivo; falha é esperada. */
  let handle = null;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (e) {
    /* best effort */
  } finally {
    if (handle) { try { await handle.close(); } catch (e) { /* ignore */ } }
  }
}

/**
 * Escreve um Buffer em `file` de forma atômica (tmp + fsync + rename).
 * @param {string} file caminho absoluto
 * @param {Buffer|string} data
 * @returns {Promise<void>}
 */
async function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = tmpPathFor(file);
  let handle = null;
  try {
    handle = await fsp.open(tmp, 'w');
    await handle.writeFile(data);
    try { await handle.sync(); } catch (e) { /* fsync pode não ser suportado */ }
    await handle.close();
    handle = null;
    await fsp.rename(tmp, file);
  } catch (err) {
    if (handle) { try { await handle.close(); } catch (e) { /* ignore */ } }
    try { await fsp.rm(tmp, { force: true }); } catch (e) { /* ignore */ }
    throw err;
  }
  await fsyncDirBestEffort(dir);
}

/** Serializa `obj` como JSON formatado e grava atomicamente. */
function writeJsonAtomic(file, obj) {
  return writeFileAtomic(file, Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8'));
}

/* -------------------------------------------------------------------------- */
/* Leitura tolerante                                                          */
/* -------------------------------------------------------------------------- */

function stripBom(text) {
  return String(text).replace(/^\uFEFF/, '');
}

/**
 * Lê e parseia JSON. Nunca lança: arquivo ausente/corrompido → null.
 * @param {string} file
 * @param {{maxBytes?:number}} [opts]
 * @returns {Promise<any|null>}
 */
async function readJsonSafe(file, opts) {
  const max = opts && opts.maxBytes ? opts.maxBytes : MANIFEST_MAX_BYTES;
  let raw;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > max) return null;
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    return null;
  }
  try {
    return JSON.parse(stripBom(raw));
  } catch (e) {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Normalização / validação                                                   */
/* -------------------------------------------------------------------------- */

function finiteNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegative(v, fallback) {
  const n = finiteNumber(v, fallback == null ? 0 : fallback);
  return n < 0 ? 0 : n;
}

function cleanText(v, max) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 300);
}

function cleanUrl(v) {
  const s = cleanText(v, 4096);
  return /^https?:\/\//i.test(s) ? s : '';
}

/**
 * Valida/normaliza um manifesto lido do disco. Campos desconhecidos são
 * descartados; um manifesto ilegível vira null (item ignorado, biblioteca segue).
 * @param {any} raw
 * @returns {object|null}
 */
function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanText(raw.id, 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return null;
  const kind = KINDS.indexOf(raw.kind) >= 0 ? raw.kind : '';
  if (!kind) return null;
  const engine = ENGINES.indexOf(raw.engine) >= 0 ? raw.engine : '';
  const title = cleanText(raw.title, 300);
  if (!title) return null;

  const files = [];
  if (Array.isArray(raw.files)) {
    const seen = new Set();
    for (const entry of raw.files) {
      if (!entry || typeof entry !== 'object') continue;
      let rel;
      try { rel = paths.normalizeRelPath(entry.path); } catch (e) { continue; }
      if (seen.has(rel)) continue;
      seen.add(rel);
      const file = { path: rel, size: Math.max(0, Math.floor(nonNegative(entry.size))) };
      const sha = cleanText(entry.sha256, 64);
      if (/^[a-f0-9]{64}$/i.test(sha)) file.sha256 = sha.toLowerCase();
      files.push(file);
    }
  }

  const out = {
    version: VERSION,
    id: id,
    kind: kind,
    title: title,
    subtitle: cleanText(raw.subtitle, 300),
    poster: cleanUrl(raw.poster),
    listId: cleanText(raw.listId, 128),
    itemId: cleanText(raw.itemId, 128),
    epId: cleanText(raw.epId, 128),
    season: Math.max(0, Math.floor(nonNegative(raw.season))),
    episode: Math.max(0, Math.floor(nonNegative(raw.episode))),
    year: cleanText(raw.year, 8),
    createdAt: Math.max(0, Math.floor(nonNegative(raw.createdAt))),
    completedAt: Math.max(0, Math.floor(nonNegative(raw.completedAt))),
    durationSec: nonNegative(raw.durationSec),
    engine: engine,
    files: files,
    playlist: {
      master: cleanText(raw.playlist && raw.playlist.master, 500),
      variant: cleanText(raw.playlist && raw.playlist.variant, 500)
    },
    variantLabel: cleanText(raw.variantLabel, 120),
    drm: 'none',
    sizeBytes: Math.max(0, Math.floor(nonNegative(raw.sizeBytes))),
    offlineUrl: cleanText(raw.offlineUrl, 500),
    status: STATUSES.indexOf(raw.status) >= 0 ? raw.status : 'done',
    error: cleanText(raw.error, 500)
  };
  /* saneamento final: total nunca menor que a soma dos arquivos */
  const sum = out.files.reduce(function (acc, f) { return acc + (Number(f.size) || 0); }, 0);
  if (out.sizeBytes < sum) out.sizeBytes = sum;
  return out;
}

function normalizeIndexItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanText(raw.id, 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return null;
  let dirName;
  try {
    const clean = paths.sanitizeName(raw.dirName, { max: paths.MAX_NAME });
    if (clean !== String(raw.dirName == null ? '' : raw.dirName)) return null;
    dirName = clean;
  } catch (e) {
    return null;
  }
  if (!dirName || dirName === '.' || dirName === '..') return null;
  const status = STATUSES.indexOf(raw.status) >= 0 ? raw.status : 'error';
  const engine = ENGINES.indexOf(raw.engine) >= 0 ? raw.engine : '';
  return {
    id: id,
    kind: KINDS.indexOf(raw.kind) >= 0 ? raw.kind : 'movie',
    title: cleanText(raw.title, 300) || 'Sem título',
    subtitle: cleanText(raw.subtitle, 300),
    poster: cleanUrl(raw.poster),
    listId: cleanText(raw.listId, 128),
    itemId: cleanText(raw.itemId, 128),
    epId: cleanText(raw.epId, 128),
    season: Math.max(0, Math.floor(nonNegative(raw.season))),
    episode: Math.max(0, Math.floor(nonNegative(raw.episode))),
    year: cleanText(raw.year, 8),
    status: status,
    progress: clamp01(raw.progress),
    bytes: Math.max(0, Math.floor(nonNegative(raw.bytes))),
    totalBytes: Math.max(0, Math.floor(nonNegative(raw.totalBytes))),
    speedBps: Math.max(0, Math.floor(nonNegative(raw.speedBps))),
    etaSec: Math.max(0, Math.floor(nonNegative(raw.etaSec))),
    error: cleanText(raw.error, 500),
    dirName: dirName,
    createdAt: Math.max(0, Math.floor(nonNegative(raw.createdAt))) || Date.now(),
    completedAt: Math.max(0, Math.floor(nonNegative(raw.completedAt))),
    durationSec: nonNegative(raw.durationSec),
    engine: engine,
    variantLabel: cleanText(raw.variantLabel, 120),
    variantId: cleanText(raw.variantId, 64),
    /* URL da fonte é mantida SÓ no índice (para retomar após reiniciar o app).
       O manifesto nunca guarda URL (contrato: sem credenciais no manifesto) e a
       UI/log nunca recebem este campo. */
    sourceUrl: cleanUrl(raw.sourceUrl),
    sizeBytes: Math.max(0, Math.floor(nonNegative(raw.sizeBytes)))
  };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Valida um índice. Índice “quase válido” perde só as entradas quebradas.
 * @param {any} raw
 * @returns {{version:number, updatedAt:number, items:object[]}|null}
 */
function normalizeIndex(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return null;
  const items = [];
  const seen = new Set();
  for (const entry of raw.items) {
    const item = normalizeIndexItem(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return {
    version: VERSION,
    updatedAt: Math.max(0, Math.floor(nonNegative(raw.updatedAt))),
    items: items
  };
}

/** Entrada de índice a partir de um manifesto + estado corrente. */
function indexEntryFromManifest(manifest, dirName, extra) {
  const m = manifest || {};
  const e = extra || {};
  return normalizeIndexItem({
    id: m.id,
    kind: m.kind,
    title: m.title,
    subtitle: m.subtitle,
    poster: m.poster,
    listId: m.listId,
    itemId: m.itemId,
    epId: m.epId,
    season: m.season,
    episode: m.episode,
    year: m.year,
    status: e.status || m.status || 'paused',
    progress: e.progress,
    bytes: e.bytes,
    totalBytes: e.totalBytes,
    speedBps: 0,
    etaSec: 0,
    error: e.error || m.error || '',
    dirName: dirName,
    createdAt: m.createdAt,
    completedAt: m.completedAt,
    durationSec: m.durationSec,
    engine: m.engine,
    variantLabel: m.variantLabel,
    sizeBytes: m.sizeBytes
  });
}

/* -------------------------------------------------------------------------- */
/* Índice                                                                     */
/* -------------------------------------------------------------------------- */

function indexPath(downloadsDir) {
  return path.join(downloadsDir, INDEX_DIR, INDEX_FILE);
}

function backupIndexPath(downloadsDir) {
  return path.join(downloadsDir, INDEX_DIR, INDEX_BAK);
}

/**
 * Varre `downloadsDir` e reconstrói o índice a partir dos manifestos.
 * Tolerante: pasta/manifesto quebrado é simplesmente ignorado.
 * @param {string} downloadsDir
 * @returns {Promise<object>}
 */
async function rebuildIndex(downloadsDir) {
  const items = [];
  let entries = [];
  try {
    entries = await fsp.readdir(downloadsDir, { withFileTypes: true });
  } catch (e) {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.charAt(0) === '.') continue;
    const dir = path.join(downloadsDir, entry.name);
    const manifest = await readManifest(dir);
    if (!manifest) continue;
    let dirName;
    try {
      const clean = paths.sanitizeName(entry.name, { max: paths.MAX_NAME });
      if (clean !== entry.name) continue;
      dirName = clean;
    } catch (e) {
      continue;
    }
    const done = manifest.files.length > 0;
    items.push(indexEntryFromManifest(manifest, dirName, {
      status: done ? 'done' : 'paused',
      progress: done ? 1 : 0,
      bytes: manifest.sizeBytes,
      totalBytes: manifest.sizeBytes,
      error: ''
    }));
  }
  items.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  return { version: VERSION, updatedAt: Date.now(), items: items };
}

/**
 * Carrega o índice com recuperação:
 *   index.json → index.json.bak → varredura dos manifestos.
 * @param {string} downloadsDir
 * @returns {Promise<{index:object, source:'main'|'backup'|'rebuilt'|'empty', corrupt:boolean, changed:boolean}>}
 */
async function loadIndex(downloadsDir) {
  let corrupt = false;
  const main = await readJsonSafe(indexPath(downloadsDir), { maxBytes: INDEX_MAX_BYTES });
  if (main) {
    const index = normalizeIndex(main);
    if (index) return { index: index, source: 'main', corrupt: false, changed: false };
    corrupt = true;
  } else {
    let exists = false;
    try { exists = (await fsp.stat(indexPath(downloadsDir))).isFile(); } catch (e) { exists = false; }
    corrupt = exists;
  }

  const bak = await readJsonSafe(backupIndexPath(downloadsDir), { maxBytes: INDEX_MAX_BYTES });
  if (bak) {
    const index = normalizeIndex(bak);
    if (index) return { index: index, source: 'backup', corrupt: corrupt, changed: true };
    corrupt = true;
  }

  const rebuilt = await rebuildIndex(downloadsDir);
  if (rebuilt.items.length) return { index: rebuilt, source: 'rebuilt', corrupt: corrupt, changed: true };
  return { index: rebuilt, source: 'empty', corrupt: corrupt, changed: corrupt };
}

/**
 * Grava o índice atomicamente, guardando a versão anterior em `.bak`.
 * @param {string} downloadsDir
 * @param {object} index
 */
async function saveIndex(downloadsDir, index) {
  const dir = path.join(downloadsDir, INDEX_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const file = indexPath(downloadsDir);
  let previous = null;
  try {
    const stat = await fsp.stat(file);
    if (stat.isFile() && stat.size > 0 && stat.size <= INDEX_MAX_BYTES) previous = await fsp.readFile(file);
  } catch (e) {
    previous = null;
  }
  if (previous) {
    try { await writeFileAtomic(backupIndexPath(downloadsDir), previous); } catch (e) { /* backup é best effort */ }
  }
  const safe = normalizeIndex(index) || { version: VERSION, updatedAt: Date.now(), items: [] };
  safe.updatedAt = Date.now();
  await writeJsonAtomic(file, safe);
  return safe;
}

/* -------------------------------------------------------------------------- */
/* Manifestos                                                                 */
/* -------------------------------------------------------------------------- */

function manifestPath(itemDir) {
  return path.join(itemDir, MANIFEST_FILE);
}

/** Lê o manifesto de uma pasta de item (tolerante a corrupção). */
async function readManifest(itemDir) {
  const raw = await readJsonSafe(manifestPath(itemDir), { maxBytes: MANIFEST_MAX_BYTES });
  return normalizeManifest(raw);
}

/** Grava o manifesto de um item atomicamente. */
async function writeManifest(itemDir, manifest) {
  await fsp.mkdir(itemDir, { recursive: true });
  const safe = normalizeManifest(manifest);
  if (!safe) throw new Error('manifesto inválido');
  await writeJsonAtomic(manifestPath(itemDir), safe);
  return safe;
}

/* -------------------------------------------------------------------------- */
/* Remoção gerenciada                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Apaga a pasta de UM item gerenciado, validando containment (lexical e real).
 * Nunca apaga nada fora de `downloadsDir`; junction/symlink no lugar da pasta
 * é removido como link (sem seguir o destino).
 * @param {string} downloadsDir
 * @param {string} dirName
 * @returns {Promise<{removed:boolean, dir:string}>}
 */
async function deleteManagedItem(downloadsDir, dirName) {
  const dir = paths.itemDir(downloadsDir, dirName);   /* valida nome e containment lexical */
  let realDownloads;
  try {
    realDownloads = await fsp.realpath(downloadsDir);
  } catch (e) {
    throw new paths.PathError('PATH_NOT_FOUND', 'Pasta de downloads não encontrada.');
  }
  if (!paths.contains(realDownloads, realDownloads)) throw new paths.PathError('PATH_INVALID', 'Pasta inválida.');

  let stat = null;
  try { stat = await fsp.lstat(dir); } catch (e) {
    if (e && e.code === 'ENOENT') return { removed: false, dir: dir };
    throw e;
  }
  if (stat.isSymbolicLink()) {
    /* junction/symlink: remove só o link (o destino pode estar fora da pasta) */
    await fsp.unlink(dir);
    return { removed: true, dir: dir };
  }
  let realDir;
  try { realDir = await fsp.realpath(dir); } catch (e) { realDir = dir; }
  if (!paths.isInside(realDownloads, realDir)) {
    throw new paths.PathError('PATH_TRAVERSAL', 'A pasta do item aponta para fora da pasta de downloads.');
  }
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  return { removed: true, dir: dir };
}

/* -------------------------------------------------------------------------- */
/* Store serializado (uma escrita por vez)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Store do índice com leitura em cache e updates serializados. Callbacks de
 * progresso NÃO devem chamar `update` (só transições de estado), para manter o
 * índice pequeno e as escritas espaçadas.
 * @param {string} downloadsDir
 */
function createStore(downloadsDir) {
  const dir = String(downloadsDir || '');
  let cached = null;
  let chain = Promise.resolve();

  function enqueue(fn) {
    const run = chain.then(fn);
    chain = run.then(function () {}, function () {});
    return run;
  }

  function clone(index) {
    return JSON.parse(JSON.stringify(index));
  }

  async function ensureLoaded() {
    if (cached) return cached;
    const result = await loadIndex(dir);
    cached = result.index;
    if (result.changed) {
      try { cached = await saveIndex(dir, cached); } catch (e) { /* reparo é best effort */ }
    }
    return cached;
  }

  return {
    dir: dir,
    indexPath: indexPath(dir),
    /** @returns {Promise<object>} cópia do índice atual */
    read: function () { return enqueue(function () { return ensureLoaded().then(clone); }); },
    /** Executa mutator(index) e persiste. Serializado; devolve o retorno do mutator. */
    update: function (mutator) {
      return enqueue(async function () {
        const index = await ensureLoaded();
        const result = await mutator(index);
        cached = await saveIndex(dir, index);
        return result;
      });
    },
    /** Limpa o cache (ex.: pasta de downloads trocada). */
    invalidate: function () { cached = null; },
    /** Grava o índice atual (útil em shutdown). */
    flush: function () {
      return enqueue(async function () {
        if (!cached) return;
        cached = await saveIndex(dir, cached);
      });
    }
  };
}

module.exports = {
  VERSION,
  INDEX_DIR,
  INDEX_FILE,
  INDEX_BAK,
  MANIFEST_FILE,
  STATUSES,
  KINDS,
  ENGINES,
  writeFileAtomic,
  writeJsonAtomic,
  readJsonSafe,
  normalizeManifest,
  normalizeIndex,
  normalizeIndexItem,
  indexEntryFromManifest,
  indexPath,
  backupIndexPath,
  manifestPath,
  loadIndex,
  saveIndex,
  rebuildIndex,
  readManifest,
  writeManifest,
  deleteManagedItem,
  createStore
};
