/* Handlers IPC do processo principal (canais de `src/main/channels.js`).
 *
 * Responsabilidade: app, arquivos (dialog nativo), config, sessão (perfil em cache +
 * cookies), autostart, links externos e registro de hosts de mídia.
 *
 * Os canais `DL_*` NÃO são registrados aqui: o módulo `downloads.js` registra os
 * handlers dele em `initDownload` (combinado com o lead). Registrar de novo faria o
 * Electron recusar o segundo `ipcMain.handle` para o mesmo canal.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { formatBytes } = require('./config');

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const HARD_MAX_BYTES = 64 * 1024 * 1024;

function friendlyFileError(err) {
  const code = err && err.code;
  if (code === 'ENOENT') return 'O arquivo não existe mais. Escolha outro.';
  if (code === 'EACCES' || code === 'EPERM') return 'Sem permissão para ler este arquivo.';
  if (code === 'EISDIR') return 'Escolha um arquivo, não uma pasta.';
  if (code === 'ENOSPC') return 'Não há espaço em disco.';
  return 'Não foi possível ler o arquivo. Tente de novo.';
}

function safeExternalUrl(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value || value.length > 2048) return null;
  let u;
  try { u = new URL(value); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u.toString();
}

/**
 * @param {object} opts
 * @param {object} opts.config       store de config.js
 * @param {object} [opts.autostart]  autostart.js
 * @param {object} [opts.server]     server.js (registerMediaHosts / url)
 * @param {function():object} [opts.getWindow]
 * @param {string} [opts.version]
 * @param {object} [opts.electron]   injeção de teste ({ipcMain, dialog, shell, session, app})
 */
function createIpc(opts) {
  opts = opts || {};
  const config = opts.config;
  const autostart = opts.autostart || null;
  const server = opts.server || null;
  const getWindow = typeof opts.getWindow === 'function' ? opts.getWindow : function () { return null; };
  const version = String(opts.version || '1.0.0');

  let el = opts.electron || null;
  function electronApi() {
    if (el) return el;
    try {
      const electron = require('electron');
      if (electron && electron.ipcMain) {
        el = {
          ipcMain: electron.ipcMain,
          dialog: electron.dialog,
          shell: electron.shell,
          session: electron.session,
          app: electron.app
        };
      } else {
        el = null;
      }
    } catch (e) {
      el = null;
    }
    return el;
  }

  const registered = new Set();
  let disposed = false;

  function handle(channel, fn) {
    const a = electronApi();
    if (!a || !a.ipcMain) return;
    if (registered.has(channel)) return;
    registered.add(channel);
    a.ipcMain.handle(channel, async function (event, arg) {
      try {
        return await fn(arg, event);
      } catch (err) {
        /* Erro previsto de validação: devolve mensagem amigável sem detalhes internos. */
        const message = err && err.code === 'invalid_dir'
          ? String(err.message || 'Pasta inválida.')
          : 'Não foi possível concluir a operação. Tente de novo.';
        return { ok: false, error: message, code: err && err.code ? String(err.code) : 'error' };
      }
    });
  }

  function mainWindow() {
    try {
      const win = getWindow();
      return win && !win.isDestroyed() ? win : null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- app ---------- */
  handle('space:app:version', function () { return version; });

  handle('space:app:info', function () {
    const a = electronApi();
    let userData = '';
    try { userData = a && a.app ? a.app.getPath('userData') : ''; } catch (e) { userData = ''; }
    return {
      version: version,
      apiOrigin: (function () { try { return config.effectiveApiOrigin(); } catch (e) { return ''; } })(),
      downloadsDir: (function () { try { return config.downloadsDir; } catch (e) { return ''; } })(),
      userData: userData
    };
  });

  handle('space:app:quit', function () {
    const a = electronApi();
    if (a && a.app) a.app.quit();
    return true;
  });

  handle('space:app:minimize', function () {
    const win = mainWindow();
    if (win) { try { win.minimize(); } catch (e) { /* ignore */ } }
    return true;
  });

  handle('space:app:hide-to-tray', function () {
    const win = mainWindow();
    if (win) { try { win.hide(); } catch (e) { /* ignore */ } }
    return true;
  });

  /* ---------- arquivos (somente o que o usuário escolheu no dialog nativo) ---------- */
  handle('space:files:pick-m3u', async function (arg) {
    const a = electronApi();
    if (!a || !a.dialog) return { ok: false, error: 'Dialog indisponível.' };
    const requested = arg && Number(arg.maxBytes) > 0 ? Math.floor(Number(arg.maxBytes)) : DEFAULT_MAX_BYTES;
    const maxBytes = Math.max(1, Math.min(HARD_MAX_BYTES, requested));
    const r = await a.dialog.showOpenDialog(mainWindow() || undefined, {
      title: 'Escolher lista M3U',
      buttonLabel: 'Abrir',
      properties: ['openFile'],
      filters: [
        { name: 'Listas M3U', extensions: ['m3u', 'm3u8'] },
        { name: 'Todos os arquivos', extensions: ['*'] }
      ]
    });
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    const file = r.filePaths[0];
    if (!/\.m3u8?$/i.test(file)) {
      return { ok: false, error: 'Escolha um arquivo com extensão .m3u ou .m3u8.' };
    }
    let stat;
    try { stat = await fsp.stat(file); } catch (e) {
      return { ok: false, error: friendlyFileError(e) };
    }
    if (!stat.isFile()) return { ok: false, error: 'Escolha um arquivo, não uma pasta.' };
    if (stat.size > maxBytes) {
      return { ok: false, error: 'O arquivo tem ' + formatBytes(stat.size) + ' e o limite é ' + formatBytes(maxBytes) + '. Use uma lista menor.' };
    }
    if (!stat.size) return { ok: false, error: 'O arquivo está vazio.' };
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch (e) {
      return { ok: false, error: friendlyFileError(e) };
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (!text.replace(/^\s+|\s+$/g, '')) return { ok: false, error: 'O arquivo está vazio.' };
    /* Validação de conteúdo fica no renderer (App.m3u.parse), com a mesma mensagem da web. */
    return { ok: true, name: path.basename(file), size: stat.size, text: text };
  });

  /* ---------- config ---------- */
  handle('space:config:get', function () { return config.get(); });

  handle('space:config:set', async function (patch) {
    let updated;
    try {
      updated = config.set(patch || {});
    } catch (err) {
      return { ok: false, error: String(err && err.message || 'Não foi possível salvar.'), code: String(err && err.code || 'error') };
    }
    /* "Iniciar com o Windows" também precisa aplicar no SO. */
    if (autostart && patch && Object.prototype.hasOwnProperty.call(patch, 'startWithWindows')) {
      try { autostart.set({ openAtLogin: patch.startWithWindows === true }); } catch (e) { /* config já salvo */ }
    }
    return updated;
  });

  handle('space:config:pick-folder', async function (arg) {
    const a = electronApi();
    if (!a || !a.dialog) return null;
    const options = {
      title: (arg && typeof arg.title === 'string' && arg.title) || 'Escolher pasta de downloads',
      buttonLabel: 'Usar esta pasta',
      properties: ['openDirectory', 'createDirectory']
    };
    if (arg && typeof arg.defaultPath === 'string' && arg.defaultPath.trim()) {
      options.defaultPath = arg.defaultPath.trim();
    }
    const r = await a.dialog.showOpenDialog(mainWindow() || undefined, options);
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  handle('space:config:validate-dir', function (dir) {
    return config.validateDownloadsDir(String(dir == null ? '' : dir));
  });

  /* ---------- sessão (perfil público em cache — nunca token/senha) ---------- */
  handle('space:session:get-user', function () { return config.getCachedUser(); });

  handle('space:session:set-user', function (user) {
    config.setCachedUser(user || {});
    return true;
  });

  handle('space:session:clear-user', function () {
    config.clearCachedUser();
    return true;
  });

  handle('space:session:clear-cookies', async function () {
    const a = electronApi();
    if (!a || !a.session || !a.session.defaultSession) return false;
    const ses = a.session.defaultSession;
    let origin = '';
    try { origin = server && server.url ? String(server.url) : ''; } catch (e) { origin = ''; }
    try {
      const options = { storages: ['cookies'] };
      /* Limita à origem interna quando ela já existe (nunca limpa cookies de outro site). */
      if (origin) options.origin = origin;
      await ses.clearStorageData(options);
    } catch (e) { /* segue: cache ainda pode ser limpo */ }
    try { await ses.clearCache(); } catch (e) { /* ignore */ }
    return true;
  });

  /* ---------- autostart ---------- */
  handle('space:autostart:get', function () {
    if (!autostart) return { openAtLogin: false, minimized: false, disabled: true };
    return autostart.get();
  });

  handle('space:autostart:set', function (patch) {
    if (!autostart) return { openAtLogin: false, minimized: false, disabled: true };
    return autostart.set(patch || {});
  });

  /* ---------- links externos (SOMENTE http/https, a pedido do renderer) ---------- */
  handle('space:external:open', async function (raw) {
    const a = electronApi();
    const url = safeExternalUrl(raw);
    if (!url) return { ok: false, error: 'Link inválido.' };
    if (!a || !a.shell) return { ok: false, error: 'Não foi possível abrir o navegador.' };
    try {
      await a.shell.openExternal(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Não foi possível abrir o navegador.' };
    }
  });

  /* ---------- allowlist de hosts de mídia (registrada pelo renderer) ---------- */
  handle('space:media-hosts:register', function (hosts) {
    if (!server || typeof server.registerMediaHosts !== 'function') return false;
    server.registerMediaHosts(Array.isArray(hosts) ? hosts : []);
    return true;
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    const a = electronApi();
    if (!a || !a.ipcMain) return;
    for (const channel of registered) {
      try { a.ipcMain.removeHandler(channel); } catch (e) { /* ignore */ }
    }
    registered.clear();
  }

  return { dispose: dispose, registeredChannels: function () { return Array.from(registered); } };
}

module.exports = { createIpc: createIpc, safeExternalUrl: safeExternalUrl, DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES };
