/* Preload do Space IPTV Desktop — a ÚNICA ponte entre renderer e processo principal.
 *
 * Contrato §2.3: expõe `window.space` com app/files/config/session/downloads/
 * autostart/external/events/registerMediaHosts. Só existe `ipcRenderer.invoke`/`on`
 * em canais fixos. Nada de `require`, `fs`, `path` ou canal livre no renderer.
 *
 * O preload roda com sandbox:true, então `require` de módulos locais não funciona
 * (limitação do Electron). Os nomes de canal ficam aqui espelhando
 * `src/main/channels.js`; tentamos importar o arquivo canônico e caímos na tabela
 * local quando o sandbox bloqueia — os dois lados usam os MESMOS nomes.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let CH = null;
try {
  /* Funciona quando o preload roda fora do sandbox; no sandbox cai no catch. */
  CH = require('../main/channels');
} catch (e) {
  CH = null;
}

const C = CH || {
  APP_INFO: 'space:app:info',
  APP_VERSION: 'space:app:version',
  APP_QUIT: 'space:app:quit',
  APP_MINIMIZE: 'space:app:minimize',
  APP_HIDE_TO_TRAY: 'space:app:hide-to-tray',
  FILES_PICK_M3U: 'space:files:pick-m3u',
  CONFIG_GET: 'space:config:get',
  CONFIG_SET: 'space:config:set',
  CONFIG_PICK_FOLDER: 'space:config:pick-folder',
  CONFIG_VALIDATE_DIR: 'space:config:validate-dir',
  SESSION_GET_USER: 'space:session:get-user',
  SESSION_SET_USER: 'space:session:set-user',
  SESSION_CLEAR_USER: 'space:session:clear-user',
  SESSION_CLEAR_COOKIES: 'space:session:clear-cookies',
  DL_PROBE: 'space:downloads:probe',
  DL_ADD: 'space:downloads:add',
  DL_PAUSE: 'space:downloads:pause',
  DL_RESUME: 'space:downloads:resume',
  DL_CANCEL: 'space:downloads:cancel',
  DL_RETRY: 'space:downloads:retry',
  DL_REMOVE: 'space:downloads:remove',
  DL_LIST: 'space:downloads:list',
  DL_REVEAL: 'space:downloads:reveal',
  DL_OPEN_FOLDER: 'space:downloads:open-folder',
  AUTOSTART_GET: 'space:autostart:get',
  AUTOSTART_SET: 'space:autostart:set',
  EXTERNAL_OPEN: 'space:external:open',
  REGISTER_MEDIA_HOSTS: 'space:media-hosts:register',
  EVENT: 'space:event'
};

const EVENT_CHANNELS = { network: true, tray: true, update: true };

function invoke(channel, payload) {
  return ipcRenderer.invoke(channel, payload);
}

/* Assina um canal de eventos e devolve a função de cancelamento. */
function subscribe(channelName) {
  return function (cb) {
    if (typeof cb !== 'function') return function () {};
    const listener = function (_event, envelope) {
      if (!envelope || envelope.channel !== channelName) return;
      try { cb(envelope.payload); } catch (e) { /* erro do renderer não derruba o preload */ }
    };
    ipcRenderer.on(C.EVENT, listener);
    return function () {
      try { ipcRenderer.removeListener(C.EVENT, listener); } catch (e) { /* ignore */ }
    };
  };
}

const space = {
  app: {
    version: function () { return invoke(C.APP_VERSION); },
    info: function () { return invoke(C.APP_INFO); },
    quit: function () { return invoke(C.APP_QUIT); },
    minimize: function () { return invoke(C.APP_MINIMIZE); },
    hideToTray: function () { return invoke(C.APP_HIDE_TO_TRAY); }
  },

  files: {
    /* {maxBytes?} -> {ok, canceled?, name?, size?, text?, error?} */
    pickM3u: function (opts) {
      const payload = (opts && typeof opts === 'object' && Number(opts.maxBytes) > 0)
        ? { maxBytes: Math.floor(Number(opts.maxBytes)) }
        : undefined;
      return invoke(C.FILES_PICK_M3U, payload);
    }
  },

  config: {
    get: function () { return invoke(C.CONFIG_GET); },
    set: function (patch) { return invoke(C.CONFIG_SET, patch && typeof patch === 'object' ? patch : {}); },
    pickFolder: function (opts) {
      const payload = {};
      if (opts && typeof opts === 'object') {
        if (typeof opts.title === 'string') payload.title = opts.title.slice(0, 200);
        if (typeof opts.defaultPath === 'string') payload.defaultPath = opts.defaultPath.slice(0, 1024);
      }
      return invoke(C.CONFIG_PICK_FOLDER, payload);
    },
    validateDownloadsDir: function (dir) { return invoke(C.CONFIG_VALIDATE_DIR, String(dir == null ? '' : dir)); }
  },

  session: {
    getCachedUser: function () { return invoke(C.SESSION_GET_USER); },
    setCachedUser: function (user) {
      const payload = user && typeof user === 'object'
        ? { email: String(user.email || '').slice(0, 254), name: String(user.name || '').slice(0, 120), role: 'user' }
        : {};
      return invoke(C.SESSION_SET_USER, payload);
    },
    clearCachedUser: function () { return invoke(C.SESSION_CLEAR_USER); },
    clearCookies: function () { return invoke(C.SESSION_CLEAR_COOKIES); }
  },

  downloads: {
    probe: function (req) { return invoke(C.DL_PROBE, req || {}); },
    add: function (req) { return invoke(C.DL_ADD, req || {}); },
    pause: function (id) { return invoke(C.DL_PAUSE, String(id == null ? '' : id)); },
    resume: function (id) { return invoke(C.DL_RESUME, String(id == null ? '' : id)); },
    cancel: function (id) { return invoke(C.DL_CANCEL, String(id == null ? '' : id)); },
    retry: function (id) { return invoke(C.DL_RETRY, String(id == null ? '' : id)); },
    remove: function (id, opts) {
      return invoke(C.DL_REMOVE, {
        id: String(id == null ? '' : id),
        deleteFiles: !!(opts && opts.deleteFiles)
      });
    },
    list: function () { return invoke(C.DL_LIST); },
    reveal: function (id) { return invoke(C.DL_REVEAL, String(id == null ? '' : id)); },
    openFolder: function () { return invoke(C.DL_OPEN_FOLDER); },
    onEvent: subscribe('downloads')
  },

  autostart: {
    get: function () { return invoke(C.AUTOSTART_GET); },
    set: function (patch) {
      const payload = {};
      if (patch && typeof patch === 'object') {
        if (Object.prototype.hasOwnProperty.call(patch, 'openAtLogin')) payload.openAtLogin = patch.openAtLogin === true;
        if (Object.prototype.hasOwnProperty.call(patch, 'minimized')) payload.minimized = patch.minimized === true;
      }
      return invoke(C.AUTOSTART_SET, payload);
    }
  },

  external: {
    /* Somente http(s) é validado no main; aqui só repassa a string. */
    open: function (url) { return invoke(C.EXTERNAL_OPEN, String(url == null ? '' : url)); }
  },

  events: {
    on: function (channel, cb) {
      if (!EVENT_CHANNELS[channel]) return function () {};
      return subscribe(channel)(cb);
    }
  },

  /* Hosts de mídia permitidos no proxy local. Chamado pelo renderer ao logar/boot. */
  registerMediaHosts: function (hosts) {
    const list = Array.isArray(hosts) ? hosts.filter(function (h) { return typeof h === 'string'; }).slice(0, 200) : [];
    return invoke(C.REGISTER_MEDIA_HOSTS, list);
  }
};

try {
  contextBridge.exposeInMainWorld('space', space);
} catch (e) {
  /* ambiente sem contextBridge (teste de Node): não há o que expor */
}
