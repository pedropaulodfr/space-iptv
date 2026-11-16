/* Processo principal do Space IPTV Desktop.
 *
 * Responsabilidades:
 *   - instância única; janela nativa persistente (window-state.js);
 *   - servidor HTTP interno em 127.0.0.1 ANTES da janela (nunca file://);
 *   - menu de aplicação mínimo (sem itens perigosos), bloqueio de navegação externa;
 *   - bandeja (Abrir/Baixados/Sair), minimizar para tray conforme config;
 *   - modos --autostart, --smoke, --dev e variáveis de ambiente de teste;
 *   - auto-update somente empacotado e configurado;
 *   - encerramento limpo (servidor, downloads, tray, monitor de rede).
 */
'use strict';

const path = require('path');
const fs = require('fs');

const { app, BrowserWindow, Menu, dialog, session, screen } = require('electron');

const channels = require('./channels');
const { createConfig } = require('./config');
const { createAutostart } = require('./autostart');
const { createServer } = require('./server');
const { createWindowState, MIN_WIDTH, MIN_HEIGHT } = require('./window-state');
const { createTray } = require('./tray');
const { createNetStatus } = require('./net-status');
const { createIpc } = require('./ipc');

const ENV = process.env;
const IS_SMOKE = process.argv.indexOf('--smoke') >= 0;
const IS_DEV = process.argv.indexOf('--dev') >= 0;
const IS_AUTOSTART = process.argv.indexOf('--autostart') >= 0;
const APP_ID = 'com.spaceiptv.desktop';
const WINDOW_BG = '#050711';

const S = {
  config: null,
  autostart: null,
  server: null,
  serverInfo: null,
  window: null,
  tray: null,
  net: null,
  windowState: null,
  downloads: null,
  ipc: null,
  quitting: false,
  smokeDone: false,
  smokeTimer: null,
  warnings: []
};

/* Nome do app antes do `ready`: mantém um único userData (cookies/sessão persistem). */
try { app.setName('Space IPTV'); } catch (e) { /* ignore */ }
try { app.setAppUserModelId(APP_ID); } catch (e) { /* ignore */ }

/* Testes/E2E: permite um userData isolado (cookies + IndexedDB limpos) sem tocar
   no perfil real do usuário. Só tem efeito quando SPACE_USER_DATA está definido. */
(function isolateUserData() {
  const wanted = String(ENV.SPACE_USER_DATA || '').trim();
  if (!wanted) return;
  try {
    const dir = path.resolve(wanted);
    fs.mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
    try { app.setPath('sessionData', dir); } catch (e) { /* versões antigas */ }
  } catch (e) {
    console.warn('[main] SPACE_USER_DATA inválido: ' + (e && e.code ? e.code : 'erro'));
  }
})();

/* ============================ utilidades ============================ */

function safeRequire(rel) {
  const file = './' + rel;
  try {
    return require(file);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message || '').indexOf("'" + file + "'") >= 0) return null;
    console.error('[main] módulo opcional ' + rel + ' falhou: ' + (e && e.code ? e.code : 'erro'));
    return null;
  }
}

function existsFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; }
}

function rendererDir() {
  const override = String(ENV.SPACE_RENDERER_DIR || '').trim();
  if (override) return path.resolve(override);
  if (app.isPackaged) return path.join(app.getAppPath(), 'dist', 'renderer');
  return path.join(__dirname, '..', '..', 'dist', 'renderer');
}

function assetCandidates(name) {
  const list = [];
  if (app.isPackaged) list.push(path.join(app.getAppPath(), 'build', name));
  list.push(path.join(__dirname, '..', '..', 'build', name));
  list.push(path.join(rendererDir(), 'tv', name.indexOf('icon') === 0 ? 'icon.png' : name));
  return list;
}

function firstExistingFile(candidates) {
  for (let i = 0; i < candidates.length; i++) if (existsFile(candidates[i])) return candidates[i];
  return null;
}

function windowIconPath() {
  return firstExistingFile(assetCandidates('icon.ico').concat(assetCandidates('icon.png')));
}

function trayIconPaths() {
  const paths = [];
  const ico = firstExistingFile(assetCandidates('icon-tray.png').concat(assetCandidates('icon.ico')));
  if (ico) paths.push(ico);
  const png = firstExistingFile(assetCandidates('icon-256.png'));
  if (png) paths.push(png);
  const tv = path.join(rendererDir(), 'tv', 'icon.png');
  if (existsFile(tv)) paths.push(tv);
  return paths;
}

function emit(channel, payload) {
  try {
    if (!S.window || S.window.isDestroyed()) return;
    const wc = S.window.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send(channels.EVENT, { channel: String(channel), payload: payload == null ? null : payload });
  } catch (e) { /* janela fechando: evento perdido é aceitável */ }
}

function showMainWindow() {
  const win = S.window;
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch (e) { /* ignore */ }
}

function hideMainWindow() {
  const win = S.window;
  if (!win || win.isDestroyed()) return;
  try { win.hide(); } catch (e) { /* ignore */ }
}

/* ============================ menu ============================ */

function aboutDialog() {
  const version = app.getVersion();
  const detail =
    'Reprodutor de listas fornecidas por você. O aplicativo não inclui canais nem conteúdo.\n\n' +
    'Versão ' + version + '\n' +
    'Origem da API: ' + (S.config ? S.config.effectiveApiOrigin() : '') + '\n\n' +
    'Este build não é assinado digitalmente: o Windows pode exibir um aviso do SmartScreen ' +
    'na primeira execução. Isso é esperado e não indica problema no aplicativo.';
  const options = {
    type: 'info',
    title: 'Sobre o Space IPTV',
    message: 'Space IPTV ' + version,
    detail: detail,
    buttons: ['OK'],
    noLink: true
  };
  try {
    if (S.window && !S.window.isDestroyed()) dialog.showMessageBox(S.window, options);
    else dialog.showMessageBox(options);
  } catch (e) { /* ignore */ }
}

function buildApplicationMenu() {
  const template = [
    {
      label: 'Aplicativo',
      submenu: [
        { label: 'Sobre o Space IPTV', click: aboutDialog },
        { type: 'separator' },
        {
          label: 'Minimizar para a bandeja',
          click: hideMainWindow
        },
        { label: 'Sair', accelerator: 'CmdOrCtrl+Q', click: function () { app.quit(); } }
      ]
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' }
      ]
    },
    {
      label: 'Exibir',
      submenu: [
        { role: 'resetZoom', label: 'Zoom padrão' },
        { role: 'zoomIn', label: 'Aumentar zoom' },
        { role: 'zoomOut', label: 'Diminuir zoom' }
      ].concat(IS_DEV ? [{ type: 'separator' }, { role: 'toggleDevTools', label: 'Ferramentas do desenvolvedor' }] : [])
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'minimize', label: 'Minimizar' },
        { role: 'close', label: 'Fechar' }
      ]
    }
  ];
  try { Menu.setApplicationMenu(Menu.buildFromTemplate(template)); } catch (e) { /* ignore */ }
}

/* ============================ janela ============================ */

function shouldStartHidden() {
  if (IS_SMOKE) return true;
  if (!IS_AUTOSTART) return false;
  try {
    const cfg = S.config ? S.config.get() : {};
    return cfg.startMinimizedToTray === true;
  } catch (e) {
    return false;
  }
}

function isInternalUrl(rawUrl) {
  try {
    const base = S.serverInfo && S.serverInfo.url ? S.serverInfo.url : '';
    if (!base) return false;
    const target = new URL(String(rawUrl));
    const origin = new URL(base);
    return target.origin === origin.origin;
  } catch (e) {
    return false;
  }
}

function installNavigationGuards(win) {
  const wc = win.webContents;
  /* Janela nova nunca é aberta pelo renderer; links externos só via IPC controlado. */
  wc.setWindowOpenHandler(function () {
    return { action: 'deny' };
  });
  wc.on('will-navigate', function (event, url) {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      if (IS_DEV) console.warn('[main] navegação externa bloqueada:', String(url).slice(0, 80));
    }
  });
  wc.on('will-attach-webview', function (event) {
    event.preventDefault();
  });
  wc.on('render-process-gone', function (event, details) {
    console.error('[main] renderer caiu: ' + (details && details.reason ? details.reason : 'desconhecido'));
  });
  wc.on('console-message', function (event, level, message) {
    if (!IS_SMOKE && !IS_DEV) return;
    if (level < 2) return; /* só warnings/erros */
    const text = String(message == null ? '' : message).slice(0, 400);
    console.error('RENDERER_' + (level >= 3 ? 'ERROR' : 'WARN') + ': ' + text);
  });
}

function installSessionGuards() {
  try {
    const ses = session.defaultSession;
    /* Desktop não usa câmera/mic/localização/notificações: nega tudo por padrão. */
    ses.setPermissionRequestHandler(function (wc, permission, callback) {
      callback(false);
    });
    if (typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler(function () { return false; });
    }
  } catch (e) { /* ignore */ }
}

async function createMainWindow() {
  const restored = S.windowState.restore();
  const options = {
    width: restored.width,
    height: restored.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: WINDOW_BG,
    title: 'Space IPTV',
    autoHideMenuBar: !IS_DEV,
    /* desktop: o app usa o palco preenchido e o player é um overlay interno;
       tela cheia do SO/HTML não é necessária (botão removido do HUD). */
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      spellcheck: false,
      webviewTag: false,
      devTools: IS_DEV
    }
  };
  if (Number.isFinite(restored.x)) options.x = restored.x;
  if (Number.isFinite(restored.y)) options.y = restored.y;
  const icon = windowIconPath();
  if (icon) options.icon = icon;

  const win = new BrowserWindow(options);
  S.window = win;

  installNavigationGuards(win);
  S.windowState.track(win);
  S.windowState.applyRestoredState(win, restored);

  const hidden = shouldStartHidden();
  win.once('ready-to-show', function () {
    if (hidden) return;
    try { win.show(); } catch (e) { /* ignore */ }
  });

  /* Fechar = minimizar para a bandeja SOMENTE se configurado e a bandeja existir. */
  win.on('close', function (event) {
    if (S.quitting) return;
    let minimizeToTray = false;
    try { minimizeToTray = S.config && S.config.get().minimizeToTrayOnClose === true; } catch (e) { minimizeToTray = false; }
    if (minimizeToTray && S.tray && S.tray.isCreated()) {
      event.preventDefault();
      try { win.hide(); } catch (e) { /* ignore */ }
      if (IS_DEV) console.log('[main] janela minimizada para a bandeja');
    }
  });

  win.on('closed', function () {
    if (S.window === win) S.window = null;
  });

  if (IS_SMOKE) {
    /* Pronto = primeiro sinal confiável do renderer (dom-ready ou load completo).
       `did-fail-load` só falha para o frame principal e ignorando ERR_ABORTED (-3),
       que é normal quando a página inicial redireciona para /login.html. */
    let smokeReady = false;
    const smokeOk = function () {
      if (smokeReady) return;
      smokeReady = true;
      smokeFinish(0, 'SPACE_SERVER=' + (S.serverInfo ? S.serverInfo.url : ''));
    };
    win.webContents.once('dom-ready', function () { setTimeout(smokeOk, 120); });
    win.webContents.once('did-finish-load', smokeOk);
    win.webContents.once('did-fail-load', function (event, code, description, url, isMainFrame) {
      if (isMainFrame === false) return;
      if (code === -3) return; /* ERR_ABORTED: redirecionamento interno (login/sessão) */
      smokeFinish(1, 'SPACE_SMOKE_ERROR=' + code + ' ' + String(description || '').slice(0, 120) + ' ' + String(url || '').slice(0, 200));
    });
    win.webContents.on('render-process-gone', function (event, details) {
      smokeFinish(1, 'SPACE_SMOKE_ERROR=renderer_gone:' + (details && details.reason ? details.reason : 'unknown'));
    });
  } else if (IS_DEV) {
    win.webContents.once('did-finish-load', function () {
      try { win.webContents.openDevTools({ mode: 'detach' }); } catch (e) { /* ignore */ }
    });
  }

  win.loadURL(S.serverInfo.url + '/');
  return win;
}

/* ============================ downloads ============================ */

function initDownloadsModule() {
  const mod = safeRequire('downloads');
  if (!mod) return null;
  S.downloads = mod;
  if (typeof mod.initDownload === 'function') {
    try {
      mod.initDownload({
        config: S.config,
        emit: emit,
        getMainWindow: function () { return S.window; },
        app: app
      });
    } catch (e) {
      console.error('[main] downloads.initDownload falhou: ' + (e && e.code ? e.code : 'erro'));
    }
  }
  return mod;
}

/* ============================ auto-update ============================ */

function setupAutoUpdate() {
  if (IS_SMOKE) return;
  if (!app.isPackaged) return;
  if (String(ENV.SPACE_NO_UPDATE || '') === '1') return;
  let autoUpdater = null;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (e) {
    return; /* dependência ausente: nunca derruba o app */
  }
  if (!autoUpdater) return;
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', function () { emit('update', { state: 'checking' }); });
    autoUpdater.on('update-available', function (info) { emit('update', { state: 'available', version: info && info.version }); });
    autoUpdater.on('update-not-available', function () { emit('update', { state: 'none' }); });
    autoUpdater.on('update-downloaded', function (info) { emit('update', { state: 'downloaded', version: info && info.version }); });
    autoUpdater.on('error', function (err) {
      /* offline/404 de release é normal: só registra sem detalhes sensíveis */
      if (IS_DEV) console.warn('[main] auto-update: ' + (err && err.code ? err.code : 'erro'));
    });
    const p = autoUpdater.checkForUpdates();
    if (p && typeof p.catch === 'function') p.catch(function () { /* offline: ignora */ });
  } catch (e) { /* qualquer erro de update é silencioso em produção */ }
}

/* ============================ smoke ============================ */

function smokeFinish(code, line) {
  if (S.smokeDone) return;
  S.smokeDone = true;
  if (S.smokeTimer) { clearTimeout(S.smokeTimer); S.smokeTimer = null; }
  if (line) {
    try { process.stdout.write(line + '\n'); } catch (e) { /* ignore */ }
  }
  setTimeout(function () {
    cleanup('smoke');
    app.exit(code);
  }, 200);
}

/* ============================ ciclo de vida ============================ */

function cleanup(reason) {
  try { if (S.net) S.net.stop(); } catch (e) { /* ignore */ }
  try { if (S.tray) S.tray.destroy(); } catch (e) { /* ignore */ }
  try {
    if (S.downloads && typeof S.downloads.dispose === 'function') S.downloads.dispose();
  } catch (e) { /* ignore */ }
  try { if (S.windowState) S.windowState.flush(); } catch (e) { /* ignore */ }
  try { if (S.ipc) S.ipc.dispose(); } catch (e) { /* ignore */ }
  try {
    if (S.server && typeof S.server.stop === 'function') S.server.stop();
  } catch (e) { /* ignore */ }
  if (IS_DEV && reason) console.log('[main] encerrando (' + reason + ')');
}

async function boot() {
  installSessionGuards();

  /* 1. Configuração atômica + pasta de downloads + porta persistida. */
  S.config = createConfig({ env: ENV });
  let initInfo = null;
  try {
    initInfo = S.config.ensureInitialized();
  } catch (e) {
    initInfo = { warnings: ['Falha ao inicializar a configuração.'] };
  }
  S.warnings = (initInfo && initInfo.warnings) || [];
  S.warnings.forEach(function (w) { console.error('[main] aviso: ' + w); });

  S.autostart = createAutostart({ config: S.config, app: app, env: ENV });
  S.windowState = createWindowState({ config: S.config, screen: screen });

  /* 2. Servidor interno ANTES da janela. */
  S.server = createServer({
    config: S.config,
    getRendererDir: rendererDir,
    version: app.getVersion(),
    env: ENV,
    emit: emit,
    onAuthChange: function () { /* sessão é gerenciada pelo renderer; nada a fazer no main */ },
    onPortFallback: function (info) {
      S.warnings.push('A porta ' + info.wanted + ' estava ocupada; usando ' + info.port + ' nesta execução.');
      console.error('[main] porta interna em fallback: ' + info.port);
      emit('network', { online: true, portFallback: true, port: info.port, wanted: info.wanted });
    },
    log: function (message) { console.error('[server] ' + message); }
  });
  S.serverInfo = await S.server.start();

  /* 3. IPC (só app/config/sessão/etc; canais DL_* são do downloads.js). */
  S.ipc = createIpc({
    config: S.config,
    autostart: S.autostart,
    server: S.server,
    getWindow: function () { return S.window; },
    version: app.getVersion()
  });

  /* 4. Downloads (módulo opcional; handshake combinado com o agente downloads). */
  initDownloadsModule();

  /* 5. Menu + janela. */
  buildApplicationMenu();
  await createMainWindow();

  /* 6. Bandeja (nunca em --smoke). */
  if (!IS_SMOKE) {
    S.tray = createTray({
      config: S.config,
      getWindow: function () { return S.window; },
      onOpen: showMainWindow,
      onDownloads: function () {
        showMainWindow();
        emit('tray', { action: 'downloads' });
      },
      onQuit: function () { app.quit(); },
      iconPaths: trayIconPaths()
    });
    const created = S.tray && S.tray.create ? S.tray.create() : null;
    if (!created) {
      console.error('[main] bandeja indisponível (ícone não encontrado) — o app segue normal');
    }
  }

  /* 7. Monitor de rede + auto-update. */
  if (!IS_SMOKE) {
    S.net = createNetStatus({
      apiOrigin: S.config.effectiveApiOrigin(),
      onChange: function (status) { emit('network', status); }
    });
    S.net.start();
  }
  setupAutoUpdate();

  /* 8. Timeout do smoke: falha explícita em 20 s (com diagnóstico no stderr). */
  if (IS_SMOKE) {
    S.smokeTimer = setTimeout(function () {
      try {
        const wc = S.window && !S.window.isDestroyed() ? S.window.webContents : null;
        console.error('[smoke] timeout url=' + (wc && !wc.isDestroyed() ? String(wc.getURL() || '') : '?') +
          ' loading=' + (wc && !wc.isDestroyed() ? wc.isLoading() : '?'));
      } catch (e) { /* ignore */ }
      smokeFinish(1, 'SPACE_SMOKE_TIMEOUT');
    }, 20000);
  }

  /* 9. Avisos de inicialização chegam ao renderer depois do primeiro load. */
  if (!IS_SMOKE && S.window) {
    S.window.webContents.once('did-finish-load', function () {
      S.warnings.forEach(function (w) { emit('update', { state: 'warning', message: w }); });
    });
  }

  if (IS_SMOKE) {
    let diag = {};
    try {
      const wc = S.window && S.window.webContents;
      diag = {
        server: S.serverInfo ? S.serverInfo.url : '',
        renderer: rendererDir(),
        rendererExists: existsFile(path.join(rendererDir(), 'index.html')),
        url: wc && !wc.isDestroyed() ? String(wc.getURL() || '') : '(sem webContents)',
        loading: wc && !wc.isDestroyed() ? wc.isLoading() : null
      };
    } catch (e) {
      diag = { error: String(e && e.message || e) };
    }
    console.error('[smoke] ' + JSON.stringify(diag));
  }
}

/* Instância única: a segunda execução só traz a janela para frente. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (!S.window) return;
    if (S.window.isMinimized()) { try { S.window.restore(); } catch (e) { /* ignore */ } }
    showMainWindow();
  });

  app.whenReady().then(function () {
    boot().catch(function (err) {
      console.error('[main] falha no boot: ' + (err && err.message ? String(err.message).slice(0, 300) : 'erro'));
      if (IS_SMOKE) {
        smokeFinish(1, 'SPACE_SMOKE_ERROR=boot');
      } else {
        dialog.showErrorBox('Space IPTV', 'Não foi possível iniciar o aplicativo. Feche e abra de novo.');
        app.quit();
      }
    });
  }).catch(function (err) {
    console.error('[main] whenReady falhou: ' + (err && err.message ? String(err.message).slice(0, 200) : 'erro'));
    app.exit(1);
  });

  app.on('before-quit', function () {
    S.quitting = true;
    try { if (S.windowState) S.windowState.flush(); } catch (e) { /* ignore */ }
  });

  app.on('will-quit', function () {
    S.quitting = true;
    cleanup('quit');
  });

  app.on('window-all-closed', function () {
    if (S.quitting) return;
    app.quit();
  });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (S.serverInfo) createMainWindow().catch(function () { /* ignore */ });
    } else {
      showMainWindow();
    }
  });
}
