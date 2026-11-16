/* Autostart (login item per-user) do Space IPTV Desktop.
 *
 * Contrato §2.4 / §3.6:
 *   - padrão DESLIGADO: o app nunca habilita sozinho;
 *   - `get()` lê o estado REAL do sistema (não só o que está no config);
 *   - `set({openAtLogin,minimized})` persiste no config e aplica;
 *   - desabilitar remove a entrada de inicialização;
 *   - `SPACE_NO_AUTOSTART=1` (testes/CI) não toca no sistema operacional.
 *
 * Windows: `app.setLoginItemSettings({openAtLogin, args:['--autostart']})` cria/remove
 * a entrada em `HKCU\...\CurrentVersion\Run` (per-user, sem UAC).
 */
'use strict';

/**
 * @param {object} opts
 * @param {object} opts.config      store de config.js (set/get)
 * @param {object} [opts.app]       app do Electron (injetável em teste)
 * @param {object} [opts.env]       process.env
 */
function createAutostart(opts) {
  opts = opts || {};
  const config = opts.config;
  const env = opts.env || process.env;
  let app = opts.app || null;

  function electronApp() {
    if (app) return app;
    try {
      const electron = require('electron');
      app = electron && electron.app ? electron.app : null;
    } catch (e) {
      app = null;
    }
    return app;
  }

  function disabled() {
    return String(env.SPACE_NO_AUTOSTART || '') === '1';
  }

  function supported() {
    return process.platform === 'win32';
  }

  function configState() {
    const cfg = config && typeof config.get === 'function' ? config.get() : {};
    return {
      openAtLogin: cfg && cfg.startWithWindows === true,
      minimized: cfg && cfg.startMinimizedToTray === true
    };
  }

  /* Estado real: o que o Windows tem registrado. Em plataforma sem suporte ou
     com autostart desabilitado por env, cai para o config (nunca inventa ligado). */
  function get() {
    const fallback = configState();
    if (disabled() || !supported()) {
      return { openAtLogin: false, minimized: fallback.minimized, disabled: disabled() };
    }
    const a = electronApp();
    if (!a || typeof a.getLoginItemSettings !== 'function') {
      return { openAtLogin: false, minimized: fallback.minimized, disabled: false };
    }
    let open = false;
    try {
      /* args fixos: no Windows o Electron identifica a entrada pelos argumentos */
      const st = a.getLoginItemSettings({ args: ['--autostart'] });
      open = !!(st && st.openAtLogin);
    } catch (e) {
      open = false;
    }
    return { openAtLogin: open, minimized: fallback.minimized, disabled: false };
  }

  function apply(open) {
    const a = electronApp();
    if (!a || typeof a.setLoginItemSettings !== 'function') return { applied: false };
    try {
      a.setLoginItemSettings({
        openAtLogin: !!open,
        openAsHidden: false,
        path: process.execPath,
        args: ['--autostart']
      });
      return { applied: true };
    } catch (e) {
      return { applied: false, error: e && e.code ? String(e.code) : 'set_failed' };
    }
  }

  /**
   * @param {{openAtLogin?:boolean,minimized?:boolean}} patch
   * @returns {{openAtLogin:boolean,minimized:boolean,disabled:boolean}}
   */
  function set(patch) {
    patch = patch || {};
    const current = get();
    const wantOpen = Object.prototype.hasOwnProperty.call(patch, 'openAtLogin')
      ? patch.openAtLogin === true
      : current.openAtLogin;
    const wantMin = Object.prototype.hasOwnProperty.call(patch, 'minimized')
      ? patch.minimized === true
      : current.minimized;

    /* Persiste primeiro a preferência (o config é a fonte do "iniciar minimizado"). */
    if (config && typeof config.set === 'function') {
      const savePatch = {};
      if (Object.prototype.hasOwnProperty.call(patch, 'openAtLogin')) savePatch.startWithWindows = wantOpen;
      if (Object.prototype.hasOwnProperty.call(patch, 'minimized')) savePatch.startMinimizedToTray = wantMin;
      if (Object.keys(savePatch).length) {
        try { config.set(savePatch); } catch (e) { /* não impede a aplicação no SO */ }
      }
    }

    if (disabled()) {
      /* Env de teste: registra a intenção no config, mas não mexe no Windows. */
      return { openAtLogin: false, minimized: wantMin, disabled: true };
    }
    if (!supported()) return { openAtLogin: false, minimized: wantMin, disabled: false };

    /* Só chama o SO quando o estado desejado difere do real (evita escrita inútil
       no registro a cada abertura da tela de Configurações). */
    if (Object.prototype.hasOwnProperty.call(patch, 'openAtLogin') || current.openAtLogin !== wantOpen) {
      apply(wantOpen);
    } else if (wantOpen === false) {
      apply(false); /* garante que uma entrada órfã seja removida */
    }
    return { openAtLogin: get().openAtLogin, minimized: wantMin, disabled: false };
  }

  return {
    get: get,
    set: set,
    disabled: disabled,
    supported: supported,
    args: ['--autostart']
  };
}

module.exports = { createAutostart: createAutostart };
