/* Configuração local do Space IPTV Desktop.
 *
 * JSON atômico em `%APPDATA%\Space IPTV\config.json` (ou `SPACE_CONFIG_FILE`).
 * Nada de segredo aqui: senha/token/cookie nunca entram neste arquivo.
 *
 * Precedência (contrato §2.1 e §2.4):
 *   SPACE_API_ORIGIN      > config.apiOrigin
 *   SPACE_DOWNLOADS_DIR   > config.downloadsDir > HKCU\Software\Space IPTV\DownloadsDir
 *                         > %USERPROFILE%\Videos\Space IPTV
 *   SPACE_INTERNAL_PORT   > config.internalPort (0 = sorteia 41000–49000 e persiste)
 *   SPACE_CONFIG_FILE     = caminho alternativo do JSON (testes)
 *
 * Este módulo NÃO depende de `electron`: o servidor interno e os testes em Node puro
 * rodam apenas com ele. O main passa `appDataDir`/versão quando necessário.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const APP_FOLDER = 'Space IPTV';
const DEFAULT_API_ORIGIN = 'https://space-iptv.pages.dev';
/* Fonte pública de EPG (XMLTV gzip) usada quando a lista ativa não informa um
 * guia (`url-tvg`) nem fornece `xmltv.php` (Xtream). EPGShare01 — agregador
 * público da comunidade IPTV; ver `docs/EPG.md`. '' = usuário desligou. */
const DEFAULT_EPG_URL = 'https://epgshare01.online/epgshare01/epg_ripper_BR1.xml.gz';
const PORT_MIN = 41000;
const PORT_MAX = 49000;
const MIN_FREE_BYTES = 100 * 1024 * 1024; /* 100 MB: abaixo disso não vale baixar */
const EPG_TTL_ALLOWED = [12, 24, 48];

const DEFAULTS = {
  version: 1,
  apiOrigin: DEFAULT_API_ORIGIN,
  internalPort: 0,
  downloadsDir: '',
  epgTtlHours: 24,
  epgUrl: DEFAULT_EPG_URL,
  startWithWindows: false,
  startMinimizedToTray: false,
  minimizeToTrayOnClose: false,
  window: { x: null, y: null, width: 1366, height: 768, maximized: false }
};

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function normalizeOrigin(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!u.hostname) return '';
    return u.origin;
  } catch (e) {
    return '';
  }
}

/* URL de EPG aceita: '' (desligado) ou http(s) com host. Mantém o texto como o
 * usuário colou (query string pode ser necessária); só trim e limite de tamanho. */
function normalizeEpgUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw.length > 2048) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!u.hostname) return '';
    return raw;
  } catch (e) {
    return '';
  }
}

function normalizePort(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return 0;
  return Math.floor(n);
}

function normalizeWindow(w) {
  const base = clone(DEFAULTS.window);
  if (!isObject(w)) return base;
  const out = {
    x: Number.isFinite(Number(w.x)) ? Math.round(Number(w.x)) : null,
    y: Number.isFinite(Number(w.y)) ? Math.round(Number(w.y)) : null,
    width: Number.isFinite(Number(w.width)) ? Math.round(Number(w.width)) : base.width,
    height: Number.isFinite(Number(w.height)) ? Math.round(Number(w.height)) : base.height,
    maximized: w.maximized === true
  };
  if (out.width < 800 || out.width > 8000) out.width = base.width;
  if (out.height < 600 || out.height > 8000) out.height = base.height;
  if (out.x != null && Math.abs(out.x) > 20000) out.x = null;
  if (out.y != null && Math.abs(out.y) > 20000) out.y = null;
  return out;
}

/* Mistura o JSON lido com os padrões, descartando tipos inválidos. */
function sanitize(raw) {
  const data = clone(DEFAULTS);
  if (!isObject(raw)) return data;
  if (raw.version !== undefined && Number(raw.version) === 1) data.version = 1;
  const api = normalizeOrigin(raw.apiOrigin);
  if (api) data.apiOrigin = api;
  data.internalPort = normalizePort(raw.internalPort);
  data.downloadsDir = typeof raw.downloadsDir === 'string' ? raw.downloadsDir.trim().slice(0, 1024) : '';
  /* caminho com U+FFFD veio de decodificação errada de versões antigas:
     descarta e resolve de novo (registro/padrão) em vez de usar pasta inválida */
  if (hasReplacementChar(data.downloadsDir)) data.downloadsDir = '';
  const ttl = Number(raw.epgTtlHours);
  if (EPG_TTL_ALLOWED.indexOf(ttl) >= 0) data.epgTtlHours = ttl;
  /* Fonte de EPG padrão: '' desliga; URL válida substitui; valor inválido no
     arquivo mantém a fonte pública padrão (nunca desliga por lixo). */
  if (raw.epgUrl !== undefined && raw.epgUrl !== null) {
    if (typeof raw.epgUrl === 'string' && !raw.epgUrl.trim()) {
      data.epgUrl = '';
    } else {
      const epg = normalizeEpgUrl(raw.epgUrl);
      if (epg) data.epgUrl = epg;
    }
  }
  data.startWithWindows = raw.startWithWindows === true;
  data.startMinimizedToTray = raw.startMinimizedToTray === true;
  data.minimizeToTrayOnClose = raw.minimizeToTrayOnClose === true;
  data.window = normalizeWindow(raw.window);
  return data;
}

/* ---------- utilidades de arquivo ---------- */

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* espera curta no boot (sem async) */ }
}

/* Escrita atômica: `<file>.tmp` + rename. Windows pode falhar com EPERM/EBUSY
   quando antivírus/indexador segura o arquivo: tenta algumas vezes. */
function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  const text = JSON.stringify(data, null, 2) + '\n';
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      sleepSync(30 + attempt * 40);
    }
  }
  throw lastErr;
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return null; /* JSON corrompido: segue com os padrões e reescreve no próximo save */
  }
}

/* Espaço livre por `statfs` (Node >= 18.15). Ausente: devolve null (não inventa). */
function freeBytesOf(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(dir);
    const bavail = Number(st.bavail != null ? st.bavail : st.bfree);
    const bsize = Number(st.bsize);
    if (!Number.isFinite(bavail) || !Number.isFinite(bsize) || bavail <= 0 || bsize <= 0) return null;
    return Math.round(bavail * bsize);
  } catch (e) {
    return null;
  }
}

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return (i === 0 ? x : x.toFixed(x >= 10 ? 0 : 1)) + ' ' + units[i];
}

function defaultAppDataDir() {
  if (process.env.APPDATA) return process.env.APPDATA;
  const home = os.homedir();
  return path.join(home, 'AppData', 'Roaming');
}

/* ---------- pasta antiga com nome corrompido (mojibake) ----------
 * Versões anteriores liam `reg query` como UTF-8; em Windows pt-BR o "í" virava
 * U+FFFD e o app criava uma pasta "V\uFFFDdeos". Aqui reparamos: se existe a
 * variante corrompida do caminho e o caminho correto está ausente/vazio, os
 * arquivos são movidos para o caminho correto (uma vez, no boot).
 * Só mexe em caminho com a variante exata trocando não-ASCII por U+FFFD. */
function hasReplacementChar(value) {
  return String(value == null ? '' : value).indexOf('\uFFFD') >= 0;
}

function mangledPathOf(target) {
  const clean = String(target == null ? '' : target).trim();
  if (!clean) return '';
  const parts = clean.split(/([\\/]+)/);
  let out = '';
  for (const part of parts) {
    if (/^[\\/]+$/.test(part)) out += part;
    else out += part.replace(/[^\x00-\x7F]/g, '\uFFFD');
  }
  return out === clean ? '' : out;
}

function moveContentsInto(from, to) {
  let entries = [];
  try { entries = fs.readdirSync(from, { withFileTypes: true }); } catch (e) { return false; }
  try { fs.mkdirSync(to, { recursive: true }); } catch (e) { return false; }
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      let dstExists = false;
      try { dstExists = fs.statSync(dst).isDirectory(); } catch (e) { dstExists = false; }
      if (!dstExists) {
        try { fs.renameSync(src, dst); continue; } catch (e) { /* outro volume */ }
      }
      moveContentsInto(src, dst);
      try { fs.rmdirSync(src); } catch (e) { /* não estava vazio */ }
    } else if (!fs.existsSync(dst)) {
      try { fs.renameSync(src, dst); } catch (e) { /* arquivo em uso: mantém */ }
    }
  }
  try { fs.rmdirSync(from); } catch (e) { /* ainda tem conteúdo */ }
  return true;
}

function repairMangledDownloadsDir(target) {
  const clean = String(target == null ? '' : target).trim();
  if (!clean || hasReplacementChar(clean)) return null;
  const bad = mangledPathOf(clean);
  if (!bad || bad === clean) return null;
  try {
    if (!fs.existsSync(bad)) return null;
    try { fs.mkdirSync(path.dirname(clean), { recursive: true }); } catch (e) { /* ignore */ }
    let mode = '';
    if (!fs.existsSync(clean)) {
      try { fs.renameSync(bad, clean); mode = 'rename'; } catch (e) { mode = ''; }
    } else {
      let empty = false;
      try { empty = fs.readdirSync(clean).length === 0; } catch (e) { empty = false; }
      if (empty) {
        try { fs.rmdirSync(clean); fs.renameSync(bad, clean); mode = 'rename'; } catch (e) { mode = ''; }
      }
      if (!mode) { moveContentsInto(bad, clean); mode = 'merge'; }
    }
    if (!mode) return null;
    /* remove a pasta-pai corrompida se ficou vazia (ex.: D:\V\uFFFDdeos) */
    try { fs.rmdirSync(path.dirname(bad)); } catch (e) { /* ainda tem conteúdo */ }
    return { moved: true, from: bad, to: clean, mode: mode };
  } catch (e) {
    return null;
  }
}

/* Lê um valor REG_SZ do registro preservando Unicode.
 * `reg query` em pt-BR devolve bytes na página OEM/ANSI, o que corrompia "í";
 * `reg export` grava UTF-16LE, então lemos o arquivo e decodificamos certo. */
function readRegistryValueUtf16(name) {
  const tmp = path.join(os.tmpdir(), 'space-iptv-reg-' + process.pid + '-' + Date.now() + '.reg');
  try {
    execFileSync('reg', ['export', 'HKCU\\Software\\Space IPTV', tmp, '/y'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
  } catch (e) {
    /* key pode não existir (primeiro uso antes do instalador) ou export falhou */
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    return '';
  }
  try {
    const buf = fs.readFileSync(tmp);
    let text;
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) text = buf.toString('utf16le').replace(/^\uFEFF/, '');
    else if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) text = buf.slice(3).toString('utf8');
    else text = buf.toString('utf8');
    const key = '"' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"';
    const re = new RegExp(key + '\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"');
    const m = re.exec(text);
    if (!m) return '';
    return m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"').slice(0, 1024);
  } catch (e) {
    return '';
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

/* `HKCU\Software\Space IPTV` valor `DownloadsDir` — gravado pelo instalador NSIS.
   Só no Windows; falha silenciosa em qualquer outro caso. */
function readRegistryDownloadsDir() {
  if (process.platform !== 'win32') return '';
  let value = readRegistryValueUtf16('DownloadsDir');
  if (value) return value;
  /* Fallback: PowerShell com saída UTF-8 (para ambientes onde `reg export` falha). */
  try {
    const script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
      "try { [Console]::Out.Write((Get-ItemProperty -Path 'HKCU:\\Software\\Space IPTV' -Name DownloadsDir -ErrorAction Stop).DownloadsDir) } catch { }";
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 4000
    });
    value = String(out || '').trim();
    if (value && !hasReplacementChar(value)) return value.slice(0, 1024);
  } catch (e) { /* ignore */ }
  return '';
}

function defaultDownloadsDir() {
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, 'Videos', 'Space IPTV');
}

/* Testa se a pasta existe/é criável e gravável. Não apaga nada do usuário. */
function checkWritableDir(dir) {
  const target = String(dir == null ? '' : dir).trim();
  if (!target) return { ok: false, error: 'Informe uma pasta para os downloads.' };
  if (target.length > 1024) return { ok: false, error: 'O caminho da pasta é longo demais.' };
  if (/[\u0000-\u001f]/.test(target)) return { ok: false, error: 'O caminho da pasta tem caracteres inválidos.' };
  if (hasReplacementChar(target)) return { ok: false, error: 'O caminho da pasta tem caracteres corrompidos. Escolha a pasta de novo.' };
  let stat = null;
  try { stat = fs.statSync(target); } catch (e) { stat = null; }
  if (stat && !stat.isDirectory()) return { ok: false, error: 'O caminho escolhido não é uma pasta.' };
  try {
    fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, '.space-write-test-' + process.pid + '-' + Date.now());
    fs.writeFileSync(probe, 'ok', { encoding: 'utf8' });
    fs.unlinkSync(probe);
  } catch (e) {
    const code = e && e.code;
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'Sem permissão para gravar nesta pasta. Escolha outra.' };
    if (code === 'ENOENT') return { ok: false, error: 'A pasta (ou uma pasta acima) não existe e não pôde ser criada.' };
    if (code === 'ENOSPC') return { ok: false, error: 'Não há espaço livre neste disco.' };
    if (code === 'EROFS') return { ok: false, error: 'Este disco é somente leitura.' };
    return { ok: false, error: 'Não foi possível usar esta pasta. Escolha outra.' };
  }
  const free = freeBytesOf(target);
  if (free != null && free < MIN_FREE_BYTES) {
    return { ok: false, error: 'Pouco espaço livre nesta pasta (' + formatBytes(free) + '). Escolha um disco com mais espaço.' };
  }
  return { ok: true, freeBytes: free };
}

/* ---------- store ---------- */

/**
 * @param {object} [opts]
 * @param {object} [opts.env]        variáveis de ambiente (default: process.env)
 * @param {string} [opts.appDataDir] base do %APPDATA% (default: APPDATA/home)
 * @param {string} [opts.version]    versão do app (só informativa no get())
 */
function createConfig(opts) {
  opts = opts || {};
  const env = opts.env || process.env;

  const configFile = env.SPACE_CONFIG_FILE
    ? path.resolve(String(env.SPACE_CONFIG_FILE))
    : path.join(opts.appDataDir || defaultAppDataDir(), APP_FOLDER, 'config.json');
  const cacheFile = path.join(
    path.dirname(configFile),
    path.basename(configFile).replace(/\.json$/i, '') + '.cache.json'
  );

  let data = clone(DEFAULTS);
  let loaded = false;
  let downloadsCache = null;

  function load() {
    data = sanitize(readJson(configFile));
    loaded = true;
    downloadsCache = null;
    return data;
  }

  function ensureLoaded() {
    if (!loaded) load();
    return data;
  }

  function save() {
    writeJsonAtomic(configFile, data);
    return get();
  }

  function effectiveApiOrigin() {
    ensureLoaded();
    const fromEnv = normalizeOrigin(env.SPACE_API_ORIGIN);
    if (fromEnv) return fromEnv;
    const stored = normalizeOrigin(data.apiOrigin);
    return stored || DEFAULT_API_ORIGIN;
  }

  function pickPort() {
    for (let i = 0; i < 50; i++) {
      const port = PORT_MIN + crypto.randomInt(0, PORT_MAX - PORT_MIN + 1);
      if (port !== data.internalPort) return port;
    }
    return PORT_MIN + crypto.randomInt(0, PORT_MAX - PORT_MIN + 1);
  }

  /* Porta efetiva. Se o config tem 0 e nenhum override, sorteia e PERSISTE
     (origem estável para IndexedDB/localStorage). `SPACE_INTERNAL_PORT=0`
     significa "automático/persistido", igual ao config. */
  function effectiveInternalPort() {
    ensureLoaded();
    if (env.SPACE_INTERNAL_PORT !== undefined && env.SPACE_INTERNAL_PORT !== '') {
      const forced = normalizePort(env.SPACE_INTERNAL_PORT);
      if (forced > 0) return forced;
    }
    if (data.internalPort > 0) return data.internalPort;
    const chosen = pickPort();
    data.internalPort = chosen;
    try { save(); } catch (e) { /* sem config gravável: usa a porta só nesta execução */ }
    return chosen;
  }

  /* Pasta de downloads efetiva: env > config > registry > padrão. Cria e valida. */
  function resolveDownloadsDir() {
    ensureLoaded();
    const candidates = [
      { from: 'env', value: String(env.SPACE_DOWNLOADS_DIR || '').trim() },
      { from: 'config', value: String(data.downloadsDir || '').trim() },
      { from: 'registry', value: readRegistryDownloadsDir() },
      { from: 'default', value: defaultDownloadsDir() }
    ];
    let lastError = '';
    for (let i = 0; i < candidates.length; i++) {
      let value = candidates[i].value;
      if (!value) continue;
      /* repara pasta criada com nome corrompido por versões antigas
         (ex.: D:\V\uFFFDdeos) ANTES de validar/criar a pasta nova */
      let migrated = null;
      try { migrated = repairMangledDownloadsDir(value); } catch (e) { migrated = null; }
      if (migrated && migrated.to) value = migrated.to;
      const check = checkWritableDir(value);
      if (check.ok) {
        downloadsCache = {
          path: value, from: candidates[i].from,
          freeBytes: check.freeBytes != null ? check.freeBytes : null,
          migrated: migrated || null
        };
        return downloadsCache;
      }
      lastError = check.error;
      if (candidates[i].from === 'default') break;
    }
    downloadsCache = { path: candidates[candidates.length - 1].value, from: 'default', freeBytes: null, error: lastError, migrated: null };
    return downloadsCache;
  }

  function downloadsDir() {
    const info = downloadsCache || resolveDownloadsDir();
    return info.path;
  }

  function get() {
    ensureLoaded();
    /* Sempre resolve a pasta efetiva (cria/valida) para quem consome o config
       (ex.: EPG usa epgTtlHours com fallback 24 h; downloads usa downloadsDir). */
    const dirInfo = downloadsCache || resolveDownloadsDir();
    return {
      version: data.version,
      apiOrigin: effectiveApiOrigin(),
      internalPort: data.internalPort,
      downloadsDir: dirInfo.path,
      downloadsFreeBytes: dirInfo && dirInfo.freeBytes != null ? dirInfo.freeBytes : null,
      epgTtlHours: data.epgTtlHours,
      epgUrl: data.epgUrl,
      startWithWindows: data.startWithWindows,
      startMinimizedToTray: data.startMinimizedToTray,
      minimizeToTrayOnClose: data.minimizeToTrayOnClose,
      window: clone(data.window)
    };
  }

  /* Patch validado. Chaves fora da lista são ignoradas (nunca vira canal livre). */
  function set(patch) {
    ensureLoaded();
    if (!isObject(patch)) return get();
    const next = clone(data);
    if (Object.prototype.hasOwnProperty.call(patch, 'downloadsDir')) {
      const dir = String(patch.downloadsDir == null ? '' : patch.downloadsDir).trim();
      if (!dir) throw configError('invalid_dir', 'Informe uma pasta para os downloads.');
      const check = checkWritableDir(dir);
      if (!check.ok) throw configError('invalid_dir', check.error);
      next.downloadsDir = dir;
      downloadsCache = { path: dir, from: 'config', freeBytes: check.freeBytes != null ? check.freeBytes : null };
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'epgTtlHours')) {
      const ttl = Number(patch.epgTtlHours);
      if (EPG_TTL_ALLOWED.indexOf(ttl) < 0) throw configError('invalid_value', 'O cache do guia deve ser 12, 24 ou 48 horas.');
      next.epgTtlHours = ttl;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'epgUrl')) {
      const rawUrl = String(patch.epgUrl == null ? '' : patch.epgUrl).trim();
      if (!rawUrl) {
        next.epgUrl = '';   /* desligado: o app não busca fonte pública de EPG */
      } else {
        const epg = normalizeEpgUrl(rawUrl);
        if (!epg) throw configError('invalid_url', 'A URL do EPG precisa começar com http:// ou https:// e ser válida.');
        next.epgUrl = epg;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'startWithWindows')) next.startWithWindows = patch.startWithWindows === true;
    if (Object.prototype.hasOwnProperty.call(patch, 'startMinimizedToTray')) next.startMinimizedToTray = patch.startMinimizedToTray === true;
    if (Object.prototype.hasOwnProperty.call(patch, 'minimizeToTrayOnClose')) next.minimizeToTrayOnClose = patch.minimizeToTrayOnClose === true;
    if (Object.prototype.hasOwnProperty.call(patch, 'window')) next.window = normalizeWindow(patch.window);
    data = sanitize(next);
    save();
    return get();
  }

  function getWindowState() {
    ensureLoaded();
    return clone(data.window);
  }

  function setWindowState(partial) {
    ensureLoaded();
    data.window = normalizeWindow(Object.assign({}, data.window, partial || {}));
    try { save(); } catch (e) { /* nunca derruba o app por causa da geometria da janela */ }
    return clone(data.window);
  }

  /* ---------- usuário em cache (modo offline; nunca é credencial) ---------- */
  function readCache() {
    const raw = readJson(cacheFile);
    return isObject(raw) ? raw : {};
  }
  function writeCache(obj) {
    try { writeJsonAtomic(cacheFile, obj); } catch (e) { /* cache é best-effort */ }
  }

  function getCachedUser() {
    const cached = readCache().user;
    if (!isObject(cached) || typeof cached.email !== 'string' || !cached.email) return null;
    return {
      email: String(cached.email).slice(0, 254),
      name: typeof cached.name === 'string' ? cached.name.slice(0, 120) : '',
      role: 'user' /* o desktop não tem papel administrativo */
    };
  }

  function setCachedUser(user) {
    if (!isObject(user)) return;
    const email = String(user.email || '').trim().slice(0, 254);
    if (!email) return;
    const cache = readCache();
    cache.version = 1;
    cache.user = {
      email: email,
      name: String(user.name || '').trim().slice(0, 120),
      role: 'user',
      savedAt: new Date().toISOString()
    };
    writeCache(cache);
  }

  function clearCachedUser() {
    const cache = readCache();
    delete cache.user;
    writeCache(cache);
  }

  function validateDownloadsDir(dir) {
    const target = String(dir == null ? '' : dir).trim();
    const check = checkWritableDir(target);
    return {
      ok: check.ok === true,
      path: check.ok ? target : undefined,
      error: check.ok ? undefined : check.error,
      freeBytes: check.freeBytes != null ? check.freeBytes : undefined
    };
  }

  /* Primeiro uso: garante arquivo no disco e porta sorteada. Chamado pelo main
     antes de abrir o servidor; erros são informados (nunca escondidos). */
  function ensureInitialized() {
    ensureLoaded();
    const warnings = [];
    if (!fs.existsSync(configFile)) {
      try { save(); } catch (e) { warnings.push('Não foi possível gravar a configuração: ' + (e.code || e.message)); }
    }
    const port = effectiveInternalPort();
    const dir = resolveDownloadsDir();
    if (dir.error) warnings.push('Pasta de downloads: ' + dir.error);
    if (dir.migrated) {
      warnings.push('Downloads antigos foram movidos de "' + dir.migrated.from + '" para "' + dir.migrated.to + '".');
    }
    return { configFile: configFile, port: port, downloads: dir, warnings: warnings };
  }

  return {
    configFile: configFile,
    cacheFile: cacheFile,
    load: load,
    get: get,
    set: set,
    save: save,
    get apiOrigin() { return effectiveApiOrigin(); },
    get internalPort() { return effectiveInternalPort(); },
    get downloadsDir() { return downloadsDir(); },
    effectiveApiOrigin: effectiveApiOrigin,
    effectiveInternalPort: effectiveInternalPort,
    ensureInitialized: ensureInitialized,
    resolveDownloadsDir: resolveDownloadsDir,
    validateDownloadsDir: validateDownloadsDir,
    getWindowState: getWindowState,
    setWindowState: setWindowState,
    getCachedUser: getCachedUser,
    setCachedUser: setCachedUser,
    clearCachedUser: clearCachedUser
  };
}

function configError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

module.exports = {
  createConfig: createConfig,
  DEFAULTS: DEFAULTS,
  DEFAULT_API_ORIGIN: DEFAULT_API_ORIGIN,
  DEFAULT_EPG_URL: DEFAULT_EPG_URL,
  PORT_MIN: PORT_MIN,
  PORT_MAX: PORT_MAX,
  MIN_FREE_BYTES: MIN_FREE_BYTES,
  EPG_TTL_ALLOWED: EPG_TTL_ALLOWED,
  normalizeOrigin: normalizeOrigin,
  normalizeEpgUrl: normalizeEpgUrl,
  sanitize: sanitize,
  checkWritableDir: checkWritableDir,
  readRegistryDownloadsDir: readRegistryDownloadsDir,
  repairMangledDownloadsDir: repairMangledDownloadsDir,
  mangledPathOf: mangledPathOf,
  defaultDownloadsDir: defaultDownloadsDir,
  writeJsonAtomic: writeJsonAtomic,
  formatBytes: formatBytes
};
