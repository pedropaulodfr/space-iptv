/* Downloads offline do Space IPTV Desktop — fila, MP4 com Range, HLS, IPC e
 * servidor de arquivos `/offline/<id>/<rel>` (CONTRACTS.md §4).
 *
 * Responsabilidades:
 *  - fila com concorrência 2, pausar/retomar/cancelar/retry;
 *  - MP4: GET com Range, `.part` + Content-Length/Content-Range, retomada,
 *    reinício quando o servidor ignora Range, checagem de espaço livre;
 *  - HLS: delega para `hls.js` (pacote local + recusa de DRM);
 *  - manifestos atômicos e índice da biblioteca via `manifest.js`;
 *  - eventos `queue|progress|done|error|removed` por `ctx.emit('downloads', {type,item,stats})`;
 *  - `/offline/<id>/<rel>` serve SÓ arquivos listados no manifesto, com Range;
 *  - exclusão apaga somente a pasta gerenciada dentro de `downloadsDir`.
 *
 * Segurança: URL da fonte (que pode conter usuário/senha do provedor) fica
 * apenas em memória e no índice interno — NUNCA no manifesto, no nome de
 * arquivo, no log ou na cópia enviada ao renderer.
 *
 * Node puro: nenhum `require('electron')` no topo; `ipcMain`/`shell` entram por
 * `ctx` (o main real injeta; os testes passam dublês).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CH = require('./channels');
const paths = require('./paths');
const manifests = require('./manifest');
const hls = require('./hls');
const { createMediaProxy, pingPayload } = require('./media-proxy');

const fsp = fs.promises;

const CONCURRENCY = 2;
const SPACE_MARGIN_BYTES = 50 * 1024 * 1024;
const PROGRESS_EMIT_MS = 400;
const MP4_ATTEMPTS = 3;
const HLS_ATTEMPTS = 1;                 /* hls.js já repete segmentos */
const MP4_HEADERS_TIMEOUT_MS = 45000;
const MP4_IDLE_TIMEOUT_MS = 45000;
const PROBE_TIMEOUT_MS = 15000;
const PROBE_MAX_URLS = 6;
const SHUTDOWN_WAIT_MS = 5000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m3u': 'audio/x-mpegurl; charset=utf-8',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.m4v': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.vtt': 'text/vtt; charset=utf-8',
  '.key': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

/* -------------------------------------------------------------------------- */
/* Estado singleton                                                           */
/* -------------------------------------------------------------------------- */

let state = null;
let pendingMediaHosts = [];

class DownloadError extends Error {
  constructor(message, code, extra) {
    super(message || 'Falha no download.');
    this.name = 'DownloadError';
    this.code = code || 'invalid';
    if (extra) Object.assign(this, extra);
  }
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function defaultDownloadsDir() {
  try {
    return path.join(os.homedir(), 'Videos', 'Space IPTV');
  } catch (e) {
    return 'C:\\Videos\\Space IPTV';
  }
}

function resolveDownloadsDir(config) {
  const value = config && typeof config.downloadsDir === 'string' ? config.downloadsDir.trim() : '';
  return path.resolve(value || process.env.SPACE_DOWNLOADS_DIR || defaultDownloadsDir());
}

/** Remove URLs/credenciais de qualquer texto antes de logar. */
function scrubText(text) {
  return String(text == null ? '' : text)
    .replace(/https?:\/\/[^\s"']+/gi, '[link]')
    .replace(/([?&](?:username|password|user|pass|token|key)=)[^&\s"']*/gi, '$1***')
    .replace(/\/(live|movie|series)\/[^/\s]+\/[^/\s]+\//g, '/$1/***/***/');
}

function electronApi() {
  try {
    const api = require('electron');
    if (api && typeof api === 'object' && api.ipcMain) return api;
  } catch (e) { /* rodando fora do Electron (testes) */ }
  return null;
}

function createEmitter(ctx) {
  if (ctx && typeof ctx.emit === 'function') {
    return function (channel, payload) { ctx.emit(channel, payload); };
  }
  return function (channel, payload) {
    try {
      const win = ctx && typeof ctx.getMainWindow === 'function' ? ctx.getMainWindow() : null;
      if (win && win.webContents && typeof win.isDestroyed === 'function' && !win.isDestroyed()) {
        win.webContents.send(CH.EVENT, { channel: channel, payload: payload });
      }
    } catch (e) { /* janela fechando */ }
  };
}

/* -------------------------------------------------------------------------- */
/* Allowlist de hosts de mídia                                                */
/* -------------------------------------------------------------------------- */

function applyMediaHosts(st, hosts) {
  if (!st || !Array.isArray(hosts)) return;
  for (const raw of hosts) {
    let value = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!value) continue;
    if (value === '*') { st.allow.any = true; continue; }
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        value = new URL(value).hostname;
      } else {
        value = value.split('/')[0].split('?')[0];
      }
    } catch (e) {
      continue;
    }
    value = value.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    let suffix = false;
    if (value.indexOf('*.') === 0) { value = value.slice(2); suffix = true; }
    else if (value.charAt(0) === '.') { value = value.slice(1); suffix = true; }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) continue;
    if (suffix) st.allow.suffixes.add(value);
    else st.allow.hosts.add(value);
  }
}

/**
 * Registra hosts de mídia na allowlist do proxy (chamado pelo handler de
 * `space.registerMediaHosts`). Aceita host, host:porta, URL ou "*.dominio".
 * @param {string[]} hosts
 */
function registerMediaHosts(hosts) {
  const list = Array.isArray(hosts) ? hosts : [];
  if (state) applyMediaHosts(state, list);
  else {
    for (const h of list) pendingMediaHosts.push(h);
    if (pendingMediaHosts.length > 500) pendingMediaHosts = pendingMediaHosts.slice(-500);
  }
}

function getMediaHosts() {
  if (!state) return pendingMediaHosts.slice();
  return Array.from(state.allow.hosts).concat(Array.from(state.allow.suffixes).map(function (s) { return '*.' + s; }));
}

function hostAllowed(st, host) {
  const h = String(host == null ? '' : host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (st.allow.any) return true;
  if (st.allow.hosts.has(h)) return true;
  for (const suffix of st.allow.suffixes) {
    if (h === suffix || h.slice(-(suffix.length + 1)) === '.' + suffix) return true;
  }
  if (typeof st.externalAllow === 'function') {
    try { if (st.externalAllow(h)) return true; } catch (e) { /* ignore */ }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Itens: representação pública e persistida                                  */
/* -------------------------------------------------------------------------- */

function emptyStats() {
  return {
    total: 0, active: 0, queued: 0, downloading: 0, paused: 0, packaging: 0,
    done: 0, error: 0, canceled: 0, bytes: 0, totalBytes: 0, speedBps: 0
  };
}

function offlineUrlFor(item) {
  if (!item || !item.id) return '';
  if (item.engine === 'hls') {
    const playlist = item.playlist && (item.playlist.master || item.playlist.variant);
    return '/offline/' + encodeURIComponent(item.id) + '/' + (playlist || 'playlist.m3u8');
  }
  return '/offline/' + encodeURIComponent(item.id) + '/video.mp4';
}

/** Objeto enviado ao renderer — sem URL da fonte. */
function publicItem(item) {
  if (!item) return null;
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    subtitle: item.subtitle || '',
    poster: item.poster || '',
    listId: item.listId || '',
    itemId: item.itemId || '',
    epId: item.epId || '',
    season: item.season || 0,
    episode: item.episode || 0,
    year: item.year || '',
    status: item.status,
    progress: clamp01(item.progress),
    bytes: Math.max(0, Math.floor(Number(item.bytes) || 0)),
    totalBytes: Math.max(0, Math.floor(Number(item.totalBytes) || 0)),
    speedBps: Math.max(0, Math.floor(Number(item.speedBps) || 0)),
    etaSec: Math.max(0, Math.floor(Number(item.etaSec) || 0)),
    error: item.error || '',
    dirName: item.dirName,
    createdAt: item.createdAt || 0,
    completedAt: item.completedAt || 0,
    offlineUrl: item.offlineUrl || offlineUrlFor(item),
    durationSec: Number(item.durationSec) || 0,
    engine: item.engine || '',
    variantLabel: item.variantLabel || '',
    sizeBytes: Math.max(0, Math.floor(Number(item.sizeBytes) || 0))
  };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function itemFromIndexRecord(rec) {
  return {
    id: rec.id,
    kind: rec.kind,
    title: rec.title,
    subtitle: rec.subtitle || '',
    poster: rec.poster || '',
    listId: rec.listId || '',
    itemId: rec.itemId || '',
    epId: rec.epId || '',
    season: rec.season || 0,
    episode: rec.episode || 0,
    year: rec.year || '',
    status: rec.status,
    progress: clamp01(rec.progress),
    bytes: Math.max(0, Math.floor(Number(rec.bytes) || 0)),
    totalBytes: Math.max(0, Math.floor(Number(rec.totalBytes) || 0)),
    speedBps: 0,
    etaSec: 0,
    error: rec.error || '',
    dirName: rec.dirName,
    createdAt: rec.createdAt || Date.now(),
    completedAt: rec.completedAt || 0,
    durationSec: Number(rec.durationSec) || 0,
    engine: rec.engine || '',
    variantLabel: rec.variantLabel || '',
    variantId: rec.variantId || '',
    sizeBytes: Math.max(0, Math.floor(Number(rec.sizeBytes) || 0)),
    sourceUrl: rec.sourceUrl || '',
    headers: null,           /* nunca persistido */
    files: [],
    playlist: { master: '', variant: '' },
    offlineUrl: ''
  };
}

function indexRecordFromItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    subtitle: item.subtitle || '',
    poster: item.poster || '',
    listId: item.listId || '',
    itemId: item.itemId || '',
    epId: item.epId || '',
    season: item.season || 0,
    episode: item.episode || 0,
    year: item.year || '',
    status: item.status,
    progress: clamp01(item.progress),
    bytes: item.bytes || 0,
    totalBytes: item.totalBytes || 0,
    speedBps: 0,
    etaSec: 0,
    error: item.error || '',
    dirName: item.dirName,
    createdAt: item.createdAt || Date.now(),
    completedAt: item.completedAt || 0,
    durationSec: item.durationSec || 0,
    engine: item.engine || '',
    variantLabel: item.variantLabel || '',
    variantId: item.variantId || '',
    sizeBytes: item.sizeBytes || 0,
    sourceUrl: item.sourceUrl || ''
  };
}

/** Manifesto do item — NUNCA inclui URL/credenciais. */
function manifestFromItem(item) {
  return {
    version: 1,
    id: item.id,
    kind: item.kind,
    title: item.title,
    subtitle: item.subtitle || '',
    poster: item.poster || '',
    listId: item.listId || '',
    itemId: item.itemId || '',
    epId: item.epId || '',
    season: item.season || 0,
    episode: item.episode || 0,
    year: item.year || '',
    createdAt: item.createdAt || Date.now(),
    completedAt: item.completedAt || 0,
    durationSec: item.durationSec || 0,
    engine: item.engine || '',
    files: (item.files || []).map(function (f) {
      const out = { path: f.path, size: Math.max(0, Math.floor(Number(f.size) || 0)) };
      if (f.sha256) out.sha256 = f.sha256;
      return out;
    }),
    playlist: {
      master: (item.playlist && item.playlist.master) || '',
      variant: (item.playlist && item.playlist.variant) || ''
    },
    drm: 'none',
    sizeBytes: Math.max(0, Math.floor(Number(item.sizeBytes) || 0)),
    offlineUrl: offlineUrlFor(item),
    status: item.status,
    error: item.error || '',
    variantLabel: item.variantLabel || ''
  };
}

function statsOf(st) {
  const stats = emptyStats();
  for (const item of st.items.values()) {
    stats.total++;
    if (Object.prototype.hasOwnProperty.call(stats, item.status)) stats[item.status]++;
    stats.bytes += Math.max(0, Number(item.bytes) || 0);
    stats.totalBytes += Math.max(0, Number(item.totalBytes) || 0);
    if (item.status === 'downloading') stats.speedBps += Math.max(0, Number(item.speedBps) || 0);
  }
  stats.active = stats.downloading;
  return stats;
}

function emitEvent(st, type, item) {
  if (!st || st.disposed) return;
  const payload = {
    type: type,
    item: item ? publicItem(item) : null,
    stats: statsOf(st)
  };
  try {
    st.emit('downloads', payload);
  } catch (e) { /* janela/renderer podem não existir (testes) */ }
}

/* -------------------------------------------------------------------------- */
/* Erros amigáveis                                                            */
/* -------------------------------------------------------------------------- */

function friendlyDownloadError(err) {
  if (!err) return 'Falha inesperada no download.';
  const code = err.code;
  if (code === 'drm') return err.message || hls.DRM_MESSAGE;
  if (code === 'http') return err.message || 'O servidor recusou o download.';
  if (code === 'network') return 'Falha de rede durante o download. Verifique a conexão e tente novamente.';
  if (code === 'timeout') return 'O servidor demorou demais para responder. Tente novamente.';
  if (code === 'parse') return 'O servidor respondeu em um formato inesperado.';
  if (code === 'not-playlist') return 'O conteúdo não é uma playlist HLS. Verifique a lista/provedor.';
  if (code === 'unsupported') return err.message || 'Este conteúdo não pode ser baixado.';
  if (code === 'variant') return err.message || 'A qualidade escolhida não está disponível.';
  if (code === 'invalid') return err.message || 'Pedido de download inválido.';
  if (code === 'disk') return err.message || 'Sem espaço em disco para concluir o download.';
  if (code === 'aborted') return 'Download interrompido.';
  const fsCode = err.code;
  if (fsCode === 'ENOSPC') return 'Sem espaço em disco para concluir o download.';
  if (fsCode === 'EACCES' || fsCode === 'EPERM') return 'Sem permissão para gravar na pasta de downloads.';
  if (fsCode === 'ENOENT') return 'A pasta de downloads não foi encontrada. Verifique em Configurações.';
  if (err.name === 'AbortError' || fsCode === 'ABORT_ERR') return 'Download interrompido.';
  return 'Não foi possível baixar: ' + scrubText(err.message || 'erro desconhecido') + '.';
}

function abortReason(job) {
  const reason = job && job.controller && job.controller.signal.aborted
    ? String(job.controller.signal.reason == null ? '' : job.controller.signal.reason)
    : '';
  const err = new Error('Download interrompido.');
  err.code = 'aborted';
  err.reason = reason;
  return err;
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers (MP4)                                                         */
/* -------------------------------------------------------------------------- */

function linkAbort(parent, timeoutMs) {
  const ac = new AbortController();
  let timedOut = false;
  const onAbort = function () {
    try { ac.abort(parent && parent.reason); } catch (e) { /* ignore */ }
  };
  if (parent) {
    if (parent.aborted) {
      try { ac.abort(parent.reason); } catch (e) { /* ignore */ }
    } else {
      parent.addEventListener('abort', onAbort, { once: true });
    }
  }
  const timer = setTimeout(function () {
    timedOut = true;
    try { ac.abort(new Error('timeout')); } catch (e) { /* ignore */ }
  }, Math.max(1000, timeoutMs || MP4_HEADERS_TIMEOUT_MS));
  return {
    signal: ac.signal,
    timedOut: function () { return timedOut; },
    cleanup: function () {
      clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onAbort);
    }
  };
}

function parseContentRange(header) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(header == null ? '' : header).trim());
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: Number(m[2]),
    total: m[3] === '*' ? 0 : Number(m[3])
  };
}

function parseUnsatisfiedTotal(header) {
  const m = /^bytes\s+\*\/(\d+)$/i.exec(String(header == null ? '' : header).trim());
  return m ? Number(m[1]) : 0;
}

function contentLengthOf(res) {
  const raw = res.headers.get('content-length');
  if (!raw || !/^\d+$/.test(raw)) return 0;
  return Number(raw);
}

function looksLikeHtmlStart(chunk) {
  if (!chunk || !chunk.length) return false;
  const s = Buffer.from(chunk.subarray(0, Math.min(chunk.length, 64))).toString('latin1').replace(/^\uFEFF/, '').trim().toLowerCase();
  return s.charAt(0) === '<' && /^(<!doctype|<html|<head|<body|\?xml)/.test(s);
}

async function readSmallBody(res, maxBytes) {
  if (!res.body) return '';
  try {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      const b = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      chunks.push(b);
      size += b.length;
    }
    try { await reader.cancel(); } catch (e) { /* ignore */ }
    return Buffer.concat(chunks, Math.min(size, maxBytes)).toString('utf8');
  } catch (e) {
    return '';
  }
}

async function sizeOf(file) {
  try {
    const st = await fsp.stat(file);
    return st.isFile() ? st.size : 0;
  } catch (e) {
    return 0;
  }
}

async function isDirectory(dir) {
  try {
    const st = await fsp.stat(dir);
    return st.isDirectory();
  } catch (e) {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* MP4                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Baixa um MP4 direto para `video.mp4.part` com retomada por Range.
 * @returns {Promise<{files:object[], totalBytes:number, engine:string, playlist:object}>}
 */
async function downloadMp4(st, item, job, report) {
  const dir = path.join(st.downloadsDir, item.dirName);
  const partPath = path.join(dir, 'video.mp4.part');
  const finalPath = path.join(dir, 'video.mp4');

  const finalSize = await sizeOf(finalPath);
  if (finalSize > 0 && (!item.totalBytes || finalSize === item.totalBytes)) {
    report(finalSize, finalSize);
    return {
      files: [{ path: 'video.mp4', size: finalSize }],
      totalBytes: finalSize,
      engine: 'mp4',
      playlist: { master: '', variant: '' }
    };
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= MP4_ATTEMPTS; attempt++) {
    if (job.controller.signal.aborted) throw abortReason(job);
    try {
      return await downloadMp4Attempt(st, item, job, report, partPath, finalPath);
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'aborted') throw err;
      const retryable = err && (
        err.code === 'network' || err.code === 'timeout' ||
        (err.code === 'http' && (err.status >= 500 || err.status === 408 || err.status === 429))
      );
      if (!retryable || attempt >= MP4_ATTEMPTS) throw err;
      await sleep(600 * attempt + Math.floor(Math.random() * 300));
    }
  }
  throw lastErr || new DownloadError('Não foi possível baixar o arquivo.', 'network');
}

async function downloadMp4Attempt(st, item, job, report, partPath, finalPath) {
  await fsp.mkdir(path.dirname(partPath), { recursive: true });
  let existing = await sizeOf(partPath);

  /* .part já completo (ex.: app fechou entre o fim do stream e o rename) */
  if (item.totalBytes > 0 && existing === item.totalBytes) {
    await fsp.rename(partPath, finalPath);
    const size = await sizeOf(finalPath);
    if (size === item.totalBytes) {
      report(size, size);
      return { files: [{ path: 'video.mp4', size: size }], totalBytes: size, engine: 'mp4', playlist: { master: '', variant: '' } };
    }
    existing = 0;
  }
  if (item.totalBytes > 0 && existing > item.totalBytes) {
    await fsp.rm(partPath, { force: true });
    existing = 0;
  }

  const headers = Object.assign({ 'accept': '*/*', 'accept-encoding': 'identity' }, item.headers || {});
  if (existing > 0) headers.range = 'bytes=' + existing + '-';

  const link = linkAbort(job.controller.signal, MP4_HEADERS_TIMEOUT_MS);
  let res;
  try {
    res = await st.fetchImpl(item.sourceUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: link.signal,
      headers: headers
    });
  } catch (err) {
    link.cleanup();
    if (job.controller.signal.aborted) throw abortReason(job);
    if (link.timedOut()) throw new DownloadError('O servidor demorou demais para responder.', 'timeout');
    throw new DownloadError('Não foi possível acessar o servidor do conteúdo.', 'network', { cause: err });
  }

  let idle = null;
  let idleTimedOut = false;
  function touchIdle() {
    if (idle) clearTimeout(idle);
    idle = setTimeout(function () {
      idleTimedOut = true;
      try { link.cleanup(); } catch (e) { /* ignore */ }
      try { if (res && res.body) res.body.cancel().catch(function () {}); } catch (e) { /* ignore */ }
    }, MP4_IDLE_TIMEOUT_MS);
  }
  function clearIdle() { if (idle) { clearTimeout(idle); idle = null; } }

  let handle = null;
  try {
    const status = res.status;
    let totalBytes = 0;
    let append = false;
    let canHash = true;

    if (status === 206) {
      const cr = parseContentRange(res.headers.get('content-range'));
      totalBytes = cr ? cr.total : (existing + contentLengthOf(res));
      append = existing > 0;
      canHash = !append;
    } else if (status === 200) {
      const len = contentLengthOf(res);
      totalBytes = len || item.totalBytes || 0;
      if (existing > 0) {
        /* servidor ignorou Range: reinicia do zero para não gravar lixo */
        await fsp.rm(partPath, { force: true });
        existing = 0;
        report(0, totalBytes);
      }
      append = false;
    } else if (status === 416) {
      const unsatisfiedTotal = parseUnsatisfiedTotal(res.headers.get('content-range'));
      if (res.body) { try { await res.body.cancel(); } catch (e) { /* ignore */ } }
      if (existing > 0 && unsatisfiedTotal && existing === unsatisfiedTotal) {
        await fsp.rename(partPath, finalPath);
        const size = await sizeOf(finalPath);
        report(size, size);
        return { files: [{ path: 'video.mp4', size: size }], totalBytes: size, engine: 'mp4', playlist: { master: '', variant: '' } };
      }
      await fsp.rm(partPath, { force: true });
      throw new DownloadError('O servidor recusou a continuação do download.', 'network');
    } else {
      const body = await readSmallBody(res, 2048);
      void body;
      throw new DownloadError(
        status === 401 || status === 403
          ? 'O servidor recusou o download (HTTP ' + status + '). Verifique a lista/provedor.'
          : 'O servidor respondeu HTTP ' + status + '.',
        'http',
        { status: status }
      );
    }

    const contentType = res.headers.get('content-type') || '';
    if (/text\/html|application\/xhtml/i.test(contentType)) {
      throw new DownloadError('O servidor devolveu uma página em vez do vídeo. Verifique a lista/proxy.', 'invalid');
    }
    if (!res.body) throw new DownloadError('Resposta vazia do servidor.', 'network');

    handle = await fsp.open(partPath, append ? 'a' : 'w');
    const hash = canHash ? crypto.createHash('sha256') : null;
    let received = 0;
    let bytes = existing;
    report(bytes, totalBytes || item.totalBytes || 0);

    try {
      const reader = res.body.getReader();
      touchIdle();
      while (true) {
        if (job.controller.signal.aborted) throw abortReason(job);
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        if (received === 0 && looksLikeHtmlStart(chunk)) {
          throw new DownloadError('O servidor devolveu uma página em vez do vídeo. Verifique a lista/proxy.', 'invalid');
        }
        await handle.write(chunk);
        received += chunk.length;
        bytes += chunk.length;
        if (hash) hash.update(chunk);
        touchIdle();
        report(bytes, totalBytes || item.totalBytes || 0);
        if (idleTimedOut) throw new DownloadError('A conexão com o servidor ficou parada.', 'timeout');
      }
    } finally {
      clearIdle();
    }

    if (idleTimedOut) throw new DownloadError('A conexão com o servidor ficou parada.', 'timeout');
    if (totalBytes > 0 && bytes !== totalBytes) {
      throw new DownloadError(
        'O download ficou incompleto (' + paths.formatBytes(bytes) + ' de ' + paths.formatBytes(totalBytes) + ').',
        'network'
      );
    }
    try { await handle.sync(); } catch (e) { /* fsync opcional */ }
    await handle.close();
    handle = null;
    await fsp.rename(partPath, finalPath);
    const file = { path: 'video.mp4', size: bytes };
    if (hash) file.sha256 = hash.digest('hex');
    report(bytes, bytes);
    return {
      files: [file],
      totalBytes: bytes,
      engine: 'mp4',
      playlist: { master: '', variant: '' }
    };
  } catch (err) {
    clearIdle();
    if (handle) { try { await handle.close(); } catch (e) { /* ignore */ } }
    if (job.controller.signal.aborted) throw abortReason(job);
    if (idleTimedOut) throw new DownloadError('A conexão com o servidor ficou parada.', 'timeout');
    if (err && err.code) throw err;
    throw new DownloadError('Falha ao gravar o arquivo do download.', 'disk', { cause: err });
  } finally {
    clearIdle();
    link.cleanup();
    try { if (res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
  }
}

/* -------------------------------------------------------------------------- */
/* HLS                                                                        */
/* -------------------------------------------------------------------------- */

async function downloadHls(st, item, job, report) {
  const dir = path.join(st.downloadsDir, item.dirName);
  return hls.download({
    url: item.sourceUrl,
    destDir: dir,
    variantId: item.variantId || '',
    headers: item.headers || null,
    signal: job.controller.signal,
    fetchImpl: st.fetchImpl,
    estimatedBytes: item.totalBytes || 0,
    durationSec: item.durationSec || 0,
    log: function (msg) { st.log(msg); },
    onProgress: function (p) {
      report(p.bytes, item.totalBytes || 0, p.segmentsDone, p.segmentsTotal);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Persistência do item                                                       */
/* -------------------------------------------------------------------------- */

async function writeManifestFor(st, item) {
  const dir = path.join(st.downloadsDir, item.dirName);
  const saved = await manifests.writeManifest(dir, manifestFromItem(item));
  st.manifestCache.set(item.id, saved);
  return saved;
}

async function saveIndexEntry(st, item) {
  await st.store.update(function (index) {
    const record = indexRecordFromItem(item);
    const pos = index.items.findIndex(function (entry) { return entry.id === item.id; });
    if (pos >= 0) index.items[pos] = record;
    else index.items.unshift(record);
    index.items.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  });
}

async function removeIndexEntry(st, id) {
  await st.store.update(function (index) {
    index.items = index.items.filter(function (entry) { return entry.id !== id; });
  });
}

/** Grava manifesto (se a pasta existir) e índice. Nunca lança. */
async function saveItemState(st, item) {
  const dir = path.join(st.downloadsDir, item.dirName);
  const dirExists = await isDirectory(dir);
  if (dirExists) {
    try { await writeManifestFor(st, item); } catch (err) { st.log('[downloads] manifesto: ' + scrubText(err.message)); }
  } else {
    st.manifestCache.delete(item.id);
  }
  try { await saveIndexEntry(st, item); } catch (err) { st.log('[downloads] índice: ' + scrubText(err.message)); }
}

/* -------------------------------------------------------------------------- */
/* Fila                                                                       */
/* -------------------------------------------------------------------------- */

function enqueue(st, item) {
  if (!item || st.disposed) return;
  item.status = 'queued';
  item.error = '';
  item.speedBps = 0;
  item.etaSec = 0;
  if (st.queue.indexOf(item.id) < 0) st.queue.push(item.id);
}

function pump(st) {
  if (!st || st.disposed || st.pumping) return;
  st.pumping = true;
  try {
    while (!st.disposed && st.active.size < CONCURRENCY) {
      const id = st.queue.shift();
      if (!id) break;
      const item = st.items.get(id);
      if (!item || item.status !== 'queued') continue;
      startJob(st, id);
    }
  } finally {
    st.pumping = false;
  }
}

function startJob(st, id) {
  const item = st.items.get(id);
  if (!item || item.status !== 'queued' || st.disposed) return null;
  if (st.active.size >= CONCURRENCY) return null;
  const job = { controller: new AbortController(), promise: null };
  st.active.set(id, job);
  item.status = 'downloading';
  item.error = '';
  job.promise = runJob(st, item, job).catch(function (err) {
    st.log('[downloads] job "' + id + '": ' + scrubText(err && err.message));
  });
  return job.promise;
}

async function runJob(st, item, job) {
  const dir = path.join(st.downloadsDir, item.dirName);
  const progress = { lastTs: Date.now(), lastBytes: Math.max(0, item.bytes || 0), speed: 0, lastEmit: 0 };

  function report(bytes, totalBytes, segmentsDone, segmentsTotal) {
    const now = Date.now();
    item.bytes = Math.max(0, Math.floor(Number(bytes) || 0));
    const total = Math.max(0, Math.floor(Number(totalBytes) || 0));
    if (total > 0) item.totalBytes = total;
    if (item.totalBytes > 0) item.progress = Math.min(0.99, item.bytes / item.totalBytes);
    else if (segmentsTotal > 0) item.progress = Math.min(0.99, (Number(segmentsDone) || 0) / segmentsTotal);

    const dt = (now - progress.lastTs) / 1000;
    if (dt >= 0.5) {
      const instant = (item.bytes - progress.lastBytes) / dt;
      if (Number.isFinite(instant) && instant >= 0) {
        progress.speed = progress.speed ? progress.speed * 0.65 + instant * 0.35 : instant;
      }
      progress.lastTs = now;
      progress.lastBytes = item.bytes;
      item.speedBps = Math.max(0, Math.round(progress.speed));
      if (item.totalBytes > 0 && item.speedBps > 2048) {
        item.etaSec = Math.max(0, Math.round((item.totalBytes - item.bytes) / item.speedBps));
      } else {
        item.etaSec = 0;
      }
    }
    if (now - progress.lastEmit >= PROGRESS_EMIT_MS) {
      progress.lastEmit = now;
      emitEvent(st, 'progress', item);
    }
  }

  try {
    await paths.ensureDir(dir);
    await writeManifestFor(st, item);
    await saveIndexEntry(st, item);
    emitEvent(st, 'queue', item);

    const result = item.engine === 'hls'
      ? await downloadHls(st, item, job, report)
      : await downloadMp4(st, item, job, report);
    if (job.controller.signal.aborted) throw abortReason(job);

    item.status = 'packaging';
    emitEvent(st, 'queue', item);

    const files = [];
    const seen = new Set();
    for (const file of result.files || []) {
      let rel;
      try { rel = paths.normalizeRelPath(file.path); } catch (e) { continue; }
      if (seen.has(rel)) continue;
      seen.add(rel);
      const entry = { path: rel, size: Math.max(0, Math.floor(Number(file.size) || 0)) };
      if (file.sha256) entry.sha256 = file.sha256;
      files.push(entry);
    }
    const total = Math.max(0, Math.floor(Number(result.totalBytes) || 0));
    const finalState = {
      files: files,
      playlist: result.playlist || { master: '', variant: '' },
      engine: result.engine || item.engine || 'mp4',
      totalBytes: total,
      bytes: total,
      sizeBytes: total,
      progress: 1,
      speedBps: 0,
      etaSec: 0,
      completedAt: Date.now(),
      status: 'done',
      error: ''
    };
    if (result.variant && result.variant.label) finalState.variantLabel = result.variant.label;
    if (!item.durationSec && result.durationSec) finalState.durationSec = result.durationSec;
    const finalItem = Object.assign({}, item, finalState);
    finalItem.offlineUrl = offlineUrlFor(finalItem);

    /* persiste ANTES de anunciar 'done': a lista/rota offline nunca veem um
       item concluído cujo manifesto ainda não foi gravado */
    await writeManifestFor(st, finalItem);
    await saveIndexEntry(st, finalItem);
    Object.assign(item, finalState);
    item.offlineUrl = finalItem.offlineUrl;
    emitEvent(st, 'done', item);
  } catch (err) {
    const reason = job.controller.signal.aborted && job.controller.signal.reason != null
      ? String(job.controller.signal.reason)
      : (err && err.code === 'aborted' ? String(err.reason || '') : '');

    if (reason === 'pause') {
      item.status = 'paused';
      item.speedBps = 0;
      item.etaSec = 0;
      await saveItemState(st, item);
      emitEvent(st, 'queue', item);
    } else if (reason === 'cancel') {
      /* cancelar NÃO apaga arquivos: o retry retoma de onde parou; excluir apaga */
      item.status = 'canceled';
      item.speedBps = 0;
      item.etaSec = 0;
      item.error = '';
      await saveItemState(st, item);
      emitEvent(st, 'queue', item);
    } else if (reason === 'remove' || reason === 'shutdown') {
      item.status = 'paused';
      item.speedBps = 0;
      item.etaSec = 0;
      if (reason === 'shutdown') await saveItemState(st, item);
    } else {
      item.status = 'error';
      item.error = friendlyDownloadError(err);
      item.speedBps = 0;
      item.etaSec = 0;
      st.log('[downloads] falha em "' + path.basename(dir) + '": ' + scrubText(err && err.message));
      await saveItemState(st, item);
      emitEvent(st, 'error', item);
    }
  } finally {
    st.active.delete(item.id);
    pump(st);
  }
}

/* -------------------------------------------------------------------------- */
/* Ações sobre itens                                                          */
/* -------------------------------------------------------------------------- */

async function addItem(st, raw) {
  await st.ready;
  if (st.initError) return { ok: false, error: st.initError };
  let req;
  try {
    req = validateRequest(raw);
  } catch (err) {
    return { ok: false, error: friendlyDownloadError(err) };
  }

  const existing = findExisting(st, req);
  if (existing) {
    if (existing.status === 'error' || existing.status === 'canceled') {
      existing.sourceUrl = req.url;
      existing.headers = req.headers;
      existing.engine = req.engine;
      existing.variantId = req.variantId;
      existing.totalBytes = req.totalBytes || existing.totalBytes || 0;
      existing.durationSec = req.durationSec || existing.durationSec || 0;
      enqueue(st, existing);
      await saveItemState(st, existing);
      emitEvent(st, 'queue', existing);
      pump(st);
      return { ok: true, id: existing.id, retried: true };
    }
    return { ok: false, error: 'Este conteúdo já está baixado ou na fila. Gerencie pela tela Baixados.' };
  }

  try {
    await paths.ensureDir(st.downloadsDir);
  } catch (err) {
    return { ok: false, error: 'Não foi possível criar a pasta de downloads: ' + scrubText(err.message) };
  }

  const free = await paths.freeBytes(st.downloadsDir).catch(function () { return null; });
  const needed = Math.max(0, req.totalBytes) + SPACE_MARGIN_BYTES;
  if (free != null && free < needed) {
    return {
      ok: false,
      error: 'Espaço insuficiente em disco. Necessário ~' + paths.formatBytes(needed) +
        ', disponível ' + paths.formatBytes(free) + '.'
    };
  }

  const taken = await takenDirNames(st);
  const dirName = paths.buildDirName({
    kind: req.kind,
    title: req.title,
    year: req.year,
    season: req.season,
    episode: req.episode,
    episodeTitle: req.episodeTitle
  }, taken);

  const item = {
    id: crypto.randomUUID(),
    kind: req.kind,
    title: req.title,
    subtitle: req.subtitle,
    poster: req.poster,
    listId: req.listId,
    itemId: req.itemId,
    epId: req.epId,
    season: req.season,
    episode: req.episode,
    year: req.year,
    status: 'queued',
    progress: 0,
    bytes: 0,
    totalBytes: req.totalBytes || 0,
    speedBps: 0,
    etaSec: 0,
    error: '',
    dirName: dirName,
    createdAt: Date.now(),
    completedAt: 0,
    durationSec: req.durationSec || 0,
    engine: req.engine,
    variantId: req.variantId,
    variantLabel: req.variantLabel,
    sizeBytes: 0,
    sourceUrl: req.url,
    headers: req.headers,
    files: [],
    playlist: { master: '', variant: '' },
    offlineUrl: ''
  };
  st.items.set(item.id, item);
  enqueue(st, item);

  try {
    await saveIndexEntry(st, item);
  } catch (err) {
    st.items.delete(item.id);
    st.queue = st.queue.filter(function (id) { return id !== item.id; });
    return { ok: false, error: 'Não foi possível registrar o download: ' + scrubText(err.message) };
  }
  emitEvent(st, 'queue', item);
  pump(st);
  return { ok: true, id: item.id };
}

function findExisting(st, req) {
  for (const item of st.items.values()) {
    if (item.kind !== req.kind) continue;
    if (item.listId !== req.listId) continue;
    if (item.itemId !== req.itemId) continue;
    if ((item.epId || '') !== (req.epId || '')) continue;
    return item;
  }
  return null;
}

async function takenDirNames(st) {
  const taken = new Set();
  for (const item of st.items.values()) taken.add(item.dirName.toLowerCase());
  try {
    const entries = await fsp.readdir(st.downloadsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) taken.add(entry.name.toLowerCase());
    }
  } catch (e) { /* pasta ainda não existe */ }
  return taken;
}

async function pauseItem(st, id) {
  await st.ready;
  const item = st.items.get(id);
  if (!item) return { ok: false, error: 'Download não encontrado.' };
  if (item.status === 'queued') {
    st.queue = st.queue.filter(function (q) { return q !== id; });
    item.status = 'paused';
    await saveItemState(st, item);
    emitEvent(st, 'queue', item);
    return { ok: true };
  }
  const job = st.active.get(id);
  if (job) {
    try { job.controller.abort('pause'); } catch (e) { /* ignore */ }
    return { ok: true };
  }
  return { ok: false, error: 'Este download não está em andamento.' };
}

async function resumeItem(st, id) {
  await st.ready;
  const item = st.items.get(id);
  if (!item) return { ok: false, error: 'Download não encontrado.' };
  if (item.status !== 'paused') return { ok: false, error: 'Este download não está pausado.' };
  enqueue(st, item);
  await saveItemState(st, item);
  emitEvent(st, 'queue', item);
  pump(st);
  return { ok: true };
}

async function retryItem(st, id) {
  await st.ready;
  const item = st.items.get(id);
  if (!item) return { ok: false, error: 'Download não encontrado.' };
  if (item.status !== 'error' && item.status !== 'canceled' && item.status !== 'paused') {
    return { ok: false, error: 'Só é possível tentar novamente downloads com erro, cancelados ou pausados.' };
  }
  enqueue(st, item);
  await saveItemState(st, item);
  emitEvent(st, 'queue', item);
  pump(st);
  return { ok: true };
}

async function cancelItem(st, id) {
  await st.ready;
  const item = st.items.get(id);
  if (!item) return { ok: false, error: 'Download não encontrado.' };
  if (item.status === 'done') return { ok: false, error: 'Este download já terminou. Use Excluir para apagá-lo.' };
  if (item.status === 'canceled') return { ok: true };
  if (item.status === 'queued') {
    st.queue = st.queue.filter(function (q) { return q !== id; });
    item.status = 'canceled';
    item.speedBps = 0;
    item.etaSec = 0;
    await saveItemState(st, item);
    emitEvent(st, 'queue', item);
    return { ok: true };
  }
  const job = st.active.get(id);
  if (job) {
    try { job.controller.abort('cancel'); } catch (e) { /* ignore */ }
    return { ok: true };
  }
  item.status = 'canceled';
  item.speedBps = 0;
  item.etaSec = 0;
  await saveItemState(st, item);
  emitEvent(st, 'queue', item);
  return { ok: true };
}

async function removeItem(st, id, options) {
  await st.ready;
  const item = st.items.get(id);
  if (!item) return { ok: true };
  const job = st.active.get(id);
  if (job) {
    try { job.controller.abort('remove'); } catch (e) { /* ignore */ }
    try { await job.promise; } catch (e) { /* ignore */ }
  }
  st.queue = st.queue.filter(function (q) { return q !== id; });

  const deleteFiles = !options || options.deleteFiles !== false;
  if (deleteFiles) {
    try {
      await manifests.deleteManagedItem(st.downloadsDir, item.dirName);
    } catch (err) {
      if (err && err.code === 'PATH_TRAVERSAL') {
        return { ok: false, error: 'Não foi possível apagar: a pasta do item está fora da pasta de downloads.' };
      }
      if (err && err.code === 'PATH_NOT_FOUND') {
        /* pasta de downloads sumiu: segue removendo só a entrada */
      } else if (err && err.code === 'EBUSY') {
        return { ok: false, error: 'A pasta do item está em uso. Feche o player e tente de novo.' };
      } else {
        st.log('[downloads] remoção de arquivos: ' + scrubText(err && err.message));
      }
    }
  }
  st.items.delete(id);
  st.manifestCache.delete(id);
  try { await removeIndexEntry(st, id); } catch (err) { st.log('[downloads] índice (remoção): ' + scrubText(err.message)); }
  emitEvent(st, 'removed', item);
  pump(st);
  return { ok: true };
}

async function revealItem(st, id) {
  await st.ready;
  const shell = st.shell || (electronApi() && electronApi().shell);
  if (!shell) return { ok: false, error: 'Recurso disponível apenas no aplicativo desktop.' };
  const item = st.items.get(id);
  if (!item) return { ok: false, error: 'Download não encontrado.' };
  let dir;
  try { dir = paths.itemDir(st.downloadsDir, item.dirName); } catch (e) { return { ok: false, error: 'Caminho inválido.' }; }
  if (!(await isDirectory(dir))) return { ok: false, error: 'A pasta deste download não existe mais.' };
  const video = path.join(dir, 'video.mp4');
  try {
    if (await sizeOf(video) > 0) shell.showItemInFolder(video);
    else shell.openPath(dir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'Não foi possível abrir a pasta: ' + scrubText(err && err.message) };
  }
}

async function openDownloadsFolder(st) {
  await st.ready;
  const shell = st.shell || (electronApi() && electronApi().shell);
  if (!shell) return { ok: false, error: 'Recurso disponível apenas no aplicativo desktop.' };
  try {
    await paths.ensureDir(st.downloadsDir);
    const err = await shell.openPath(st.downloadsDir);
    return err ? { ok: false, error: 'Não foi possível abrir a pasta: ' + scrubText(err) } : { ok: true };
  } catch (err) {
    return { ok: false, error: 'Não foi possível abrir a pasta: ' + scrubText(err && err.message) };
  }
}

async function listPublic(st) {
  /* Nunca deixa o renderer em "Carregando downloads..." para sempre: se a
     inicialização da pasta travar (I/O, caminho inválido), respondemos com o
     que já está em memória e um aviso; a próxima chamada tenta de novo. */
  var timedOut = false;
  try {
    var winner = await Promise.race([
      Promise.resolve(st.ready).then(function () { return 'ready'; }),
      new Promise(function (resolve) { var t = setTimeout(function () { resolve('timeout'); }, 3000); if (t && t.unref) t.unref(); })
    ]);
    timedOut = winner === 'timeout';
  } catch (e) { /* loadState não rejeita, mas por garantia */ }
  const items = Array.from(st.items.values())
    .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
    .map(publicItem);
  const error = st.initError || (timedOut ? 'A pasta de downloads demorou para responder. Tente "Atualizar".' : '');
  return { items: items, stats: statsOf(st), error: error };
}

/* -------------------------------------------------------------------------- */
/* Validação do pedido                                                        */
/* -------------------------------------------------------------------------- */

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 300);
}

function httpUrlOf(raw) {
  const url = cleanText(raw, 4096);
  if (!/^https?:\/\/\S+$/i.test(url)) throw new DownloadError('URL do conteúdo inválida.', 'invalid');
  let parsed;
  try { parsed = new URL(url); } catch (e) { throw new DownloadError('URL do conteúdo inválida.', 'invalid'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DownloadError('Apenas URLs http:// e https:// são aceitas.', 'invalid');
  }
  if (parsed.username || parsed.password) {
    throw new DownloadError('URL com credenciais embutidas não é suportada.', 'invalid');
  }
  return { url: parsed.href, parsed: parsed };
}

function sanitizeRequestHeaders(raw) {
  const out = {};
  const allowed = { 'user-agent': 1, 'referer': 1, 'origin': 1, 'accept': 1, 'accept-language': 1 };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    const name = String(key).toLowerCase();
    if (!allowed[name]) continue;
    const value = cleanText(raw[key], 2048).replace(/\s+/g, ' ');
    if (value) out[name] = value;
  }
  return out;
}

function validateRequest(raw) {
  if (!raw || typeof raw !== 'object') throw new DownloadError('Pedido de download inválido.', 'invalid');
  const kind = raw.kind === 'episode' ? 'episode' : raw.kind === 'movie' ? 'movie' : null;
  if (!kind) throw new DownloadError('Tipo de download inválido.', 'invalid');
  const title = cleanText(raw.title, 300);
  if (!title) throw new DownloadError('Título do download ausente.', 'invalid');
  const { url, parsed } = httpUrlOf(raw.url);
  const engine = raw.engine === 'hls' || raw.engine === 'mp4'
    ? raw.engine
    : (/\.m3u8?$/i.test(parsed.pathname) ? 'hls' : 'mp4');
  return {
    kind: kind,
    title: title,
    subtitle: cleanText(raw.subtitle, 300),
    poster: /^https?:\/\//i.test(cleanText(raw.poster, 4096)) ? cleanText(raw.poster, 4096) : '',
    listId: cleanText(raw.listId, 128),
    itemId: cleanText(raw.itemId, 128),
    epId: cleanText(raw.epId, 128),
    season: Math.max(0, Math.floor(Number(raw.season) || 0)),
    episode: Math.max(0, Math.floor(Number(raw.episode) || 0)),
    episodeTitle: cleanText(raw.episodeTitle || (kind === 'episode' ? raw.subtitle : ''), 120),
    year: /^(19|20)\d{2}$/.test(String(raw.year || '').trim()) ? String(raw.year).trim() : '',
    durationSec: Math.max(0, Number(raw.durationSec) || 0),
    totalBytes: Math.max(0, Math.floor(Number(raw.totalBytes) || 0)),
    engine: engine,
    variantId: cleanText(raw.variantId, 64),
    variantLabel: cleanText(raw.variantLabel, 120),
    url: url,
    headers: sanitizeRequestHeaders(raw.headers)
  };
}

/* -------------------------------------------------------------------------- */
/* Sondagem (probe)                                                           */
/* -------------------------------------------------------------------------- */

function labelForBinary(url) {
  const ext = paths.extOf((function () { try { return new URL(url).pathname; } catch (e) { return url; } })());
  const map = { mp4: 'MP4', mkv: 'MKV', webm: 'WEBM', avi: 'AVI', mov: 'MOV', m4v: 'M4V', ts: 'MPEG-TS' };
  return map[ext] || 'Vídeo';
}

async function probeBinary(st, url, headers, signal) {
  const link = linkAbort(signal, PROBE_TIMEOUT_MS);
  let res;
  try {
    res = await st.fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: link.signal,
      headers: Object.assign({}, headers, { range: 'bytes=0-0', accept: '*/*', 'accept-encoding': 'identity' })
    });
  } catch (err) {
    link.cleanup();
    if (signal && signal.aborted) throw abortReason({ controller: { signal: signal } });
    if (link.timedOut()) throw new DownloadError('O servidor demorou demais para responder.', 'timeout');
    throw new DownloadError('Não foi possível acessar o servidor do conteúdo.', 'network', { cause: err });
  }
  try {
    if (res.status !== 200 && res.status !== 206) {
      if (res.status === 416) {
        /* arquivo vazio ou servidor sem suporte: tenta sem Range */
        if (res.body) { try { await res.body.cancel(); } catch (e) { /* ignore */ } }
        const second = await st.fetchImpl(url, { method: 'GET', redirect: 'follow', signal: link.signal, headers: headers });
        return await binaryInfoFromResponse(st, url, second);
      }
      throw new DownloadError(
        res.status === 401 || res.status === 403
          ? 'O servidor recusou o acesso (HTTP ' + res.status + '). Verifique a lista/provedor.'
          : 'O servidor respondeu HTTP ' + res.status + '.',
        'http',
        { status: res.status }
      );
    }
    return await binaryInfoFromResponse(st, url, res);
  } finally {
    link.cleanup();
  }
}

async function binaryInfoFromResponse(st, url, res) {
  const contentType = res.headers.get('content-type') || '';
  if (/text\/html|application\/xhtml/i.test(contentType)) {
    if (res.body) { try { await res.body.cancel(); } catch (e) { /* ignore */ } }
    throw new DownloadError('O servidor devolveu uma página em vez do vídeo. Verifique a lista/proxy.', 'invalid');
  }
  const cr = parseContentRange(res.headers.get('content-range'));
  const totalBytes = cr && cr.total ? cr.total : contentLengthOf(res);
  if (res.body) { try { await res.body.cancel(); } catch (e) { /* ignore */ } }
  return { totalBytes: totalBytes || 0, label: labelForBinary(url), contentType: contentType };
}

async function probeOneUrl(st, url, headers, signal) {
  try {
    const info = await hls.probe(url, {
      headers: headers,
      signal: signal,
      fetchImpl: st.fetchImpl,
      timeoutMs: PROBE_TIMEOUT_MS
    });
    if (info.variants && info.variants.length) {
      return { variants: info.variants, durationSec: info.durationSec || 0 };
    }
  } catch (err) {
    if (!err || err.code !== 'not-playlist') throw err;
  }
  const binary = await probeBinary(st, url, headers, signal);
  const ext = paths.extOf((function () { try { return new URL(url).pathname; } catch (e) { return url; } })());
  const kind = ext === 'mkv' || ext === 'avi' || ext === 'mov' || ext === 'webm' ? 'mp4' : 'mp4';
  return {
    variants: [{
      id: 'source',
      url: url,
      kind: kind,
      label: binary.label + (binary.totalBytes ? ' • ' + paths.formatBytes(binary.totalBytes) : ''),
      resolution: '',
      codecs: '',
      bandwidth: 0,
      estimatedBytes: binary.totalBytes || 0
    }],
    durationSec: 0
  };
}

async function probeUrls(st, payload) {
  await st.ready;
  const body = payload && typeof payload === 'object' ? payload : {};
  const headers = sanitizeRequestHeaders(body.headers);
  const durationSec = Math.max(0, Number(body.durationSec) || 0);
  const urls = [];
  const seen = new Set();
  if (Array.isArray(body.urls)) {
    for (const raw of body.urls) {
      if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw.trim())) continue;
      const url = raw.trim();
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= PROBE_MAX_URLS) break;
    }
  }
  if (!urls.length) return { variants: [], error: 'Nenhuma URL de mídia foi informada.' };

  let lastError = null;
  let drm = null;
  for (const url of urls) {
    try {
      const result = await probeOneUrl(st, url, headers, null);
      if (result.variants.length) {
        if (durationSec > 0) {
          for (const variant of result.variants) {
            if (!variant.estimatedBytes && variant.bandwidth) {
              variant.estimatedBytes = Math.floor(durationSec * variant.bandwidth / 8);
            }
          }
        }
        return { variants: result.variants, durationSec: result.durationSec || durationSec || 0 };
      }
    } catch (err) {
      if (err && err.code === 'drm') { drm = err; continue; }
      lastError = err;
      st.log('[downloads] probe falhou: ' + scrubText(err && err.message));
    }
  }
  if (drm) return { variants: [], error: drm.message || hls.DRM_MESSAGE, code: 'drm' };
  return { variants: [], error: friendlyDownloadError(lastError) };
}

/* -------------------------------------------------------------------------- */
/* /offline/<id>/<rel>                                                        */
/* -------------------------------------------------------------------------- */

function sendText(res, status, text, extra) {
  if (!res || res.destroyed || res.writableEnded) return;
  const body = Buffer.from(String(text == null ? '' : text) + '\n', 'utf8');
  try {
    res.writeHead(status, Object.assign({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }, extra || {}));
    res.end(res.req && res.req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    try { res.destroy(); } catch (e2) { /* ignore */ }
  }
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch (e) { return null; }
}

function mimeOf(file) {
  return MIME[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

function parseRangeHeader(header, size) {
  const raw = String(header == null ? '' : header).trim();
  if (!raw) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!m) return null;                  /* multi-range/estranho: serve completo */
  if (m[1] === '' && m[2] === '') return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { invalid: true };
  }
  return { start: start, end: end };
}

async function serveItemFile(res, file, stat) {
  const headers = {
    'Content-Type': mimeOf(file),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes'
  };
  const range = parseRangeHeader(res.req && res.req.headers ? res.req.headers.range : '', stat.size);
  if (range && range.invalid) {
    headers['Content-Range'] = 'bytes */' + stat.size;
    headers['Content-Length'] = 0;
    try { res.writeHead(416, headers); res.end(); } catch (e) { /* ignore */ }
    return;
  }
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range) {
    start = range.start;
    end = range.end;
    status = 206;
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  try { res.writeHead(status, headers); } catch (e) { return; }
  if ((res.req && res.req.method === 'HEAD') || stat.size === 0) {
    try { res.end(); } catch (e) { /* ignore */ }
    return;
  }
  const stream = fs.createReadStream(file, { start: start, end: end });
  stream.on('error', function () {
    try { if (!res.headersSent) sendText(res, 404, 'Arquivo não encontrado.'); else res.destroy(); } catch (e) { /* ignore */ }
  });
  res.on('close', function () {
    if (!res.writableEnded) stream.destroy();
  });
  stream.pipe(res);
}

async function loadManifestForItem(st, id) {
  if (st.manifestCache.has(id)) return st.manifestCache.get(id);
  const item = st.items.get(id);
  if (!item) return null;
  let dir;
  try { dir = paths.itemDir(st.downloadsDir, item.dirName); } catch (e) { return null; }
  const manifest = await manifests.readManifest(dir);
  if (!manifest || manifest.id !== id) return null;
  st.manifestCache.set(id, manifest);
  return manifest;
}

async function offlineHandler(st, req, res, ctx) {
  try {
    await st.ready;
    if (st.initError) return sendText(res, 503, 'A pasta de downloads não está disponível.');
    if (!req || (req.method !== 'GET' && req.method !== 'HEAD')) {
      return sendText(res, 405, 'Método não permitido.', { Allow: 'GET, HEAD' });
    }
    let pathname;
    try {
      pathname = ctx && typeof ctx.pathname === 'string'
        ? ctx.pathname
        : new URL(String(req.url || ''), 'http://127.0.0.1').pathname;
    } catch (e) {
      return sendText(res, 400, 'Requisição inválida.');
    }
    if (pathname.indexOf('/offline/') !== 0) return sendText(res, 404, 'Não encontrado.');
    const rest = pathname.slice('/offline/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return sendText(res, 404, 'Não encontrado.');
    const id = safeDecode(rest.slice(0, slash));
    const relDecoded = safeDecode(rest.slice(slash + 1));
    if (!id || relDecoded == null) return sendText(res, 400, 'Caminho inválido.');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return sendText(res, 404, 'Download não encontrado.');
    let rel;
    try {
      rel = paths.normalizeRelPath(relDecoded);
    } catch (e) {
      return sendText(res, 400, 'Caminho inválido.');
    }
    const item = st.items.get(id);
    if (!item) return sendText(res, 404, 'Download não encontrado.');
    if (item.status !== 'done') return sendText(res, 409, 'Este download ainda não foi concluído.');
    const manifest = await loadManifestForItem(st, id);
    if (!manifest) return sendText(res, 404, 'Manifesto do download não encontrado.');
    const allowed = (manifest.files || []).some(function (file) { return file.path === rel; });
    if (!allowed) return sendText(res, 404, 'Arquivo não faz parte deste download.');
    let itemDir;
    try { itemDir = paths.itemDir(st.downloadsDir, item.dirName); } catch (e) { return sendText(res, 404, 'Não encontrado.'); }
    let file;
    try { file = paths.resolveInside(itemDir, rel); } catch (e) { return sendText(res, 400, 'Caminho inválido.'); }
    try {
      await paths.assertRealInside(st.downloadsDir, file);
    } catch (e) {
      return sendText(res, 404, 'Arquivo não encontrado.');
    }
    let stat;
    try { stat = await fsp.stat(file); } catch (e) { return sendText(res, 404, 'Arquivo não encontrado.'); }
    if (!stat.isFile()) return sendText(res, 404, 'Arquivo não encontrado.');
    return await serveItemFile(res, file, stat);
  } catch (err) {
    st.log('[downloads] /offline: ' + scrubText(err && err.message));
    if (!res || res.destroyed || res.headersSent) {
      try { if (res && !res.destroyed) res.destroy(); } catch (e) { /* ignore */ }
      return;
    }
    return sendText(res, 500, 'Erro ao abrir o arquivo do download.');
  }
}

/* -------------------------------------------------------------------------- */
/* IPC                                                                        */
/* -------------------------------------------------------------------------- */

function registerIpc(st) {
  const ipc = st.ipcMain;
  if (!ipc || typeof ipc.handle !== 'function') return false;
  const definitions = [
    [CH.DL_PROBE, function (event, payload) { return probeUrls(st, payload); }],
    [CH.DL_ADD, function (event, req) { return addItem(st, req); }],
    [CH.DL_PAUSE, function (event, id) { return pauseItem(st, String(id || '')); }],
    [CH.DL_RESUME, function (event, id) { return resumeItem(st, String(id || '')); }],
    [CH.DL_CANCEL, function (event, id) { return cancelItem(st, String(id || '')); }],
    [CH.DL_RETRY, function (event, id) { return retryItem(st, String(id || '')); }],
    [CH.DL_REMOVE, function (event, idOrPayload, options) {
      /* o preload chama remove(id, {deleteFiles}) e envia UM objeto
         {id, deleteFiles}; aceitamos também (id, options) posicional. */
      if (idOrPayload && typeof idOrPayload === 'object') {
        return removeItem(st, String(idOrPayload.id || ''), {
          deleteFiles: idOrPayload.deleteFiles !== false
        });
      }
      return removeItem(st, String(idOrPayload || ''), options);
    }],
    [CH.DL_LIST, function () { return listPublic(st); }],
    [CH.DL_REVEAL, function (event, id) { return revealItem(st, String(id || '')); }],
    [CH.DL_OPEN_FOLDER, function () { return openDownloadsFolder(st); }]
  ];
  for (const def of definitions) {
    const channel = def[0];
    const fn = def[1];
    try { if (typeof ipc.removeHandler === 'function') ipc.removeHandler(channel); } catch (e) { /* ignore */ }
    ipc.handle(channel, async function (event) {
      const args = Array.prototype.slice.call(arguments, 1);
      try {
        return await fn.apply(null, [event].concat(args));
      } catch (err) {
        st.log('[downloads] IPC ' + channel + ': ' + scrubText(err && err.message));
        const isList = channel === CH.DL_LIST || channel === CH.DL_PROBE;
        if (isList) return { variants: [], items: [], stats: emptyStats(), error: friendlyDownloadError(err) };
        return { ok: false, error: friendlyDownloadError(err) };
      }
    });
  }
  st.ipcRegistered = true;
  return true;
}

function unregisterIpc(st) {
  if (!st || !st.ipcMain || !st.ipcRegistered) return;
  const ipc = st.ipcMain;
  for (const key of Object.keys(CH)) {
    const channel = CH[key];
    if (typeof channel !== 'string' || channel.indexOf('space:downloads:') !== 0) continue;
    try { if (typeof ipc.removeHandler === 'function') ipc.removeHandler(channel); } catch (e) { /* ignore */ }
  }
  st.ipcRegistered = false;
}

/* -------------------------------------------------------------------------- */
/* Carga inicial / recuperação                                                */
/* -------------------------------------------------------------------------- */

async function loadState(st) {
  try {
    await paths.ensureDir(st.downloadsDir);
  } catch (err) {
    st.initError = 'Não foi possível abrir a pasta de downloads: ' + scrubText(err && err.message);
    st.log('[downloads] ' + st.initError);
    return;
  }
  let records;
  try {
    records = await st.store.read();
  } catch (err) {
    st.log('[downloads] índice: ' + scrubText(err && err.message));
    records = { items: [] };
  }
  const keep = [];
  let changed = false;

  for (const rec of records.items) {
    const item = itemFromIndexRecord(rec);
    st.items.set(item.id, item);
    const dir = path.join(st.downloadsDir, item.dirName);
    let dirExists = await isDirectory(dir);
    if (!dirExists && item.status !== 'canceled') {
      /* entrada fantasma (pasta apagada por fora): remove do índice */
      st.items.delete(item.id);
      changed = true;
      continue;
    }
    if (dirExists) {
      const manifest = await manifests.readManifest(dir);
      if (manifest && manifest.id === item.id) {
        st.manifestCache.set(item.id, manifest);
        if (manifest.files && manifest.files.length) {
          item.files = manifest.files;
          item.playlist = manifest.playlist || { master: '', variant: '' };
          item.sizeBytes = manifest.sizeBytes || 0;
        }
        if (manifest.engine) item.engine = manifest.engine;
        if (manifest.completedAt) item.completedAt = manifest.completedAt;
        item.offlineUrl = offlineUrlFor(item);
        if (item.status === 'done') {
          if (!manifest.files.length) {
            item.status = 'error';
            item.error = 'O manifesto deste download não tem arquivos.';
            changed = true;
          } else {
            const missing = [];
            for (const file of manifest.files) {
              let abs;
              try { abs = paths.resolveInside(dir, file.path); } catch (e) { missing.push(file.path); continue; }
              if (!(await sizeOf(abs) > 0)) missing.push(file.path);
            }
            if (missing.length) {
              item.status = 'error';
              item.error = 'Arquivos do download estão faltando na pasta.';
              changed = true;
            }
          }
        }
      } else if (item.status === 'done') {
        item.status = 'error';
        item.error = 'Manifesto do download não encontrado.';
        changed = true;
      }
    }
    if (item.status === 'downloading' || item.status === 'packaging') {
      item.status = 'paused';
      changed = true;
    }
    /* app fechou entre o rename do MP4 e a gravação do manifesto/manifesto antigo */
    if (item.engine !== 'hls' && item.status !== 'done' && dirExists) {
      const finalSize = await sizeOf(path.join(dir, 'video.mp4'));
      if (finalSize > 0 && (!item.totalBytes || finalSize === item.totalBytes)) {
        item.status = 'done';
        item.bytes = finalSize;
        item.totalBytes = finalSize;
        item.sizeBytes = finalSize;
        item.progress = 1;
        item.completedAt = item.completedAt || Date.now();
        item.files = [{ path: 'video.mp4', size: finalSize }];
        item.playlist = { master: '', variant: '' };
        item.offlineUrl = offlineUrlFor(item);
        changed = true;
      }
    }
    if (item.status === 'queued') st.queue.push(item.id);
    keep.push(indexRecordFromItem(item));
  }

  records.items = keep;
  if (changed) {
    try {
      await st.store.update(function (index) { index.items = keep; });
    } catch (err) {
      st.log('[downloads] recuperação: ' + scrubText(err && err.message));
    }
  }
  pump(st);
}

/* -------------------------------------------------------------------------- */
/* Estado                                                                     */
/* -------------------------------------------------------------------------- */

function createState(downloadsDir, config, ctx) {
  const st = {
    downloadsDir: downloadsDir,
    config: config || {},
    emit: createEmitter(ctx || {}),
    ipcMain: (ctx && ctx.ipcMain) || null,
    shell: (ctx && ctx.shell) || null,
    store: manifests.createStore(downloadsDir),
    items: new Map(),
    active: new Map(),
    queue: [],
    manifestCache: new Map(),
    pumping: false,
    disposed: false,
    ready: null,
    initError: '',
    ipcRegistered: false,
    handlers: null,
    allow: { any: false, hosts: new Set(), suffixes: new Set() },
    externalAllow: null,
    fetchImpl: (typeof fetch === 'function' ? fetch : null),
    log: function () {
      if (typeof (ctx && ctx.log) === 'function') { ctx.log.apply(null, arguments); return; }
      try { console.log.apply(console, arguments); } catch (e) { /* ignore */ }
    }
  };
  st.emitSafe = function (channel, payload) {
    try { st.emit(channel, payload); } catch (e) { /* ignore */ }
  };
  applyMediaHosts(st, pendingMediaHosts);
  st.ready = loadState(st).catch(function (err) {
    st.initError = friendlyDownloadError(err);
    st.log('[downloads] carga: ' + scrubText(err && err.message));
  });
  return st;
}

/**
 * Garante o estado singleton para a pasta de downloads da config.
 * @param {{config?:object, emit?:Function, ipcMain?:object, shell?:object, log?:Function, getMainWindow?:Function}} ctx
 */
function ensureState(ctx) {
  const config = (ctx && ctx.config) || {};
  /* `createHandlers` pode receber um config parcial (server.js só repassa
     config/emit/isHostAllowed): sem downloadsDir explícito, reaproveita o estado
     já criado pelo initDownload em vez de recriar/derrubar a fila. */
  const rawDir = config && typeof config.downloadsDir === 'string' ? config.downloadsDir.trim() : '';
  if (!rawDir && state) {
    if (ctx) {
      if (typeof ctx.emit === 'function') state.emit = createEmitter(ctx);
      if (ctx.ipcMain) state.ipcMain = ctx.ipcMain;
      if (ctx.shell) state.shell = ctx.shell;
    }
    return state;
  }
  const dir = resolveDownloadsDir(config);
  if (state && path.resolve(state.downloadsDir).toLowerCase() === dir.toLowerCase()) {
    if (ctx) {
      if (typeof ctx.emit === 'function') state.emit = createEmitter(ctx);
      if (ctx.ipcMain) state.ipcMain = ctx.ipcMain;
      if (ctx.shell) state.shell = ctx.shell;
    }
    state.config = config;
    return state;
  }
  if (state) {
    try { disposeState(state); } catch (e) { /* ignore */ }
  }
  state = createState(dir, config, ctx || {});
  return state;
}

function ensureHandlers(st, origin) {
  if (st.handlers) {
    if (origin && !st.handlers.origin) st.handlers.origin = origin;
    return st.handlers;
  }
  const proxy = createMediaProxy({
    isHostAllowed: function (host) { return hostAllowed(st, host); },
    log: function (msg) { st.log(msg); },
    origin: origin || null,
    fetchImpl: st.fetchImpl
  });
  st.handlers = {
    mediaProxy: function (req, res, url, ctx) { return proxy(req, res, url, ctx); },
    offline: function (req, res, ctx) { return offlineHandler(st, req, res, ctx); },
    isHostAllowed: function (host) { return hostAllowed(st, host); },
    ping: function () { return pingPayload(getMediaHosts()); },
    origin: origin || null
  };
  return st.handlers;
}

async function disposeState(st) {
  if (!st) return;
  st.disposed = true;
  unregisterIpc(st);
  const jobs = Array.from(st.active.values());
  for (const job of jobs) {
    try { job.controller.abort('shutdown'); } catch (e) { /* ignore */ }
  }
  if (jobs.length) {
    const all = Promise.allSettled(jobs.map(function (job) { return job.promise; }));
    await Promise.race([all, sleep(SHUTDOWN_WAIT_MS)]);
  }
  try { await st.store.flush(); } catch (e) { /* ignore */ }
  if (state === st) state = null;
}

/* -------------------------------------------------------------------------- */
/* API pública                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Inicializa os downloads no processo principal: carrega índice/manifestos e
 * registra os handlers IPC dos canais `DL_*`.
 *
 * @param {{
 *   config: object,
 *   emit: (channel:string, payload:any)=>void,
 *   getMainWindow?: ()=>any,
 *   app?: any,
 *   ipcMain?: object,
 *   shell?: object,
 *   log?: Function
 * }} ctx
 * @returns {{dispose:()=>Promise<void>, list:()=>Promise<{items:object[],stats:object}>, handlers:object}}
 */
function initDownload(ctx) {
  const c = ctx || {};
  let ipc = c.ipcMain || null;
  if (!ipc) {
    const electron = electronApi();
    if (electron) ipc = electron.ipcMain;
  }
  const st = ensureState(c);
  if (ipc) {
    st.ipcMain = ipc;
    registerIpc(st);
  } else {
    st.log('[downloads] ipcMain indisponível: IPC não registrado (teste fora do Electron?).');
  }
  if (!st.handlers) ensureHandlers(st);
  st.ready.then(function () { pump(st); }).catch(function () { /* loadState não rejeita */ });
  return {
    dispose: function () { return disposeState(st); },
    list: function () { return listPublic(st); },
    handlers: st.handlers,
    state: st
  };
}

/**
 * Handlers para o servidor interno montar `/media-proxy` e `/offline/*`.
 * Pode ser chamado antes ou depois de `initDownload`.
 *
 * @param {{config:object, emit?:Function, isHostAllowed?:Function, origin?:string, log?:Function}} opts
 * @returns {{mediaProxy:Function, offline:Function, isHostAllowed:Function, ping:Function}}
 */
function createHandlers(opts) {
  const o = opts || {};
  const st = ensureState({ config: o.config, emit: o.emit, log: o.log });
  if (typeof o.isHostAllowed === 'function') st.externalAllow = o.isHostAllowed;
  return ensureHandlers(st, o.origin);
}

/** Encerra fila e libera recursos (chamado no `will-quit` do main). */
function dispose() {
  return disposeState(state);
}

module.exports = {
  initDownload,
  createHandlers,
  dispose,
  registerMediaHosts,
  getMediaHosts,
  isHostAllowed: function (host) { return state ? hostAllowed(state, host) : false; },
  /* testes (qa-release também pode usar) */
  _internals: {
    CONCURRENCY,
    SPACE_MARGIN_BYTES,
    DownloadError,
    validateRequest,
    friendlyDownloadError,
    parseContentRange,
    parseUnsatisfiedTotal,
    parseRangeHeader,
    publicItem,
    offlineUrlFor,
    statsOf,
    recordFromItem: indexRecordFromItem,
    manifestFromItem,
    probeUrls,
    getState: function () { return state; },
    setStateForTests: function (value) { state = value; }
  }
};
