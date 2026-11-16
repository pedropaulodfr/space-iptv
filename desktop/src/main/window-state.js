/* Estado da janela: posição/tamanho/maximizado persistidos no config.
 *
 * Padrão 1366×768; mínimo 1024×640. Se a posição salva ficou fora dos monitores
 * (monitor desconectado, resolução trocada), centraliza em vez de abrir no vazio.
 * Escritas são agrupadas (debounce) para não regravar o JSON a cada pixel.
 */
'use strict';

const MIN_WIDTH = 1024;
const MIN_HEIGHT = 640;
const DEFAULT_WIDTH = 1366;
const DEFAULT_HEIGHT = 768;
const SAVE_DELAY_MS = 400;

/**
 * @param {object} opts
 * @param {object} opts.config          store de config.js (getWindowState/setWindowState)
 * @param {object} [opts.screen]        módulo `screen` do Electron (injetável)
 * @param {object} [opts.log]
 */
function createWindowState(opts) {
  opts = opts || {};
  const config = opts.config;
  let screenApi = opts.screen || null;
  let timer = null;
  let pendingWin = null;
  let lastPersisted = '';

  function getScreen() {
    if (screenApi) return screenApi;
    try {
      const electron = require('electron');
      screenApi = electron && electron.screen ? electron.screen : null;
    } catch (e) {
      screenApi = null;
    }
    return screenApi;
  }

  function savedState() {
    try {
      const w = config && typeof config.getWindowState === 'function' ? config.getWindowState() : null;
      if (w && typeof w === 'object') return w;
    } catch (e) { /* ignore */ }
    return { x: null, y: null, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false };
  }

  function workAreaContains(area, x, y, width, height) {
    if (!area) return false;
    /* exige um pedaço visível generoso do título da janela */
    const visibleW = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    const visibleH = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
    return visibleW >= 120 && visibleH >= 80;
  }

  /* Opções para `new BrowserWindow(...)`. `undefined` deixa o Electron centralizar. */
  function restore() {
    const saved = savedState();
    const screen = getScreen();
    const out = {
      width: clamp(saved.width, MIN_WIDTH, 8192, DEFAULT_WIDTH),
      height: clamp(saved.height, MIN_HEIGHT, 8192, DEFAULT_HEIGHT),
      maximized: saved.maximized === true
    };
    if (!screen || typeof screen.getAllDisplays !== 'function') return out;
    let displays;
    try { displays = screen.getAllDisplays() || []; } catch (e) { displays = []; }
    if (!displays.length) return out;
    const x = Number.isFinite(saved.x) ? Math.round(saved.x) : null;
    const y = Number.isFinite(saved.y) ? Math.round(saved.y) : null;
    if (x == null || y == null) return out;
    for (let i = 0; i < displays.length; i++) {
      if (workAreaContains(displays[i].workArea, x, y, out.width, out.height)) {
        out.x = x;
        out.y = y;
        return out;
      }
    }
    return out; /* fora de qualquer monitor: deixa o Windows centralizar */
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    const win = pendingWin;
    pendingWin = null;
    if (!win || win.isDestroyed()) return;
    let bounds;
    try {
      bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    } catch (e) {
      return;
    }
    let maximized = false;
    try { maximized = win.isMaximized() === true; } catch (e) { maximized = false; }
    const next = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      maximized: maximized
    };
    const key = JSON.stringify(next);
    if (key === lastPersisted) return;
    lastPersisted = key;
    try {
      if (config && typeof config.setWindowState === 'function') config.setWindowState(next);
    } catch (e) { /* geometria da janela nunca derruba o app */ }
  }

  function schedule(win) {
    pendingWin = win;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
    if (timer.unref) timer.unref();
  }

  /* Liga os eventos da janela. Devolve uma função para remover os listeners. */
  function track(win) {
    if (!win || typeof win.on !== 'function') return function () {};
    const save = function () { schedule(win); };
    const events = ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'];
    events.forEach(function (name) {
      try { win.on(name, save); } catch (e) { /* ignore */ }
    });
    try { win.once('close', function () { flush(); }); } catch (e) { /* ignore */ }
    return function () {
      events.forEach(function (name) {
        try { win.removeListener(name, save); } catch (e) { /* ignore */ }
      });
      flush();
    };
  }

  function applyRestoredState(win, restored) {
    if (!win) return;
    if (restored && restored.maximized) {
      try { win.maximize(); } catch (e) { /* ignore */ }
    }
  }

  return {
    restore: restore,
    track: track,
    flush: flush,
    applyRestoredState: applyRestoredState,
    constants: { MIN_WIDTH: MIN_WIDTH, MIN_HEIGHT: MIN_HEIGHT, DEFAULT_WIDTH: DEFAULT_WIDTH, DEFAULT_HEIGHT: DEFAULT_HEIGHT }
  };
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

module.exports = {
  createWindowState: createWindowState,
  MIN_WIDTH: MIN_WIDTH,
  MIN_HEIGHT: MIN_HEIGHT,
  DEFAULT_WIDTH: DEFAULT_WIDTH,
  DEFAULT_HEIGHT: DEFAULT_HEIGHT
};
