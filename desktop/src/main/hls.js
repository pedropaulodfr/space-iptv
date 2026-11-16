/* Empacotamento HLS offline do Space IPTV Desktop (sem FFmpeg).
 *
 * Fluxo: baixa a playlist (master e/ou variante), escolhe a variante, baixa
 * segmentos + init map + chaves AES-128 quando entregues diretamente pelo
 * provedor, reescreve a playlist local com caminhos RELATIVOS e devolve a lista
 * de arquivos para o manifesto (CONTRACTS.md §4).
 *
 * DRM: SAMPLE-AES/SAMPLE-AES-CTR, keyformat não-identity (Widevine/PlayReady/
 * FairPlay/`com.apple.streamingkeydelivery`) e `#EXT-X-SESSION-KEY` protegido
 * são RECUSADOS com mensagem clara, sem tentar contornar.
 *
 * Credenciais: a URL do provedor pode conter usuário/senha no caminho ou query.
 * Nada disso vai para nome de arquivo, playlist local, manifesto ou log.
 *
 * Node puro (sem Electron) e com `fetch` global injetável: testável com node.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const paths = require('./paths');

const fsp = fs.promises;

/** Mensagem única de recusa (CONTRACTS.md §4). */
const DRM_MESSAGE = 'Conteúdo protegido — não é possível baixar.';

const LIMITS = {
  playlistBytes: 8 * 1024 * 1024,
  keyBytes: 1024 * 1024,
  playlistTimeoutMs: 30000,
  keyTimeoutMs: 30000,
  segmentTimeoutMs: 300000,
  segmentConcurrency: 2,
  attempts: 3,
  retryDelayMs: 400
};

const PLAYLIST_EXTS = ['ts', 'm4s', 'mp4', 'm4v', 'aac', 'm4a', 'mp3', 'ac3', 'eac3', 'vtt', 'webvtt', 'cmfv', 'cmfa', 'key'];

/* -------------------------------------------------------------------------- */
/* Erros                                                                      */
/* -------------------------------------------------------------------------- */

class HlsError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.name = 'HlsError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

function drmError(reason) {
  const detail = reason ? ' Motivo: ' + reason + '.' : '';
  return new HlsError('drm', DRM_MESSAGE + detail, { reason: reason || 'proteção digital' });
}

function httpError(status, label) {
  let msg;
  if (status === 404 || status === 410) msg = 'Arquivo não encontrado no servidor (HTTP ' + status + ').';
  else if (status === 401 || status === 403) msg = 'O servidor recusou o download (HTTP ' + status + '). Verifique a lista/provedor.';
  else if (status === 416) msg = 'O servidor recusou a faixa pedida (HTTP 416).';
  else msg = 'O servidor respondeu HTTP ' + status + (label ? ' (' + label + ')' : '') + '.';
  return new HlsError('http', msg, { status: status });
}

function networkError(cause) {
  return new HlsError('network', 'Falha de rede ao baixar o conteúdo.', { cause: cause });
}

function timeoutError(label) {
  return new HlsError('timeout', 'Tempo esgotado ao baixar ' + (label || 'o conteúdo') + '.');
}

function abortedError() {
  return new HlsError('aborted', 'Download interrompido.');
}

function parseError(message) {
  return new HlsError('parse', message || 'Playlist HLS inválida.');
}

/* -------------------------------------------------------------------------- */
/* Atributos e detecção                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Parseia os atributos `CHAVE=valor` de uma tag HLS.
 * Valores entre aspas podem conter vírgulas (ex.: CODECS="avc1.4d401f,mp4a.40.2").
 * @param {string} text
 * @returns {Object<string,string>}
 */
function parseAttributes(text) {
  const out = {};
  const re = /([A-Za-z0-9_-]+)=("([^"]*)"|'([^']*)'|[^,]*)/g;
  let m;
  const src = String(text == null ? '' : text);
  while ((m = re.exec(src))) {
    const key = m[1].toUpperCase();
    let value = m[3] != null ? m[3] : m[4] != null ? m[4] : m[2];
    value = String(value == null ? '' : value).trim();
    out[key] = value;
  }
  return out;
}

const DRM_KEYFORMAT_RE = /com\.apple\.streamingkeydelivery|com\.microsoft\.playready|urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed|urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95|urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e|widevine|playready|fairplay|clearkey/i;
const PROTECTED_METHODS = new Set(['SAMPLE-AES', 'SAMPLE-AES-CTR', 'SAMPLE-AES-CENC']);
const KNOWN_METHODS = new Set(['NONE', 'AES-128', 'SAMPLE-AES', 'SAMPLE-AES-CTR', 'SAMPLE-AES-CENC']);

/**
 * Detecta proteção DRM na playlist (master ou variante).
 * Não tenta "resolver" nada: a presença de um sistema de chaves fechado já recusa.
 * @param {string} text
 * @returns {{reason:string, tag:string}|null}
 */
function detectDrm(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.indexOf('#EXT-X-KEY:') !== 0 && line.indexOf('#EXT-X-SESSION-KEY:') !== 0) continue;
    const tag = line.indexOf('#EXT-X-SESSION-KEY:') === 0 ? '#EXT-X-SESSION-KEY' : '#EXT-X-KEY';
    const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
    const method = String(attrs.METHOD || '').toUpperCase();
    const keyformat = String(attrs.KEYFORMAT || 'identity');
    const uri = String(attrs.URI || '');

    if (PROTECTED_METHODS.has(method)) return { reason: method, tag: tag };
    if (keyformat && keyformat.toLowerCase() !== 'identity') {
      const m = DRM_KEYFORMAT_RE.exec(keyformat);
      return { reason: m ? m[0] : 'keyformat=' + keyformat, tag: tag };
    }
    if (DRM_KEYFORMAT_RE.test(line)) return { reason: DRM_KEYFORMAT_RE.exec(line)[0], tag: tag };
    if (/^skd:/i.test(uri)) return { reason: 'FairPlay (skd://)', tag: tag };
    if (method && !KNOWN_METHODS.has(method)) return { reason: 'METHOD=' + method, tag: tag };
  }
  return null;
}

/** Recusa imediata se houver DRM; devolve normalmente quando não há. */
function assertNoDrm(text) {
  const drm = detectDrm(text);
  if (drm) throw drmError(drm.reason);
}

/** Conteúdo é master (tem variantes)? */
function isMasterText(text) {
  return /^#EXT-X-STREAM-INF:/m.test(String(text == null ? '' : text));
}

/** Conteúdo é playlist de mídia (segmentos)? */
function isMediaText(text) {
  return /^#EXT-X-(?:TARGETDURATION|MEDIA-SEQUENCE|INF):/m.test(String(text == null ? '' : text));
}

/** Texto parece uma playlist HLS (BOM/espaços tolerados). */
function looksLikePlaylist(text) {
  return String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/^\s+/, '').indexOf('#EXTM3U') === 0;
}

function absHttpUrl(uri, base) {
  if (!uri) return null;
  let u;
  try { u = new URL(String(uri).trim(), base); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) {
    /* credenciais embutidas em userinfo não são suportadas por fetch; tira */
    u.username = '';
    u.password = '';
  }
  return u.href;
}

function stableId(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}

/* -------------------------------------------------------------------------- */
/* Parser de master                                                           */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} text
 * @param {string} baseUrl URL final da playlist (resolver relativas)
 * @returns {{type:'master', version:number, variants:object[], media:object[]}}
 */
function parseMaster(text, baseUrl) {
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const variants = [];
  const media = [];
  let version = 3;
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.indexOf('#EXT-X-VERSION:') === 0) {
      version = Math.max(1, Math.floor(Number(line.slice(16)) || 3));
      continue;
    }
    if (line.indexOf('#EXT-X-MEDIA:') === 0) {
      const attrs = parseAttributes(line.slice(13));
      const uri = attrs.URI ? absHttpUrl(attrs.URI, baseUrl) : '';
      media.push({
        type: String(attrs.TYPE || '').toUpperCase(),
        groupId: attrs['GROUP-ID'] || '',
        name: attrs.NAME || '',
        language: attrs.LANGUAGE || '',
        assocLanguage: attrs['ASSOC-LANGUAGE'] || '',
        default: /YES/i.test(attrs.DEFAULT || ''),
        autoselect: /YES/i.test(attrs.AUTOSELECT || ''),
        forced: /YES/i.test(attrs.FORCED || ''),
        channels: attrs.CHANNELS || '',
        uri: uri || '',
        attrs: attrs
      });
      continue;
    }
    if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
      pending = parseAttributes(line.slice(18));
      continue;
    }
    if (line.charAt(0) === '#') continue;
    if (!pending) continue;
    const url = absHttpUrl(line, baseUrl);
    if (url) {
      const res = /^(\d+)x(\d+)$/i.exec(pending.RESOLUTION || '');
      const bandwidth = Math.max(0, Math.floor(Number(pending.BANDWIDTH || pending['AVERAGE-BANDWIDTH'] || 0) || 0));
      const average = Math.max(0, Math.floor(Number(pending['AVERAGE-BANDWIDTH'] || pending.BANDWIDTH || 0) || 0));
      variants.push({
        id: stableId(url),
        url: url,
        bandwidth: bandwidth,
        averageBandwidth: average,
        width: res ? Number(res[1]) : 0,
        height: res ? Number(res[2]) : 0,
        resolution: res ? res[1] + 'x' + res[2] : '',
        codecs: pending.CODECS || '',
        frameRate: Number(pending['FRAME-RATE']) || 0,
        audioGroup: pending.AUDIO || '',
        subtitleGroup: pending.SUBTITLES || '',
        attrs: pending
      });
    }
    pending = null;
  }
  return { type: 'master', version: version, variants: variants, media: media };
}

/* -------------------------------------------------------------------------- */
/* Parser de playlist de mídia                                                */
/* -------------------------------------------------------------------------- */

function parseByteRange(text, previous) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const m = /^(\d+)(?:@(\d+))?$/.exec(raw);
  if (!m) return null;
  const length = Number(m[1]);
  const offset = m[2] != null ? Number(m[2]) : (previous && previous.offset != null ? previous.offset + previous.length : 0);
  if (!length) return null;
  return { length: length, offset: offset };
}

/**
 * @param {string} text
 * @param {string} baseUrl URL final da playlist
 * @returns {{type:'media', version:number, targetDuration:number, mediaSequence:number,
 *            endList:boolean, keys:object[], maps:object[], segments:object[], durationSec:number}}
 */
function parseMedia(text, baseUrl) {
  const lines = String(text == null ? '' : text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const keys = [];
  const maps = [];
  const segments = [];
  const source = String(text == null ? '' : text);

  let version = 3;
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let pendingDuration = 0;
  let pendingTitle = '';
  let pendingByteRange = null;
  let pendingDiscontinuity = false;
  let pendingGap = false;
  let currentKey = -1;
  let currentMap = -1;
  let lastRange = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.indexOf('#EXT-X-VERSION:') === 0) {
      version = Math.max(1, Math.floor(Number(line.slice(16)) || 3));
      continue;
    }
    if (line.indexOf('#EXT-X-TARGETDURATION:') === 0) {
      targetDuration = Math.max(0, Number(line.slice(22)) || 0);
      continue;
    }
    if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
      mediaSequence = Math.max(0, Math.floor(Number(line.slice(22)) || 0));
      continue;
    }
    if (line === '#EXT-X-ENDLIST') { endList = true; continue; }
    if (line.indexOf('#EXT-X-KEY:') === 0) {
      const attrs = parseAttributes(line.slice(11));
      const method = String(attrs.METHOD || 'NONE').toUpperCase();
      if (method === 'NONE') {
        currentKey = -1;
        continue;
      }
      const uri = absHttpUrl(attrs.URI || '', baseUrl);
      const keyformat = String(attrs.KEYFORMAT || 'identity');
      if (keyformat.toLowerCase() !== 'identity') throw drmError(keyformat);
      if (PROTECTED_METHODS.has(method)) throw drmError(method);
      if (method !== 'AES-128') throw drmError('METHOD=' + method);
      if (!uri) throw parseError('Playlist criptografada sem URI da chave.');
      keys.push({ method: method, uri: uri, iv: attrs.IV || '', keyformat: 'identity', sig: method + '|' + uri + '|' + (attrs.IV || '') });
      currentKey = keys.length - 1;
      continue;
    }
    if (line.indexOf('#EXT-X-SESSION-KEY:') === 0) {
      /* SESSION-KEY em playlist de mídia não define criptografia de segmento;
         se tiver proteção, detectDrm já recusou antes. */
      continue;
    }
    if (line.indexOf('#EXT-X-MAP:') === 0) {
      const attrs = parseAttributes(line.slice(11));
      const uri = absHttpUrl(attrs.URI || '', baseUrl);
      if (!uri) throw parseError('Init map sem URI.');
      maps.push({
        uri: uri,
        byteRange: parseByteRange(attrs.BYTERANGE, null),
        sig: uri + '|' + (attrs.BYTERANGE || '')
      });
      currentMap = maps.length - 1;
      continue;
    }
    if (line.indexOf('#EXTINF:') === 0) {
      const body = line.slice(8);
      const comma = body.indexOf(',');
      pendingDuration = Math.max(0, Number(comma >= 0 ? body.slice(0, comma) : body) || 0);
      pendingTitle = comma >= 0 ? body.slice(comma + 1) : '';
      continue;
    }
    if (line.indexOf('#EXT-X-BYTERANGE:') === 0) {
      pendingByteRange = parseByteRange(line.slice(17), lastRange);
      continue;
    }
    if (line === '#EXT-X-DISCONTINUITY') { pendingDiscontinuity = true; continue; }
    if (line === '#EXT-X-GAP') { pendingGap = true; continue; }
    if (line === '#EXT-X-PLAYLIST-TYPE:VOD') continue;
    if (line.charAt(0) === '#') continue;

    const uri = absHttpUrl(line, baseUrl);
    if (!uri) {
      pendingDuration = 0; pendingByteRange = null; pendingDiscontinuity = false; pendingGap = false;
      continue;
    }
    segments.push({
      index: segments.length,
      uri: uri,
      duration: pendingDuration || (targetDuration || 6),
      title: pendingTitle,
      byteRange: pendingByteRange,
      keyIndex: currentKey,
      mapIndex: currentMap,
      discontinuity: pendingDiscontinuity,
      gap: pendingGap
    });
    lastRange = pendingByteRange;
    pendingDuration = 0;
    pendingTitle = '';
    pendingByteRange = null;
    pendingDiscontinuity = false;
    pendingGap = false;
  }

  const durationSec = segments.reduce(function (acc, s) { return acc + (Number(s.duration) || 0); }, 0);
  if (!targetDuration) targetDuration = Math.max(1, Math.ceil(Math.max.apply(null, segments.map(function (s) { return s.duration; }).concat([0]))));
  return {
    type: 'media',
    version: version,
    targetDuration: targetDuration,
    mediaSequence: mediaSequence,
    endList: endList,
    keys: keys,
    maps: maps,
    segments: segments,
    durationSec: durationSec
  };
}

/** Escolhe a variante (id informado ou a de maior resolução/banda). */
function chooseVariant(variants, variantId) {
  const list = Array.isArray(variants) ? variants : [];
  if (!list.length) throw parseError('A playlist master não tem variantes.');
  if (variantId) {
    const found = list.filter(function (v) { return v.id === variantId; })[0];
    if (!found) {
      throw new HlsError('variant', 'A qualidade escolhida não está mais disponível. Escolha outra.',
        { variantId: variantId });
    }
    return found;
  }
  return list.slice().sort(function (a, b) {
    const pa = (a.height || 0) * 1000000 + (a.averageBandwidth || a.bandwidth || 0);
    const pb = (b.height || 0) * 1000000 + (b.averageBandwidth || b.bandwidth || 0);
    return pb - pa;
  })[0];
}

/* -------------------------------------------------------------------------- */
/* Labels para o seletor de qualidade                                         */
/* -------------------------------------------------------------------------- */

function resolutionLabel(resolution) {
  const m = /^(\d+)x(\d+)$/.exec(String(resolution || ''));
  if (!m) return '';
  const h = Number(m[2]);
  if (h >= 2160) return '4K';
  if (h >= 1440) return '1440p';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  if (h >= 360) return '360p';
  return h ? h + 'p' : '';
}

function codecLabel(codecs) {
  const s = String(codecs || '').toLowerCase();
  if (!s) return '';
  if (/(avc1|avc3|h264)/.test(s)) return 'H.264';
  if (/(hvc1|hev1|h265|hevc)/.test(s)) return 'H.265';
  if (/vp09|vp9/.test(s)) return 'VP9';
  if (/av01|av1/.test(s)) return 'AV1';
  return '';
}

function bandwidthLabel(bps) {
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return '';
  return (n / 1000000).toFixed(1).replace('.', ',') + ' Mbps';
}

/** Texto do seletor: "1080p • H.264 • 5,2 Mbps". */
function variantLabel(variant) {
  if (!variant) return 'HLS';
  const parts = [
    resolutionLabel(variant.resolution),
    codecLabel(variant.codecs),
    bandwidthLabel(variant.averageBandwidth || variant.bandwidth)
  ].filter(Boolean);
  return parts.length ? parts.join(' • ') : 'HLS';
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

function sanitizeHeaders(raw) {
  const out = {};
  const allowed = { 'user-agent': 1, 'referer': 1, 'origin': 1, 'accept': 1, 'accept-language': 1 };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(raw)) {
    const name = String(key).toLowerCase();
    if (!allowed[name]) continue;
    let value = raw[key];
    if (value == null) continue;
    value = String(value).replace(/[\r\n\u0000]+/g, ' ').replace(/\s+/g, ' ').slice(0, 2048).trim();
    if (value) out[name] = value;
  }
  if (!out['user-agent']) out['user-agent'] = 'Space IPTV Desktop/1.0';
  return out;
}

function linkSignal(parent, timeoutMs) {
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
  }, Math.max(1000, timeoutMs || 30000));
  return {
    signal: ac.signal,
    timedOut: function () { return timedOut; },
    cleanup: function () {
      clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onAbort);
    }
  };
}

function makeFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (typeof fetch === 'function') return fetch;
  throw new HlsError('network', 'Este ambiente não tem fetch (Node 18+).');
}

async function readTextBody(res, maxBytes, opts) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let sniffed = !(opts && opts.sniff);
  const intersection = [];
  function sniff(buf) {
    if (sniffed) return;
    intersection.push(buf);
    const joined = Buffer.concat(intersection);
    let s = joined.toString('latin1').replace(/^\u00EF\u00BB\u00BF/, '').replace(/^\uFEFF+/, '');
    s = s.replace(/^\s+/, '');
    if (!s) return;                       /* ainda só espaços/BOM */
    sniffed = true;
    if (s.charAt(0) !== '#') throw new HlsError('not-playlist', 'O conteúdo não é uma playlist HLS.');
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const buf = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      size += buf.length;
      if (!sniffed) sniff(buf);
      if (size > maxBytes) throw parseError('Playlist HLS grande demais.');
      chunks.push(buf);
    }
  } finally {
    try { await reader.cancel(); } catch (e) { /* ignore */ }
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * Baixa um texto (playlist) com timeout próprio e limite de tamanho.
 * `sniffPlaylist: true` aborta cedo quando o conteúdo claramente não começa com
 * `#EXTM3U` (evita baixar um MP4 inteiro só para descobrir que não é playlist).
 * @returns {Promise<{text:string, finalUrl:string, contentType:string}>}
 */
async function fetchText(url, opts) {
  const o = opts || {};
  const fetchImpl = makeFetch(o.fetchImpl);
  const link = linkSignal(o.signal, o.timeoutMs || LIMITS.playlistTimeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: link.signal,
      headers: o.headers || {}
    });
  } catch (e) {
    link.cleanup();
    if (o.signal && o.signal.aborted) throw abortedError();
    if (link.timedOut()) throw timeoutError(o.label);
    throw networkError(e);
  }
  try {
    if (res.status !== 200) throw httpError(res.status, o.label);
    if (!res.body) throw parseError('Resposta vazia do servidor.');
    const text = await readTextBody(res, o.maxBytes || LIMITS.playlistBytes, { sniff: !!o.sniffPlaylist });
    return { text: text, finalUrl: res.url || url, contentType: res.headers.get('content-type') || '' };
  } catch (e) {
    if (e instanceof HlsError) throw e;
    if (o.signal && o.signal.aborted) throw abortedError();
    if (link.timedOut()) throw timeoutError(o.label);
    throw networkError(e);
  } finally {
    link.cleanup();
  }
}

function readContentLength(res) {
  const raw = res.headers.get('content-length');
  if (!raw || !/^\d+$/.test(raw)) return 0;
  return Number(raw);
}

/**
 * Baixa um recurso binário para arquivo (atomicamente: .part + rename).
 * Suporta Range (para #EXT-X-BYTERANGE) e retomada é feita pelo chamador
 * (arquivo final já existente = pulado).
 * @returns {Promise<{size:number}>}
 */
async function fetchToFile(url, filePath, opts) {
  const o = opts || {};
  const fetchImpl = makeFetch(o.fetchImpl);
  const headers = Object.assign({}, o.headers || {});
  if (o.byteRange) {
    headers.range = 'bytes=' + o.byteRange.offset + '-' + (o.byteRange.offset + o.byteRange.length - 1);
  }
  const link = linkSignal(o.signal, o.timeoutMs || LIMITS.segmentTimeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: link.signal,
      headers: headers
    });
  } catch (e) {
    link.cleanup();
    if (o.signal && o.signal.aborted) throw abortedError();
    if (link.timedOut()) throw timeoutError(o.label);
    throw networkError(e);
  }
  const tmp = filePath + '.part';
  let handle = null;
  try {
    if (res.status !== 200 && res.status !== 206) {
      try { if (res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
      throw httpError(res.status, o.label);
    }
    if (o.byteRange && res.status !== 206) {
      throw new HlsError('http', 'O servidor não suporta faixas (HTTP ' + res.status + ') para segmentos por byte-range.', { status: res.status });
    }
    if (!res.body) throw parseError('Resposta vazia do servidor.');
    const expected = readContentLength(res);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    try { await fsp.rm(tmp, { force: true }); } catch (e) { /* ignore */ }
    handle = await fsp.open(tmp, 'w');
    let total = 0;
    const reader = res.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const buf = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      total += buf.length;
      if (o.maxBytes && total > o.maxBytes) throw parseError('Arquivo grande demais.');
      await handle.write(buf);
      if (o.onBytes) {
        try { o.onBytes(buf.length); } catch (e) { /* callback não pode quebrar o download */ }
      }
    }
    if (o.byteRange && total !== o.byteRange.length) {
      throw new HlsError('network', 'Faixa de bytes incompleta recebida do servidor.');
    }
    if (!o.byteRange && expected && total !== expected) {
      throw new HlsError('network', 'O servidor enviou menos dados do que anunciou.');
    }
    if (!total) throw parseError('Arquivo vazio recebido do servidor.');
    try { await handle.sync(); } catch (e) { /* fsync opcional */ }
    await handle.close();
    handle = null;
    await fsp.rename(tmp, filePath);
    return { size: total };
  } catch (e) {
    if (handle) { try { await handle.close(); } catch (e2) { /* ignore */ } }
    try { await fsp.rm(tmp, { force: true }); } catch (e2) { /* ignore */ }
    if (e instanceof HlsError) throw e;
    if (o.signal && o.signal.aborted) throw abortedError();
    if (link.timedOut()) throw timeoutError(o.label);
    throw networkError(e);
  } finally {
    link.cleanup();
    try { if (res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
  }
}

/* -------------------------------------------------------------------------- */
/* Escolha de áudio                                                           */
/* -------------------------------------------------------------------------- */

function chooseAudioRendition(master, variant) {
  if (!variant || !variant.audioGroup) return null;
  const list = (master.media || []).filter(function (m) {
    return m.type === 'AUDIO' && m.groupId === variant.audioGroup && m.uri;
  });
  if (!list.length) return null;
  return list.filter(function (m) { return m.default; })[0] || list[0];
}

/* -------------------------------------------------------------------------- */
/* Playlists locais                                                           */
/* -------------------------------------------------------------------------- */

function fmtDuration(v) {
  const n = Number(v) || 0;
  return n.toFixed(3);
}

function quoteAttr(v) {
  return '"' + String(v == null ? '' : v).replace(/["\r\n]/g, '') + '"';
}

/**
 * Monta a playlist local de mídia com caminhos relativos.
 * `#EXT-X-MEDIA-SEQUENCE` é PRESERVADO: com AES-128 sem IV explícito o IV é o
 * número de sequência do segmento — mudar a sequência quebraria a decriptação.
 */
function buildLocalMediaPlaylist(media, opts) {
  const o = opts || {};
  const lines = ['#EXTM3U'];
  lines.push('#EXT-X-VERSION:' + Math.max(3, media.version || 3));
  lines.push('#EXT-X-TARGETDURATION:' + Math.max(1, Math.ceil(media.targetDuration || 1)));
  lines.push('#EXT-X-MEDIA-SEQUENCE:' + (media.mediaSequence || 0));
  lines.push('#EXT-X-PLAYLIST-TYPE:VOD');

  let lastKey = null;
  let lastMap = null;
  for (const seg of media.segments) {
    if (seg.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (seg.keyIndex !== lastKey) {
      const key = seg.keyIndex >= 0 ? media.keys[seg.keyIndex] : null;
      if (key) {
        let line = '#EXT-X-KEY:METHOD=AES-128,URI=' + quoteAttr(o.keyPath(key));
        if (key.iv) line += ',IV=' + key.iv;
        lines.push(line);
      } else if (lastKey != null && lastKey >= 0) {
        lines.push('#EXT-X-KEY:METHOD=NONE');
      }
      lastKey = seg.keyIndex;
    }
    if (seg.mapIndex !== lastMap) {
      const map = seg.mapIndex >= 0 ? media.maps[seg.mapIndex] : null;
      if (map) lines.push('#EXT-X-MAP:URI=' + quoteAttr(o.mapPath(map)));
      lastMap = seg.mapIndex;
    }
    if (seg.gap) lines.push('#EXT-X-GAP');
    lines.push('#EXTINF:' + fmtDuration(seg.duration) + ',');
    lines.push(o.segmentPath(seg));
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

function buildLocalMasterPlaylist(master, variant, videoPlaylistName, audio) {
  const lines = ['#EXTM3U'];
  lines.push('#EXT-X-VERSION:' + Math.max(3, master.version || 3));
  if (audio) {
    let mediaLine = '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=' + quoteAttr(audio.groupId) +
      ',NAME=' + quoteAttr(audio.name || 'Áudio') +
      ',DEFAULT=YES,AUTOSELECT=YES';
    if (audio.language) mediaLine += ',LANGUAGE=' + quoteAttr(audio.language);
    if (audio.assocLanguage) mediaLine += ',ASSOC-LANGUAGE=' + quoteAttr(audio.assocLanguage);
    if (audio.channels) mediaLine += ',CHANNELS=' + quoteAttr(audio.channels);
    mediaLine += ',URI=' + quoteAttr('audio.m3u8');
    lines.push(mediaLine);
  }
  const attrs = [];
  if (variant.bandwidth) attrs.push('BANDWIDTH=' + variant.bandwidth);
  if (variant.averageBandwidth) attrs.push('AVERAGE-BANDWIDTH=' + variant.averageBandwidth);
  if (variant.resolution) attrs.push('RESOLUTION=' + variant.resolution);
  if (variant.codecs) attrs.push('CODECS="' + variant.codecs.replace(/["\r\n]/g, '') + '"');
  if (audio) attrs.push('AUDIO=' + quoteAttr(variant.audioGroup || audio.groupId));
  lines.push('#EXT-X-STREAM-INF:' + attrs.join(','));
  lines.push(videoPlaylistName);
  return lines.join('\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/* Download                                                                   */
/* -------------------------------------------------------------------------- */

function segmentFileExtension(seg) {
  const parsed = (function () {
    try { return new URL(seg.uri); } catch (e) { return null; }
  })();
  let ext = parsed ? paths.extOf(parsed.pathname) : '';
  if (!ext || PLAYLIST_EXTS.indexOf(ext) < 0) {
    ext = seg.mapIndex >= 0 || seg.byteRange ? 'm4s' : 'ts';
  }
  if (ext === 'mp4' && (seg.mapIndex >= 0 || seg.byteRange)) ext = 'm4s';
  return ext;
}

function keyFileName(index) {
  return 'key-' + String(index + 1).padStart(2, '0') + '.key';
}

function initFileName(index, ext) {
  return 'init-' + String(index + 1).padStart(2, '0') + '.' + (ext || 'mp4');
}

/**
 * Baixa UMA playlist de mídia (vídeo ou áudio) para os diretórios locais.
 * @param {object} p
 * @param {object} p.media resultado de parseMedia
 * @param {string} p.finalUrl URL final da playlist remota
 * @param {string} p.unitPrefix 'segments' ou 'audio/segments'
 * @param {object} ctx {destDir, headers, signal, fetchImpl, onProgress, resume}
 */
async function downloadMediaPlaylist(p, ctx) {
  const media = p.media;
  if (!media.segments.length) throw parseError('A playlist HLS não tem segmentos.');
  const hasGap = media.segments.some(function (s) { return s.gap; });
  if (hasGap) throw new HlsError('unsupported', 'Playlist com segmentos ausentes (GAP) não é suportada para baixar.');
  const destDir = ctx.destDir;
  const unit = p.unitPrefix || 'segments';
  const files = [];

  /* 1. chaves AES-128 (uma por URI distinta) */
  const keyRelByUri = new Map();       /* uri -> caminho relativo */
  const keyRelByIndex = new Map();     /* index do parser -> caminho relativo */
  let keyCount = 0;
  for (let i = 0; i < media.keys.length; i++) {
    const key = media.keys[i];
    let rel = keyRelByUri.get(key.uri);
    if (!rel) {
      rel = 'keys/' + keyFileName(keyCount++);
      keyRelByUri.set(key.uri, rel);
      const abs = paths.resolveInside(destDir, rel);
      const result = await fetchToFile(key.uri, abs, {
        headers: ctx.headers,
        signal: ctx.signal,
        fetchImpl: ctx.fetchImpl,
        timeoutMs: LIMITS.keyTimeoutMs,
        maxBytes: LIMITS.keyBytes,
        label: 'chave'
      });
      files.push({ path: rel, size: result.size });
    }
    keyRelByIndex.set(i, rel);
  }

  /* 2. init maps (fMP4) */
  const mapRelByIndex = new Map();
  let mapCount = 0;
  for (let i = 0; i < media.maps.length; i++) {
    const map = media.maps[i];
    const ext = segmentFileExtension({ uri: map.uri, mapIndex: -1, byteRange: map.byteRange }) || 'mp4';
    const rel = unit + '/' + initFileName(mapCount++, ext === 'm4s' ? 'mp4' : ext);
    const abs = paths.resolveInside(destDir, rel);
    const result = await fetchToFile(map.uri, abs, {
      headers: ctx.headers,
      signal: ctx.signal,
      fetchImpl: ctx.fetchImpl,
      timeoutMs: LIMITS.keyTimeoutMs,
      label: 'init map'
    });
    mapRelByIndex.set(i, rel);
    files.push({ path: rel, size: result.size });
  }

  /* 3. segmentos (pool pequeno; retomada pula arquivo final já existente) */
  const segments = media.segments;
  const segRel = new Array(segments.length);
  let bytesDone = 0;
  let doneCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const ext = segmentFileExtension(segments[i]);
    segRel[i] = unit + '/seg-' + String(i + 1).padStart(5, '0') + '.' + ext;
  }

  function progress() {
    if (ctx.onProgress) {
      try {
        ctx.onProgress({
          bytes: bytesDone,
          segmentsDone: doneCount,
          segmentsTotal: segments.length,
          file: 'segment'
        });
      } catch (e) { /* ignore */ }
    }
  }

  /* pool com abort local ao primeiro erro (evita dezenas de requests órfãos) */
  const localAbort = new AbortController();
  const parentSignal = ctx.signal;
  const onParentAbort = function () { try { localAbort.abort(parentSignal.reason); } catch (e) { /* ignore */ } };
  if (parentSignal) {
    if (parentSignal.aborted) localAbort.abort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const innerCtx = Object.assign({}, ctx, { signal: localAbort.signal });

  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= segments.length) return;
      try {
        await oneSegmentWithCtx(index);
      } catch (e) {
        try { localAbort.abort(e); } catch (e2) { /* ignore */ }
        throw e;
      }
    }
  }

  async function oneSegmentWithCtx(index) {
    /* usa o signal combinado (pai + localAbort) */
    const seg = segments[index];
    const abs = paths.resolveInside(destDir, segRel[index]);
    let existing = 0;
    try {
      const st = await fsp.stat(abs);
      if (st.isFile() && st.size > 0) existing = st.size;
    } catch (e) { existing = 0; }
    if (existing) {
      bytesDone += existing;
      doneCount++;
      files.push({ path: segRel[index], size: existing });
      progress();
      return;
    }
    let lastErr = null;
    for (let attempt = 1; attempt <= LIMITS.attempts; attempt++) {
      if (innerCtx.signal.aborted) throw abortedError();
      let fileBytes = 0;
      try {
        const result = await fetchToFile(seg.uri, abs, {
          headers: innerCtx.headers,
          signal: innerCtx.signal,
          fetchImpl: innerCtx.fetchImpl,
          timeoutMs: LIMITS.segmentTimeoutMs,
          byteRange: seg.byteRange,
          maxBytes: 1024 * 1024 * 1024,
          label: 'segmento',
          onBytes: function (n) { fileBytes += n; bytesDone += n; progress(); }
        });
        doneCount++;
        progress();
        files.push({ path: segRel[index], size: result.size });
        return;
      } catch (err) {
        /* desconta bytes parciais desta tentativa que não viraram arquivo final */
        bytesDone -= fileBytes;
        lastErr = err;
        if (err && err.code === 'aborted') throw err;
        const retryable = !err || err.code !== 'http' || err.status >= 500 || err.status === 408 || err.status === 429;
        if (!retryable || attempt >= LIMITS.attempts) throw err;
        await new Promise(function (resolve) { setTimeout(resolve, LIMITS.retryDelayMs * attempt); });
      }
    }
    throw lastErr || networkError(null);
  }

  const runners = [];
  const workers = Math.max(1, Math.min(LIMITS.segmentConcurrency, segments.length));
  for (let i = 0; i < workers; i++) {
    runners.push(worker().catch(function (e) {
      try { localAbort.abort(e); } catch (e2) { /* ignore */ }
      throw e;
    }));
  }
  try {
    await Promise.all(runners);
  } finally {
    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
  }
  if (parentSignal && parentSignal.aborted) throw abortedError();

  /* 4. playlist local */
  const playlistText = buildLocalMediaPlaylist(media, {
    keyPath: function (key) { return keyRelByIndex.get(media.keys.indexOf(key)) || keyFileName(0); },
    mapPath: function (map) { return mapRelByIndex.get(media.maps.indexOf(map)) || ''; },
    segmentPath: function (seg) { return segRel[seg.index]; }
  });
  const playlistRel = p.playlistName || 'playlist.m3u8';
  const playlistAbs = paths.resolveInside(destDir, playlistRel);
  await fsp.mkdir(path.dirname(playlistAbs), { recursive: true });
  await fsp.writeFile(playlistAbs, Buffer.from(playlistText, 'utf8'));
  const plStat = await fsp.stat(playlistAbs);
  files.push({ path: playlistRel, size: plStat.size });

  return { files: files, bytes: bytesDone, segments: segments.length, playlist: playlistRel, media: media };
}

/**
 * Baixa o conteúdo HLS completo para `destDir`.
 *
 * @param {{
 *   url: string,
 *   destDir: string,
 *   variantId?: string,
 *   headers?: object,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 *   onProgress?: function,
 *   estimatedBytes?: number,
 *   durationSec?: number,
 *   log?: function
 * }} opts
 * @returns {Promise<{
 *   engine:'hls', totalBytes:number, durationSec:number,
 *   files:{path:string,size:number}[], playlist:{master:string,variant:string},
 *   variant: object|null, label: string
 * }>}
 */
async function download(opts) {
  const o = opts || {};
  if (!o.url) throw new HlsError('config', 'URL do conteúdo ausente.');
  if (!o.destDir) throw new HlsError('config', 'Pasta de destino ausente.');
  const destDir = path.resolve(o.destDir);
  await fsp.mkdir(destDir, { recursive: true });
  const headers = sanitizeHeaders(o.headers);
  const log = typeof o.log === 'function' ? o.log : function () {};
  const progressBase = { bytes: 0, segmentsDone: 0, segmentsTotal: 0 };

  function emit(extra) {
    if (!o.onProgress) return;
    try { o.onProgress(Object.assign({}, progressBase, extra)); } catch (e) { /* ignore */ }
  }

  /* 1. playlist inicial */
  const first = await fetchText(o.url, {
    headers: headers,
    signal: o.signal,
    fetchImpl: o.fetchImpl,
    label: 'playlist',
    sniffPlaylist: true
  });
  if (!looksLikePlaylist(first.text)) throw new HlsError('not-playlist', 'O conteúdo não é uma playlist HLS.');
  assertNoDrm(first.text);

  const plans = [];           /* playlists de mídia a baixar */
  let master = null;
  let variant = null;
  let audio = null;

  if (isMasterText(first.text)) {
    master = parseMaster(first.text, first.finalUrl);
    variant = chooseVariant(master.variants, o.variantId);
    if (variant.height) progressBase.height = variant.height;
    audio = chooseAudioRendition(master, variant);

    /* variante (vídeo) */
    const videoPlaylist = await fetchText(variant.url, {
      headers: headers, signal: o.signal, fetchImpl: o.fetchImpl, label: 'variante'
    });
    assertNoDrm(videoPlaylist.text);
    if (isMasterText(videoPlaylist.text)) throw parseError('Playlist master aninhada não é suportada.');
    const videoMedia = parseMedia(videoPlaylist.text, videoPlaylist.finalUrl);
    plans.push({
      role: 'video',
      media: videoMedia,
      finalUrl: videoPlaylist.finalUrl,
      unitPrefix: 'segments',
      playlistName: audio ? 'variant.m3u8' : 'playlist.m3u8'
    });

    if (audio) {
      const audioPlaylist = await fetchText(audio.uri, {
        headers: headers, signal: o.signal, fetchImpl: o.fetchImpl, label: 'áudio'
      });
      assertNoDrm(audioPlaylist.text);
      if (isMasterText(audioPlaylist.text)) throw parseError('Faixa de áudio inválida.');
      const audioMedia = parseMedia(audioPlaylist.text, audioPlaylist.finalUrl);
      plans.push({
        role: 'audio',
        media: audioMedia,
        finalUrl: audioPlaylist.finalUrl,
        unitPrefix: 'audio/segments',
        playlistName: 'audio.m3u8'
      });
    }
  } else if (isMediaText(first.text)) {
    const media = parseMedia(first.text, first.finalUrl);
    plans.push({
      role: 'video',
      media: media,
      finalUrl: first.finalUrl,
      unitPrefix: 'segments',
      playlistName: 'playlist.m3u8'
    });
  } else {
    throw new HlsError('not-playlist', 'O conteúdo não é uma playlist HLS.');
  }

  const videoPlan = plans.filter(function (p) { return p.role === 'video'; })[0];
  const durationSec = o.durationSec > 0 ? o.durationSec : videoPlan.media.durationSec;
  const bandwidth = variant ? (variant.averageBandwidth || variant.bandwidth) : 0;
  let totalBytes = Math.max(0, Math.floor(Number(o.estimatedBytes) || 0));
  if (!totalBytes && bandwidth && videoPlan.media.durationSec) {
    totalBytes = Math.floor(videoPlan.media.durationSec * bandwidth / 8);
  }
  progressBase.totalBytes = totalBytes;
  progressBase.segmentsTotal = plans.reduce(function (acc, p) { return acc + p.media.segments.length; }, 0);
  emit({});

  /* 2. baixa cada playlist (vídeo + áudio) */
  const files = [];
  let bytes = 0;
  let segmentsDone = 0;
  for (const plan of plans) {
    const before = { bytes: bytes, segmentsDone: segmentsDone };
    const res = await downloadMediaPlaylist(plan, {
      destDir: destDir,
      headers: headers,
      signal: o.signal,
      fetchImpl: o.fetchImpl,
      onProgress: function (p) {
        bytes = before.bytes + p.bytes;
        segmentsDone = before.segmentsDone + p.segmentsDone;
        emit({ bytes: bytes, segmentsDone: segmentsDone });
      }
    });
    bytes = before.bytes + res.bytes;
    segmentsDone = before.segmentsDone + res.segments;
    for (const f of res.files) files.push(f);
    emit({ bytes: bytes, segmentsDone: segmentsDone });
  }

  /* 3. playlist local final */
  let playlist = { master: '', variant: 'playlist.m3u8' };
  if (plans.length > 1) {
    const text = buildLocalMasterPlaylist(master, variant, 'variant.m3u8', audio);
    const abs = paths.resolveInside(destDir, 'playlist.m3u8');
    await fsp.writeFile(abs, Buffer.from(text, 'utf8'));
    const st = await fsp.stat(abs);
    files.push({ path: 'playlist.m3u8', size: st.size });
    playlist = { master: 'playlist.m3u8', variant: 'variant.m3u8' };
  }

  /* dedupe e ordena a lista de arquivos do manifesto */
  const seen = new Set();
  const finalFiles = [];
  for (const f of files) {
    const rel = paths.normalizeRelPath(f.path);
    if (seen.has(rel)) continue;
    seen.add(rel);
    finalFiles.push({ path: rel, size: Math.max(0, Math.floor(f.size || 0)) });
  }
  finalFiles.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
  const totalActual = finalFiles.reduce(function (acc, f) { return acc + f.size; }, 0);
  log('[hls] pacote pronto: ' + finalFiles.length + ' arquivos, ' + paths.formatBytes(totalActual));

  return {
    engine: 'hls',
    totalBytes: totalActual,
    durationSec: durationSec || 0,
    files: finalFiles,
    playlist: playlist,
    variant: variant ? {
      id: variant.id,
      resolution: variant.resolution,
      codecs: variant.codecs,
      bandwidth: variant.averageBandwidth || variant.bandwidth,
      label: variantLabel(variant)
    } : null,
    label: variant ? variantLabel(variant) : 'HLS'
  };
}

/* -------------------------------------------------------------------------- */
/* Sondagem (probe)                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Sonda uma URL de playlist e devolve variantes para o seletor de qualidade.
 * Lança `{code:'not-playlist'}` quando o conteúdo não é HLS (o chamador tenta
 * tratar como MP4).
 * @returns {Promise<{type:'master'|'media', variants:object[], durationSec:number}>}
 */
async function probe(url, opts) {
  const o = opts || {};
  const first = await fetchText(url, {
    headers: sanitizeHeaders(o.headers),
    signal: o.signal,
    fetchImpl: o.fetchImpl,
    label: 'playlist',
    sniffPlaylist: true
  });
  if (!looksLikePlaylist(first.text)) throw new HlsError('not-playlist', 'O conteúdo não é uma playlist HLS.');
  assertNoDrm(first.text);

  if (isMasterText(first.text)) {
    const master = parseMaster(first.text, first.finalUrl);
    if (!master.variants.length) throw parseError('A playlist master não tem variantes.');
    /* DRM costuma aparecer na playlist da variante (SAMPLE-AES). Sondar a
       variante principal evita oferecer uma qualidade que nunca poderia baixar. */
    try {
      const primary = chooseVariant(master.variants);
      const primaryPlaylist = await fetchText(primary.url, {
        headers: sanitizeHeaders(o.headers),
        signal: o.signal,
        fetchImpl: o.fetchImpl,
        label: 'variante'
      });
      assertNoDrm(primaryPlaylist.text);
    } catch (err) {
      if (err && err.code === 'drm') throw err;
      /* falha de rede/404 em uma variante específica não invalida a sondagem */
    }
    const variants = master.variants.map(function (v) {
      return {
        id: v.id,
        url: v.url,
        kind: 'hls',
        label: variantLabel(v),
        resolution: resolutionLabel(v.resolution),
        codecs: codecLabel(v.codecs),
        bandwidth: v.averageBandwidth || v.bandwidth,
        estimatedBytes: 0,
        rawResolution: v.resolution
      };
    });
    variants.sort(function (a, b) {
      return (b.bandwidth || 0) - (a.bandwidth || 0);
    });
    return { type: 'master', variants: variants, durationSec: 0, media: master.media };
  }

  if (!isMediaText(first.text)) throw new HlsError('not-playlist', 'O conteúdo não é uma playlist HLS.');
  const media = parseMedia(first.text, first.finalUrl);
  return {
    type: 'media',
    variants: [{
      id: 'media',
      url: first.finalUrl,
      kind: 'hls',
      label: 'HLS',
      resolution: '',
      codecs: '',
      bandwidth: 0,
      estimatedBytes: 0
    }],
    durationSec: media.durationSec
  };
}

/* -------------------------------------------------------------------------- */
/* Utilidades exportadas para testes                                          */
/* -------------------------------------------------------------------------- */

module.exports = {
  DRM_MESSAGE,
  LIMITS,
  HlsError,
  detectDrm,
  assertNoDrm,
  parseAttributes,
  isMasterText,
  isMediaText,
  looksLikePlaylist,
  parseMaster,
  parseMedia,
  chooseVariant,
  chooseAudioRendition,
  buildLocalMediaPlaylist,
  buildLocalMasterPlaylist,
  variantLabel,
  resolutionLabel,
  codecLabel,
  bandwidthLabel,
  sanitizeHeaders,
  fetchText,
  fetchToFile,
  probe,
  download
};
