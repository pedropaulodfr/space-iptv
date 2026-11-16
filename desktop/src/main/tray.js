/* Bandeja (system tray) do Space IPTV Desktop.
 *
 * Menu: Abrir · Baixados · Sair. Clique/duplo clique abre a janela.
 * "Baixados" mostra a janela e avisa o renderer (`tray` → {action:'downloads'}).
 * Em `--smoke` nunca é criada (o teste automatizado não pode ficar preso na bandeja).
 */
'use strict';

const fs = require('fs');

/**
 * @param {object} opts
 * @param {object} opts.config        store de config.js
 * @param {function():object} opts.getWindow  devolve a BrowserWindow atual (ou null)
 * @param {function():void} [opts.onOpen]
 * @param {function():void} [opts.onDownloads]
 * @param {function():void} [opts.onQuit]
 * @param {string[]} [opts.iconPaths] caminhos candidatos do ícone
 * @param {object} [opts.electron]    injeção p/ teste ({Tray, Menu, nativeImage})
 */
function createTray(opts) {
  opts = opts || {};
  let tray = null;
  let api = opts.electron || null;

  function electronApi() {
    if (api) return api;
    try {
      const electron = require('electron');
      if (electron && electron.Tray && electron.Menu && electron.nativeImage) {
        api = { Tray: electron.Tray, Menu: electron.Menu, nativeImage: electron.nativeImage };
      } else {
        api = null;
      }
    } catch (e) {
      api = null;
    }
    return api;
  }

  function resolveIcon() {
    const paths = Array.isArray(opts.iconPaths) ? opts.iconPaths.filter(Boolean) : [];
    const a = electronApi();
    if (!a) return null;
    for (let i = 0; i < paths.length; i++) {
      try {
        if (!fs.existsSync(paths[i])) continue;
        const img = a.nativeImage.createFromPath(paths[i]);
        if (img && (typeof img.isEmpty !== 'function' || !img.isEmpty())) return img;
      } catch (e) { /* tenta o próximo */ }
    }
    return null;
  }

  function showWindow() {
    const win = typeof opts.getWindow === 'function' ? opts.getWindow() : null;
    if (!win || win.isDestroyed()) {
      if (typeof opts.onOpen === 'function') opts.onOpen();
      return;
    }
    try {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } catch (e) { /* ignore */ }
  }

  function openDownloads() {
    showWindow();
    if (typeof opts.onDownloads === 'function') opts.onDownloads();
  }

  function quit() {
    if (typeof opts.onQuit === 'function') opts.onQuit();
  }

  function buildMenu(a) {
    return a.Menu.buildFromTemplate([
      { label: 'Abrir Space IPTV', click: showWindow },
      { label: 'Baixados', click: openDownloads },
      { type: 'separator' },
      { label: 'Sair', click: quit }
    ]);
  }

  function create() {
    if (tray) return tray;
    const a = electronApi();
    if (!a) return null;
    const icon = resolveIcon();
    if (!icon) return null;
    try {
      tray = new a.Tray(icon);
    } catch (e) {
      tray = null;
      return null;
    }
    try { tray.setToolTip('Space IPTV'); } catch (e) { /* ignore */ }
    try { tray.setContextMenu(buildMenu(a)); } catch (e) { /* ignore */ }
    try {
      tray.on('click', showWindow);
      tray.on('double-click', showWindow);
    } catch (e) { /* ignore */ }
    return tray;
  }

  function setTooltip(text) {
    if (!tray) return;
    try { tray.setToolTip(String(text || 'Space IPTV')); } catch (e) { /* ignore */ }
  }

  function destroy() {
    if (!tray) return;
    try { tray.destroy(); } catch (e) { /* ignore */ }
    tray = null;
  }

  return {
    create: create,
    destroy: destroy,
    isCreated: function () { return !!tray; },
    setTooltip: setTooltip,
    showWindow: showWindow
  };
}

module.exports = { createTray: createTray };
