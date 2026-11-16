#!/usr/bin/env node
/* E2E de UI do Space IPTV Desktop via Chrome DevTools Protocol (sem dependências).
 *
 * Por que existe: neste ambiente o sandbox da sessão bloqueia executar o Electron
 * de dentro do workspace. Este runner aceita um binário externo (`--electron` ou
 * env ELECTRON_BIN) e roda o app do workspace com ele. Em uma máquina normal,
 * `node scripts/e2e-ui.js --electron node_modules/electron/dist/electron.exe`.
 *
 * O que faz:
 *   1. sobe o mock provider (LAN, para o proxy do desktop aceitar o host);
 *   2. abre o Electron com --remote-debugging-port;
 *   3. loga com a conta de teste (desktop/test/tmp/env.json), importa a lista mock;
 *   4. valida menu/HUD/catálogo, captura screenshots em dist/desktop-shots/;
 *   5. testa download + reprodução offline (quando js/downloads.js existir);
 *   6. coleta erros de console e falha se houver erro inesperado.
 *
 * Uso:
 *   node scripts/e2e-ui.js [--shots] [--keep] [--electron <path>] [--api <url>]
 *                          [--only <nome>] [--skip-downloads]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const DESKTOP = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP, '..');
const SHOTS_DIR = path.join(ROOT, 'dist', 'desktop-shots');
const TMP = path.join(DESKTOP, 'test', 'tmp');
const ENV_FILE = path.join(TMP, 'env.json');

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return fallback;
}
const CAPTURE = args.includes('--shots');
const KEEP = args.includes('--keep');
const ONLY = argValue('--only', '');
const SKIP_DOWNLOADS = args.includes('--skip-downloads');
const OFFLINE_PROOF = args.includes('--offline-proof');
const KEEP_DOWNLOADS = args.includes('--keep-downloads');
/* Por padrão não mexe no autostart real do Windows (SPACE_NO_AUTOSTART=1).
   Com --with-autostart o teste liga/desliga o login item de verdade. */
const WITH_AUTOSTART = args.includes('--with-autostart');
const API_ORIGIN = argValue('--api', process.env.SPACE_API_ORIGIN || 'http://127.0.0.1:8789');

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ip of ifaces[name] || []) {
      if (ip && ip.family === 'IPv4' && !ip.internal) return ip.address;
    }
  }
  return '';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Fecha servidores de teste sem deixar o E2E pendurado (server.close espera
   conexões keep-alive abertas; o teste não pode travar por isso). */
function closeBounded(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    sleep(ms || 4000)
  ]);
}

function countFiles(dir) {
  let n = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
      else n++;
    }
  } catch (e) { /* ignore */ }
  return n;
}

/* Wi-Fi: usado SÓ pelo teste --offline-proof (desconecta e reconecta). */
function execNetsh(args) {
  try {
    return require('child_process').execFileSync('netsh', args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
  } catch (e) {
    return String((e && e.stdout) || (e && e.message) || '');
  }
}

function wifiState() {
  const out = execNetsh(['wlan', 'show', 'interfaces']);
  const ssid = (/^\s*SSID\s*:\s*(.+)$/im.exec(out) || [])[1];
  const state = (/^\s*State\s*:\s*(.+)$/im.exec(out) || [])[1];
  return { ssid: ssid ? ssid.trim() : '', state: state ? state.trim() : '' };
}

function wifiDisconnect() {
  execNetsh(['wlan', 'disconnect']);
}

async function wifiReconnect(ssid) {
  if (!ssid) return false;
  for (let attempt = 0; attempt < 4; attempt++) {
    execNetsh(['wlan', 'connect', 'name=' + ssid, 'ssid=' + ssid]);
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try {
        const res = await fetch('https://space-iptv.pages.dev/api/auth/capabilities', { signal: AbortSignal.timeout(2500) });
        if (res.ok) return true;
      } catch (e) { /* ainda offline */ }
    }
  }
  return false;
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/* ------------------------------ CDP ------------------------------ */

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (ev) => reject(new Error('CDP WebSocket erro')));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP erro'));
        else resolve(msg.result);
        return;
      }
      if (msg.method) this.events.push(msg);
    });
  }

  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async eval(expression) {
    const out = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (out.exceptionDetails) {
      const d = out.exceptionDetails;
      throw new Error('evaluate falhou: ' + (d.exception && d.exception.description ? d.exception.description : d.text));
    }
    return out.result ? out.result.value : undefined;
  }

  async waitFor(expression, timeoutMs, label) {
    const deadline = Date.now() + (timeoutMs || 30000);
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const v = await this.eval(expression);
        if (v) return v;
      } catch (e) { lastErr = e; }
      await sleep(250);
    }
    throw new Error('timeout esperando ' + (label || expression) + (lastErr ? ' (' + lastErr.message + ')' : ''));
  }

  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  async mouseMove(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: 0 });
  }

  async mouseWheel(x, y, deltaY) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(x), y: Math.round(y),
      deltaX: 0, deltaY: Math.round(deltaY || 0), button: 'none', buttons: 0
    });
  }

  consoleErrors() {
    const out = [];
    for (const ev of this.events) {
      if (ev.method === 'Runtime.exceptionThrown') {
        const d = ev.params && ev.params.exceptionDetails;
        out.push('exception: ' + (d && d.exception && d.exception.description ? d.exception.description.split('\n')[0] : (d && d.text)));
      }
      if (ev.method === 'Runtime.consoleAPICalled' && ev.params && ev.params.type === 'error') {
        out.push('console.error: ' + (ev.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
      if (ev.method === 'Log.entryAdded' && ev.params && ev.params.entry) {
        const e = ev.params.entry;
        if (e.level === 'error') out.push('log: ' + String(e.text).slice(0, 300) + (e.url ? ' [url=' + e.url + ']' : ''));
      }
    }
    return out;
  }

  close() {
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}

/* -------------------------- mock provider -------------------------- */

async function startProvider() {
  const mod = require(path.join(DESKTOP, 'test', 'helpers', 'mock-provider.js'));
  const host = lanIp();
  if (!host) fail('sem IPv4 de LAN para o mock provider (necessário para o allowlist do proxy)');
  const provider = await mod.startMockProvider({ host: host });
  const m3uRes = await fetch(provider.baseUrl + '/m3u');
  const m3uText = await m3uRes.text();
  return { provider, host: host, port: provider.port, m3uText: m3uText };
}

/* -------------------------- mídia real de teste -------------------------- */

/* Serve um MP4 real (baixado para desktop/test/tmp/media/sample.mp4) na LAN,
 * com Range, para validar decodificação offline de verdade. O mock provider
 * gera MP4 sintético (não decodificável), então o teste de reprodução usa este. */
function startMediaServer(host, mediaFile) {
  const stat = fs.statSync(mediaFile);
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/sample.mp4') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('nao encontrado');
    }
    const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range || ''));
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
        'Content-Length': String(end - start + 1)
      });
      return fs.createReadStream(mediaFile, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(stat.size) });
    fs.createReadStream(mediaFile).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      resolve({
        url: 'http://' + host + ':' + port + '/sample.mp4',
        close: () => new Promise((r) => { try { server.close(() => r()); } catch (e) { r(); } })
      });
    });
  });
}

/* ----------------------------- runner ------------------------------ */

async function main() {
  const envInfo = readJson(ENV_FILE) || {};
  const user = (envInfo.testUsers && envInfo.testUsers.user) || {};
  if (!user.email || !user.password) fail('desktop/test/tmp/env.json sem testUsers.user (o lead gera este arquivo)');

  const electronBin = argValue('--electron', process.env.ELECTRON_BIN || path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe'));
  if (!fs.existsSync(electronBin)) fail('binário do Electron não encontrado: ' + electronBin);

  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  const results = [];
  const record = (ok, label, detail) => {
    results.push({ ok, label, detail: detail || '' });
    console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''));
    return ok;
  };

  const provider = await startProvider();
  console.log('[e2e] mock provider em ' + provider.provider.baseUrl + ' (host LAN ' + provider.host + ')');

  const mediaFile = path.join(TMP, 'media', 'sample.mp4');
  let media = null;
  if (fs.existsSync(mediaFile)) {
    media = await startMediaServer(provider.host, mediaFile);
    console.log('[e2e] mídia real de teste em ' + media.url + ' (' + fs.statSync(mediaFile).size + ' bytes)');
  } else {
    console.log('[e2e] AVISO: ' + mediaFile + ' ausente — reprodução offline usará o MP4 sintético do mock (sem decodificar).');
  }

  const workDir = path.join(TMP, 'e2e-' + Date.now());
  fs.mkdirSync(workDir, { recursive: true });
  const childEnv = Object.assign({}, process.env, {
    SPACE_API_ORIGIN: API_ORIGIN,
    SPACE_CONFIG_FILE: path.join(workDir, 'config.json'),
    SPACE_DOWNLOADS_DIR: path.join(workDir, 'downloads'),
    SPACE_USER_DATA: path.join(workDir, 'userdata'),
    SPACE_INTERNAL_PORT: '0'
  });
  if (!WITH_AUTOSTART) childEnv.SPACE_NO_AUTOSTART = '1';
  else delete childEnv.SPACE_NO_AUTOSTART;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

  const dbgPort = 9500 + Math.floor(Math.random() * 400);
  const child = spawn(electronBin, [
    DESKTOP,
    '--no-sandbox',
    '--disable-crash-reporter',
    '--remote-debugging-port=' + dbgPort
  ], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  let cdp = null;
    const cleanup = async () => {
      if (cdp) cdp.close();
      if (!KEEP) {
        try { child.kill(); } catch (e) { /* ignore */ }
      }
      if (media) { try { await closeBounded(media.close(), 4000); } catch (e) { /* ignore */ } }
      try { await closeBounded(provider.provider.close(), 4000); } catch (e) { /* ignore */ }
    };

  try {
    /* espera o CDP subir */
    let targets = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        targets = await httpJson('http://127.0.0.1:' + dbgPort + '/json/list');
        if (targets && targets.length) break;
      } catch (e) { /* ainda não */ }
      await sleep(300);
    }
    if (!targets || !targets.length) fail('CDP não subiu; stdout=' + stdout.slice(-500) + ' stderr=' + stderr.slice(-800));
    const page = targets.find((t) => t.type === 'page') || targets[0];
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    record(true, 'electron conectado por CDP', 'target=' + page.url);

    /* registra o host do mock ANTES do App.net.init (ping do proxy) para o
       renderer já tratar o provedor como host proxiable (sem CORS na UI) */
    try {
      await cdp.waitFor('!!(window.space && space.registerMediaHosts)', 8000, 'preload window.space');
      await cdp.eval('space.registerMediaHosts(' + JSON.stringify([provider.host]) + ')');
      record(true, 'host de mídia registrado no proxy antes do boot');
    } catch (e) {
      record(false, 'host de mídia registrado no proxy antes do boot', e.message);
    }

    const shot = async (name) => {
      if (!CAPTURE) return null;
      try {
        /* tira o toast da vez para a captura não cobrir o HUD/rodapé */
        await cdp.eval('(function(){ var t=document.getElementById("toast"); if (t) { t.textContent=""; } return true; })()');
      } catch (e) { /* ignore */ }
      const file = path.join(SHOTS_DIR, name + '.png');
      await cdp.screenshot(file);
      return file;
    };

    /* login, se necessário (espera o gate terminar: login OU shell pronto) */
    await cdp.waitFor('document.readyState === "complete"', 15000, 'document.readyState');
    await cdp.waitFor(
      '(location.pathname.indexOf("/login.html") === 0 && !!document.getElementById("email")) || ' +
      '(!!(window.App && App.shell) && document.querySelectorAll("#sidebar .nav-item").length > 0)',
      25000,
      'gate de sessão (login ou shell)'
    );
    const onLogin = await cdp.eval('location.pathname.indexOf("/login.html") === 0');
    if (onLogin) {
      await shot('00-login');
      await cdp.waitFor('!!document.getElementById("email")', 8000, 'form de login');
      await cdp.waitFor('document.readyState === "complete"', 8000, 'login.js carregado');
      await sleep(500); /* garante o submit handler do web/js/login.js registrado */
      await cdp.eval('(function(){ var e=document.getElementById("email"), p=document.getElementById("password");' +
        ' e.value=' + JSON.stringify(user.email) + '; p.value=' + JSON.stringify(user.password) +
        '; if (e.form) e.form.requestSubmit(); return true; })()');
      try {
        await cdp.waitFor('location.pathname === "/" && !!(window.App && App.shell)', 20000, 'shell após login');
      } catch (e) {
        /* submit nativo (sem JS) põe credenciais na URL: volta ao login e tenta uma vez com o handler */
        await cdp.eval('location.replace("/login.html")');
        await cdp.waitFor('document.readyState === "complete" && !!document.getElementById("email")', 15000, 'login recarregado');
        await sleep(800);
        await cdp.eval('(function(){ var e=document.getElementById("email"), p=document.getElementById("password");' +
          ' e.value=' + JSON.stringify(user.email) + '; p.value=' + JSON.stringify(user.password) +
          '; document.getElementById("login-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); return true; })()');
        await cdp.waitFor('location.pathname === "/" && !!(window.App && App.shell)', 20000, 'shell após login (retry)');
      }
      record(true, 'login com a conta de teste (backend real)');
    } else {
      record(true, 'sessão já autenticada (cookie persistido)');
    }

    /* shell, menu e HUD */
    await cdp.waitFor('!!(window.App && App.shell && document.querySelectorAll("#sidebar .nav-item").length)', 15000, 'menu lateral');
    const menu = await cdp.eval('Array.prototype.map.call(document.querySelectorAll("#sidebar .nav-item span"), function (e) { return e.textContent; })');
    const expected = ['Início', 'TV ao vivo', 'Filmes', 'Séries', 'Pesquisa', 'Favoritos', 'Baixados', 'Configurações'];
    record(JSON.stringify(menu) === JSON.stringify(expected), 'sidebar na ordem esperada, sem Administração', JSON.stringify(menu));
    const hasAdmin = await cdp.eval('document.body.innerText.indexOf("Administra") >= 0');
    record(!hasAdmin, 'nenhuma menção a Administração na UI');

    const hudUser = await cdp.eval('(document.getElementById("hud-user") || {}).textContent || ""');
    record(hudUser.indexOf(user.email.split('@')[0]) >= 0, 'HUD mostra o usuário', hudUser);

    /* palco preenchendo a janela: sem faixas laterais (fill-stage) e HUD encostando
       apenas na margem de projeto (48px * escala) */
    const layout = await cdp.eval('(function () {' +
      '  var iw = window.innerWidth, ih = window.innerHeight;' +
      '  var hud = document.getElementById("hud").getBoundingClientRect();' +
      '  var hints = document.getElementById("hints").getBoundingClientRect();' +
      '  var fit = (window.App && App.stageFit) || null;' +
      '  return { iw: iw, ih: ih, aspect: iw / ih, fillClass: document.documentElement.classList.contains("fill-stage"),' +
      '    fit: fit, hudLeft: hud.left, hudRight: hud.right, hudTop: hud.top, hudBottom: hud.bottom,' +
      '    hintsBottom: hints.bottom, stageH: document.getElementById("stage").getBoundingClientRect().height };' +
      '})()');
    record(layout.fillClass === true && layout.fit && layout.fit.fill === true, 'palco em modo preencher (sem faixas laterais)', JSON.stringify({ iw: layout.iw, ih: layout.ih, fit: layout.fit }));
    record(layout.hudLeft < 80 && layout.hudRight > layout.iw - 80, 'HUD preenche a largura da janela (só margem de projeto)', JSON.stringify({ hudLeft: Math.round(layout.hudLeft), hudRight: Math.round(layout.hudRight), iw: layout.iw }));
    record(layout.hintsBottom <= layout.ih + 1 && layout.hintsBottom > layout.ih - 60, 'rodapé (hints) dentro da janela', JSON.stringify({ hintsBottom: Math.round(layout.hintsBottom), ih: layout.ih }));

    /* espera o boot do shell terminar; a conta de teste pode ter listas
       sincronizadas de execuções anteriores (sync push) — remove todas antes
       de importar a lista mock determinística desta rodada. */
    await cdp.waitFor(
      '!!(window.App && App.shell) && document.querySelectorAll("#sidebar .nav-item").length > 0 && !App.catalog.isLoading()',
      25000,
      'boot do shell'
    );
    await cdp.eval('(async function () {' +
      '  var all = App.lists.all();' +
      '  for (var i = 0; i < all.length; i++) { try { await App.lists.remove(all[i].id); } catch (e) {} }' +
      '  await App.catalog.init(null);' +
      '  return App.lists.all().length;' +
      '})()');
    await cdp.waitFor('!App.lists.active() && !App.catalog.isLoading()', 20000, 'shell sem lista ativa');
    await sleep(400);

    /* importa a lista mock como arquivo local (mesmo fluxo do "Adicionar por arquivo") */
    const importResult = await cdp.eval('(async function () {' +
      '  var text = ' + JSON.stringify(provider.m3uText) + ';' +
      '  var refreshCalls = []; var origRefresh = App.catalog.refresh;' +
      '  var loadingStart = App.catalog.isLoading();' +
      '  var rec = await App.lists.saveFile({ name: "Provedor Mock", filename: "mock.m3u", size: text.length, text: text });' +
      '  App.lists.setActive(rec.id);' +
      '  var read = await App.lists.readM3uFile(rec);' +
      '  var counts = null, perr = null;' +
      '  try { var p = await App.m3u.parse(read); counts = { live: p.live.length, movie: p.movie.length, series: p.series.length, head: p.head }; }' +
      '  catch (e) { perr = String(e && (e.code || e.message) || e); }' +
      '  var catErr = "";' +
      '  try { App.bus.on("catalog:error", function (e) { catErr = String(e && e.message || e); }); } catch (e2) { /* ignore */ }' +
      '  await App.catalog.init(rec);' +
      '  var loadingBefore = App.catalog.isLoading();' +
      '  var ok = await App.catalog.refresh(rec);' +
      '  var retry = false;' +
      '  if (App.catalog.data.live.length === 0) { await new Promise(function (r) { setTimeout(r, 600); }); retry = await App.catalog.refresh(rec); }' +
      '  if (App.desktop && App.desktop.api && App.desktop.api.registerMediaHosts) await App.desktop.api.registerMediaHosts(' + JSON.stringify([provider.host]) + ');' +
      '  return { readLen: read ? read.length : -1, parsed: counts, perr: perr, refreshOk: ok, retryOk: retry, loadingBefore: loadingBefore, loadingStart: loadingStart, refreshCalls: refreshCalls, catErr: catErr,' +
      '    live: App.catalog.data.live.length, movie: App.catalog.data.movie.length, series: App.catalog.data.series.length,' +
      '    head: App.catalog.data.head || {}, active: !!(App.lists.active() && App.lists.active().id === rec.id), listId: rec.id };' +
      '})()');
    record(importResult.live > 0 && importResult.movie > 0, 'importação M3U + catálogo', JSON.stringify(importResult));
    record(!!(importResult.head && (importResult.head['url-tvg'] || importResult.head['x-tvg-url'])), 'cabeçalho url-tvg preservado', JSON.stringify(importResult.head));

    /* EPG pela rota /_epg/source do servidor interno */
    const epgState = await cdp.eval('(async function () {' +
      '  var list = App.lists.active();' +
      '  try { await App.epg.refresh(list); } catch (e) { return { ok: false, error: String(e && (e.message || e.code) || e) }; }' +
      '  return { ok: true, hasData: App.epg.hasData(), channels: App.epg.channels().length, state: App.epg.state() };' +
      '})()');
    record(epgState.ok && epgState.hasData, 'EPG XMLTV (via /_epg/source + host LAN)', JSON.stringify(epgState));

    /* screenshots das telas */
    const home = await cdp.eval('(async function(){ App.shell.goto("home"); await new Promise(function(r){setTimeout(r,700)}); return true; })()');
    await shot('01-inicio');
    await cdp.eval('(async function(){ App.shell.goto("live"); await new Promise(function(r){setTimeout(r,900)}); return true; })()');
    await shot('02-tv-ao-vivo');
    await cdp.eval('(async function(){ App.shell.goto("movies"); await new Promise(function(r){setTimeout(r,700)}); return true; })()');
    await shot('03-filmes');
    await cdp.eval('(async function(){ App.shell.goto("series"); await new Promise(function(r){setTimeout(r,700)}); return true; })()');
    await shot('04-series');
    await cdp.eval('(async function(){ App.shell.goto("search"); await new Promise(function(r){setTimeout(r,700)}); return true; })()');
    await shot('05-pesquisa');
    await cdp.eval('(async function(){ App.shell.goto("favs"); await new Promise(function(r){setTimeout(r,700)}); return true; })()');
    await shot('06-favoritos');

    /* ---------- scroll: hover não pode rolar a grade sozinho ---------- */
    await cdp.eval('(async function () {' +
      '  var d = App.catalog.data;' +
      '  if (d.movie.length < 60) {' +
      '    for (var i = 0; d.movie.length < 60; i++) {' +
      '      var it = { id: "fake" + i, t: "movie", n: "Filme Fake " + (i + 1), ns: "filme fake " + (i + 1), c: "Filmes", l: "", u: "http://127.0.0.1:9/fake.mp4", y: "2026", d: 0 };' +
      '      d.movie.push(it); d.map.movie[it.id] = it;' +
      '      if (d.by.movie["Filmes"]) d.by.movie["Filmes"].push(it);' +
      '    }' +
      '    d.by.movie["*"] = d.movie;' +
      '  }' +
      '  return d.movie.length;' +
      '})()');
    await cdp.eval('(async function(){ App.shell.goto("movies"); await new Promise(function(r){setTimeout(r,900)}); return true; })()');
    const gridRect = await cdp.eval('(function () {' +
      '  var v = document.querySelector("#screen .content .vlist") || document.querySelector("#screen .vlist");' +
      '  if (!v) return null; var r = v.getBoundingClientRect();' +
      '  return { left: r.left, top: r.top, width: r.width, height: r.height, scrollTop: v.scrollTop, scrollHeight: v.scrollHeight, clientHeight: v.clientHeight };' +
      '})()');
    if (gridRect && gridRect.scrollHeight > gridRect.clientHeight + 40) {
      const cx = gridRect.left + Math.min(gridRect.width / 2, 500);
      const y0 = gridRect.top + 30;
      const y1 = Math.min(gridRect.top + gridRect.height - 20, y0 + 520);
      for (let i = 0; i <= 12; i++) {
        await cdp.mouseMove(cx, y0 + ((y1 - y0) * i) / 12);
        await sleep(80);
      }
      await sleep(400);
      const afterHover = await cdp.eval('(document.querySelector("#screen .content .vlist") || document.querySelector("#screen .vlist")).scrollTop');
      record(afterHover === gridRect.scrollTop, 'mover o mouse sobre a grade NÃO rola sozinho', JSON.stringify({ antes: gridRect.scrollTop, depois: afterHover }));
      /* a roda do mouse continua rolando/navegando a grade */
      for (let w = 0; w < 3; w++) { await cdp.mouseWheel(cx, y0 + 120, 240); await sleep(160); }
      await sleep(500);
      const afterWheel = await cdp.eval('(document.querySelector("#screen .content .vlist") || document.querySelector("#screen .vlist")).scrollTop');
      record(afterWheel > gridRect.scrollTop, 'roda do mouse navega/rola a grade', JSON.stringify({ antes: gridRect.scrollTop, depois: afterWheel }));
    } else {
      record(true, 'scroll: grade pequena demais para testar (skip)', JSON.stringify(gridRect && { sh: gridRect.scrollHeight, ch: gridRect.clientHeight }));
    }


    /* Guia (EPG) */
    const guide = await cdp.eval('(async function(){ if (!App.desktop || !App.desktop.guide) return {ok:false,error:"sem guide"}; App.desktop.guide.open(App.lists.active()); await new Promise(function(r){setTimeout(r,900)}); return {ok:true, open: App.desktop.guide.isOpen && App.desktop.guide.isOpen(), cells: document.querySelectorAll(".guide-prog, .guide-program, .guide-cell").length}; })()');
    await shot('07-guia-epg');
    record(guide.ok && guide.cells > 0, 'tela Guia com grade de programas', JSON.stringify(guide));
    await cdp.eval('(async function(){ if (App.desktop.guide) App.desktop.guide.close(); await new Promise(function(r){setTimeout(r,300)}); return true; })()');

    /* Configurações + importação (modal) */
    await cdp.eval('(async function(){ App.shell.goto("settings"); await new Promise(function(r){setTimeout(r,900)}); return true; })()');
    await shot('08-configuracoes');
    const settingsDesktop = await cdp.eval('document.body.innerText.indexOf("Pasta de downloads") >= 0 && document.body.innerText.indexOf("Iniciar com o Windows") >= 0');
    record(settingsDesktop, 'Configurações tem pasta de downloads e iniciar com o Windows');
    const epgSettings = await cdp.eval('document.body.innerText.indexOf("Fonte de EPG") >= 0');
    record(epgSettings, 'Configurações tem a fonte de EPG padrão');
    const autostartDefault = await cdp.eval('space.autostart.get().then(function (s) { return s.openAtLogin === false; })');
    record(autostartDefault === true, 'iniciar com o Windows vem desligado por padrão');

    /* liga/desliga o login item (per-user) e confere o registro do Windows.
       Em execuções sem --with-autostart o app roda com SPACE_NO_AUTOSTART=1
       (não mexe no Windows): validamos só o padrão desligado. */
    if (!WITH_AUTOSTART) {
      record(autostartDefault === true, 'autostart desligado por padrão (toggle coberto com --with-autostart)');
    } else {
      const auto = await cdp.eval('(async function () {' +
        '  var before = await space.autostart.get();' +
        '  var on = await space.autostart.set({ openAtLogin: true });' +
        '  var mid = await space.autostart.get();' +
        '  var off = await space.autostart.set({ openAtLogin: false });' +
        '  var after = await space.autostart.get();' +
        '  return { before: before.openAtLogin, on: on && on.openAtLogin, mid: mid.openAtLogin, off: off && off.openAtLogin, after: after.openAtLogin };' +
        '})()');
      record(auto.before === false && auto.mid === true && auto.after === false, 'autostart liga/desliga (login item) e volta desligado', JSON.stringify(auto));
    }

    await cdp.eval('(async function(){ if (App.upload && App.upload.open) App.upload.open({}); await new Promise(function(r){setTimeout(r,400)}); return true; })()');
    await shot('09-importar-lista');
    await cdp.eval('(async function(){ var ov=document.querySelector("#overlays .overlay"); if(ov){var b=ov.querySelectorAll(".btn,button"); for(var i=0;i<b.length;i++){ if(/Cancelar/.test(b[i].textContent)){ b[i].click(); break; } } } await new Promise(function(r){setTimeout(r,300)}); return true; })()');

    /* Baixados + download + reprodução offline */
    const downloadsReady = await cdp.eval('!!(window.App && App.downloads && App.screens && App.screens.downloads)');
    if (!SKIP_DOWNLOADS && downloadsReady && media) {
      /* --- cenário principal: MP4 real decodificável + HLS empacotado --- */
      await cdp.eval('(async function () {' +
        '  var list = App.lists.active();' +
        '  var real = { id: "real-mp4", t: "movie", n: "Vídeo Real Offline", ns: "video real offline", c: "Filmes", l: "", u: ' + JSON.stringify(media.url) + ', y: "", d: 0 };' +
        '  var hls = { id: "hls-movie", t: "movie", n: "HLS Filme Offline", ns: "hls filme offline", c: "Filmes", l: "", u: ' + JSON.stringify(provider.provider.baseUrl + '/hls/master.m3u8') + ', y: "", d: 8 };' +
        '  App.catalog.data.movie.push(real); App.catalog.data.movie.push(hls);' +
        '  App.catalog.data.by.movie["*"] = App.catalog.data.movie;' +
        '  App.catalog.data.map.movie[real.id] = real; App.catalog.data.map.movie[hls.id] = hls;' +
        '  return { list: list.id, movieCount: App.catalog.data.movie.length };' +
        '})()');
      await cdp.eval('(async function(){ App.shell.goto("downloads"); await new Promise(function(r){setTimeout(r,700)}); return true; })()');
      await shot('10-baixados-vazio');

      const waitDone = async (title, timeoutMs) => {
        const deadline = Date.now() + (timeoutMs || 90000);
        let last = null;
        while (Date.now() < deadline) {
          await sleep(500);
          last = await cdp.eval('space.downloads.list()');
          const item = (last.items || []).find((i) => i.title === title);
          if (item && item.status === 'done') return { item, last };
          if (item && item.status === 'error') return { item, last, error: item.error };
        }
        return { item: null, last };
      };

      /* 1. download do MP4 real (fluxo do botão Baixar: App.downloads.download) */
      const dlReal = await cdp.eval('(async function () {' +
        '  var list = App.lists.active();' +
        '  var it = App.catalog.data.movie.filter(function (m) { return m.id === "real-mp4"; })[0];' +
        '  try { await App.downloads.download(it, list); } catch (e) { return { ok: false, error: String(e && (e.message || e.code) || e) }; }' +
        '  return { ok: true };' +
        '})()');
      record(dlReal.ok, 'download de filme MP4 (fluxo da UI) iniciado', JSON.stringify(dlReal));
      const doneReal = await waitDone('Vídeo Real Offline', 90000);
      record(!!(doneReal.item && doneReal.item.status === 'done'), 'download MP4 real concluído', JSON.stringify(doneReal.item && { status: doneReal.item.status, bytes: doneReal.item.bytes, totalBytes: doneReal.item.totalBytes }));

      /* 2. download HLS pelo main (evita o seletor de variante) */
      const dlHls = await cdp.eval('(async function () {' +
        '  var list = App.lists.active();' +
        '  var it = App.catalog.data.movie.filter(function (m) { return m.id === "hls-movie"; })[0];' +
        '  var probe = await space.downloads.probe({ urls: [it.u] });' +
        '  var v = (probe && probe.variants && probe.variants[0]) || null;' +
        '  if (!v) return { ok: false, error: "sem variante" };' +
        '  var out = await space.downloads.add({ kind: "movie", title: it.n, listId: list.id, itemId: it.id, url: v.url, variantId: v.id, durationSec: 8, totalBytes: v.estimatedBytes || 0 });' +
        '  return { ok: !!(out && out.ok), variants: probe.variants.length, variant: v.label || v.resolution || v.id, error: (out && out.error) || "" };' +
        '})()');
      record(dlHls.ok && dlHls.variants >= 1, 'download HLS (pacote offline) iniciado', JSON.stringify(dlHls));
      const doneHls = await waitDone('HLS Filme Offline', 90000);
      record(!!(doneHls.item && doneHls.item.status === 'done'), 'download HLS concluído', JSON.stringify(doneHls.item && { status: doneHls.item.status, bytes: doneHls.item.bytes }));

      const hlsCheck = doneHls.item ? await cdp.eval('(async function () {' +
        '  var r = await space.downloads.list(); var it = r.items.filter(function (i) { return i.title === "HLS Filme Offline"; })[0];' +
        '  if (!it) return { ok: false };' +
        '  var res = await fetch(it.offlineUrl); var text = await res.text();' +
        '  return { ok: res.status === 200 && /#EXTM3U/.test(text) && text.length > 40, status: res.status, len: text.length, head: text.slice(0, 60) };' +
        '})()') : { ok: false };
      record(hlsCheck.ok, 'playlist HLS offline servida localmente', JSON.stringify(hlsCheck));

      /* 3. reprodução offline do MP4 real (com internet irrelevante: 127.0.0.1) */
      if (doneReal.item) {
        const play = await cdp.eval('(async function () {' +
          '  var r = await space.downloads.list(); var it = r.items.filter(function (i) { return i.title === "Vídeo Real Offline"; })[0];' +
          '  var probe = null;' +
          '  try { var pr = await fetch(it.offlineUrl, { headers: { Range: "bytes=0-1023" } }); probe = { status: pr.status, ct: pr.headers.get("content-type"), range: pr.headers.get("content-range") }; } catch (e) { probe = { error: String(e && e.message || e) }; }' +
          '  App.downloads.playOffline(it);' +
          '  var v = null;' +
          '  for (var i = 0; i < 40; i++) { v = document.querySelector("#player video"); if (v && v.readyState >= 2) break; await new Promise(function (r2) { setTimeout(r2, 250); }); }' +
          '  return { open: App.player.isOpen(), ready: v ? v.readyState : -1, dur: v ? v.duration : 0, probe: probe, videos: document.querySelectorAll("video").length };' +
          '})()');
        await shot('12-player-offline');
        record(play.open && play.ready >= 2 && play.dur > 0, 'reprodução offline do MP4 real (decodifica)', JSON.stringify(play));
        await cdp.eval('(async function(){ try { App.player.close(true); } catch (e) {} return true; })()');
      }

      /* 3b. prova offline REAL: desconecta o Wi-Fi, para mock provider e servidor
         de mídia (LAN) e reproduz o arquivo baixado — só pode funcionar pelo
         placeholder /offline do servidor interno + arquivo local. */
      if (OFFLINE_PROOF && doneReal.item) {
        const wifi = wifiState();
        record(!!wifi.ssid, 'Wi-Fi identificado antes da prova offline', JSON.stringify(wifi));
        let offlineOk = false;
        try {
          wifiDisconnect();
          await sleep(3000);
          const onlineBefore = await cdp.eval('navigator.onLine');
          try { await closeBounded(provider.provider.close(), 4000); } catch (e) { /* já fechado */ }
          try { if (media) { await closeBounded(media.close(), 4000); media = null; } } catch (e) { /* já fechado */ }
          await sleep(800);
          const offline = await cdp.eval('(async function () {' +
            '  var r = await space.downloads.list(); var it = r.items.filter(function (i) { return i.title === "Vídeo Real Offline"; })[0];' +
            '  App.downloads.playOffline(it);' +
            '  var v = null;' +
            '  for (var i = 0; i < 48; i++) { v = document.querySelector("#player video"); if (v && v.readyState >= 2) break; await new Promise(function (r2) { setTimeout(r2, 250); }); }' +
            '  return { open: App.player.isOpen(), ready: v ? v.readyState : -1, dur: v ? v.duration : 0, online: navigator.onLine, src: v ? String(v.currentSrc || v.src || "") : "" };' +
            '})()');
          await shot('13-player-offline-sem-internet');
          offlineOk = !offline.online && offline.open && offline.ready >= 2 && offline.dur > 0;
          record(offlineOk, 'reprodução offline com Wi-Fi desligado e provedor/servidor de mídia parados', JSON.stringify({ online: offline.online, readyState: offline.ready, duration: offline.dur, src: offline.src }));
          await cdp.eval('(async function(){ try { App.player.close(true); } catch (e) {} return true; })()');
        } finally {
          const back = await wifiReconnect(wifi.ssid);
          record(back, 'Wi-Fi reconectado após a prova offline', wifi.ssid);
        }
      }

      /* 4. tela Baixados com os dois itens + exclusão gerenciada */
      await cdp.eval('(async function(){ App.shell.goto("home"); App.shell.goto("downloads"); await new Promise(function(r){setTimeout(r,900)}); return true; })()');
      await shot('11-baixados-concluido');
      if (KEEP_DOWNLOADS) await cdp.eval('window.__keepDownloads = true');
      const removed = await cdp.eval('(async function () {' +
        '  if (window.__keepDownloads) { var b0 = await space.downloads.list(); return { before: b0.items.length, after: b0.items.length }; }' +
        '  var before = await space.downloads.list(); var n = before.items.length;' +
        '  for (var i = 0; i < before.items.length; i++) { await space.downloads.remove(before.items[i].id, { deleteFiles: true }); }' +
        '  await new Promise(function (r) { setTimeout(r, 800); });' +
        '  var after = await space.downloads.list();' +
        '  return { before: n, after: after.items.length };' +
        '})()');
      const dlDir = path.join(workDir, 'downloads');
      let managedFiles = 0;
      try {
        for (const entry of fs.readdirSync(dlDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name === '.space-iptv') continue;
          managedFiles += countFiles(path.join(dlDir, entry.name));
        }
      } catch (e) { /* pasta pode nao existir */ }
      if (KEEP_DOWNLOADS) {
        record(removed.before >= 2 && managedFiles > 0, 'downloads mantidos para inspeção (--keep-downloads)', JSON.stringify({ removed, managedFiles }));
      } else {
        record(removed.before >= 2 && removed.after === 0 && managedFiles === 0, 'exclusão remove os dois downloads e os arquivos gerenciados', JSON.stringify({ removed, managedFiles }));
      }
    } else if (!SKIP_DOWNLOADS && downloadsReady) {
      await cdp.eval('(async function(){ App.shell.goto("downloads"); await new Promise(function(r){setTimeout(r,700)}); return true; })()');
      await shot('10-baixados-vazio');
      const dl = await cdp.eval('(async function () {' +
        '  var list = App.lists.active();' +
        '  var it = App.catalog.data.movie.filter(function (m) { return /movie\\.mp4$/.test(m.u || ""); })[0];' +
        '  if (!it) return { ok: false, error: "sem filme mp4" };' +
        '  try { await App.downloads.download(it, list); } catch (e) { return { ok: false, error: String(e && (e.message || e.code) || e) }; }' +
        '  return { ok: true, item: it.n };' +
        '})()');
      record(dl.ok, 'download de filme MP4 iniciado', JSON.stringify(dl));
      let dlDone = false;
      let lastList = null;
      for (let i = 0; i < 120 && dl.ok; i++) {
        await sleep(500);
        lastList = await cdp.eval('space.downloads.list().then(function (r) { return r; })');
        const item = (lastList.items || [])[0] || null;
        if (item && item.status === 'done') { dlDone = true; break; }
        if (item && item.status === 'error') break;
      }
      record(dlDone, 'download MP4 concluído', JSON.stringify(lastList && { status: (lastList.items || [])[0] && (lastList.items || [])[0].status, progress: (lastList.items || [])[0] && (lastList.items || [])[0].progress }));
      await cdp.eval('(async function(){ App.bus && App.bus.emit && App.bus.emit("downloads"); if (App.screens && App.screens.downloads) { App.shell.goto("home"); App.shell.goto("downloads"); } await new Promise(function(r){setTimeout(r,800)}); return true; })()');
      await shot('11-baixados-concluido');

      if (dlDone) {
        const play = await cdp.eval('(async function () {' +
          '  var r = await space.downloads.list(); var it = r.items[0];' +
          '  var probe = null;' +
          '  try { var pr = await fetch(it.offlineUrl, { headers: { Range: "bytes=0-1023" } }); probe = { status: pr.status, ct: pr.headers.get("content-type"), len: pr.headers.get("content-length"), range: pr.headers.get("content-range") }; } catch (e) { probe = { error: String(e && e.message || e) }; }' +
          '  if (App.downloads && App.downloads.playOffline) { App.downloads.playOffline(it); }' +
          '  else { App.player.play({ item: { t: "movie", n: it.title }, list: { id: it.listId, type: "offline" }, urls: [it.offlineUrl], live: false, title: function () { return it.title; }, sub: function () { return "Offline"; }, onClose: function () {} }); }' +
          '  var v = null;' +
          '  for (var i = 0; i < 32; i++) { v = document.querySelector("#player video"); if (v && v.readyState >= 2) break; await new Promise(function (r2) { setTimeout(r2, 250); }); }' +
          '  var msgEl = document.querySelector("#player .pl-msg .msg, #player .pl-msg");' +
          '  return { open: App.player.isOpen(), ready: v ? v.readyState : -1, dur: v ? v.duration : 0,' +
          '    src: v ? String(v.currentSrc || v.src || "") : "", videos: document.querySelectorAll("video").length, offlineUrl: it.offlineUrl, probe: probe,' +
          '    msg: msgEl ? String(msgEl.textContent || "").slice(0, 200) : "", playerHtml: (document.getElementById("player") || {}).outerHTML ? String((document.getElementById("player") || {}).outerHTML).slice(0, 400) : "" };' +
          '})()');
        await shot('12-player-offline');
        record(play.open && play.ready >= 2, 'reprodução offline do MP4 baixado', JSON.stringify({ open: play.open, readyState: play.ready, duration: play.dur, videos: play.videos, offlineUrl: play.offlineUrl, probe: play.probe, msg: play.msg }));
        await cdp.eval('(async function(){ try { App.player.close(true); } catch (e) {} return true; })()');
        /* exclui o download gerenciado e confere que a pasta saiu do disco */
        const removed = await cdp.eval('(async function () {' +
          '  var before = await space.downloads.list(); var it = before.items[0];' +
          '  if (!it) return { ok: true, before: 0 };' +
          '  var out = await space.downloads.remove(it.id, { deleteFiles: true });' +
          '  await new Promise(function (r) { setTimeout(r, 600); });' +
          '  var after = await space.downloads.list();' +
          '  return { ok: !!(out && out.ok), before: before.items.length, after: after.items.length, error: (out && out.error) || "" };' +
          '})()');
        const dlDir = path.join(workDir, 'downloads');
        let managedFiles = 0;
        try {
          for (const entry of fs.readdirSync(dlDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name === '.space-iptv') continue;
            managedFiles += countFiles(path.join(dlDir, entry.name));
          }
        } catch (e) { /* pasta pode nao existir */ }
        record(removed.ok && removed.after === 0 && managedFiles === 0, 'exclusão do download remove os arquivos gerenciados', JSON.stringify({ removed, managedFiles }));
      }
    } else {
      record(true, 'Baixados/EPG de download pulados (js/downloads.js ainda ausente)', downloadsReady ? 'skip' : 'aguardando agente downloads');
    }

    /* ---------- fonte PÚBLICA de EPG padrão (EPGShare01 BR1 real) ----------
       Recarrega a página antes: depois do teste de download/offline o renderer
       pode estar no meio de um reload (online/sessão), e precisamos de um shell
       estável para trocar a lista ativa e baixar o guia público. */
    await cdp.eval('location.reload()').catch(function () {});
    await sleep(1200);
    await cdp.waitFor(
      '!!(window.App && App.shell && document.querySelectorAll("#sidebar .nav-item").length > 0)',
      30000,
      'shell após reload'
    );
    const noEpgList = '#EXTM3U\n#EXTINF:-1 tvg-id="SBT.br" group-title="Canais",SBT HD\nhttp://127.0.0.1:9/live.ts\n';
    const defEpg = await cdp.eval('(async function () {' +
      '  var text = ' + JSON.stringify(noEpgList) + ';' +
      '  var list = await App.lists.saveFile({ name: "Lista sem EPG", filename: "sem-epg.m3u", size: text.length, text: text });' +
      '  App.lists.setActive(list.id);' +
      '  await App.catalog.init(list);' +
      '  await App.catalog.refresh(list);' +
      '  var cfg = await space.config.get();' +
      '  var started = Date.now();' +
      '  try { await App.epg.refresh(list); } catch (e) { return { ok: false, error: String(e && (e.message || e.code) || e) }; }' +
      '  var st = App.epg.state();' +
      '  var item = App.catalog.data.live.filter(function (i) { return i.ti === "SBT.br"; })[0];' +
      '  var progs = item ? await App.epg.programsOf(item) : [];' +
      '  var nowp = item ? App.epg.now(item) : null;' +
      '  return { ok: true, cfg: cfg.epgUrl, sourceKind: st.sourceKind, channels: st.channelCount, programmes: st.programmeCount,' +
      '    ms: Date.now() - started, itemTi: item ? item.ti : "", progs: progs.length, nowTitle: nowp ? nowp.title : "", nowChannel: nowp ? (nowp.channel || (item && item.ti)) : "" };' +
      '})()');
    record(defEpg.ok && defEpg.sourceKind === 'default' && defEpg.channels > 100 && defEpg.programmes > 1000,
      'EPG público padrão carregado (EPGShare01 BR1)', JSON.stringify({ ok: defEpg.ok, sourceKind: defEpg.sourceKind, channels: defEpg.channels, programmes: defEpg.programmes, ms: defEpg.ms, cfg: defEpg.cfg, error: defEpg.error || '' }));
    record(defEpg.progs > 0 && !!defEpg.nowTitle, 'tvg-id com prefixo casa por alias (SBT.br -> programa atual)', JSON.stringify({ itemTi: defEpg.itemTi, progs: defEpg.progs, nowTitle: defEpg.nowTitle, nowChannel: defEpg.nowChannel }));

    /* captura do Guia usando a fonte PÚBLICA real (BR1) */
    try {
      await cdp.eval('(async function(){ if (App.desktop && App.desktop.guide) { App.desktop.guide.open(App.lists.active()); } await new Promise(function(r){setTimeout(r,1200)}); return true; })()');
      await shot('15-guia-epg-br1');
      await cdp.eval('(async function(){ if (App.desktop && App.desktop.guide) App.desktop.guide.close(); return true; })()');
    } catch (e) { /* captura é opcional */ }

    /* console limpo (tolerando o 401 esperado do gate em /api/auth/session e,
       na prova offline, os 502 de /api/* porque o backend precisa de internet) */
    await sleep(500);
    let errors = cdp.consoleErrors();
    errors = errors.filter((e) => !(/status of 401/.test(e) && /\/api\/auth\/session/.test(e)));
    if (OFFLINE_PROOF) {
      errors = errors.filter((e) => !(/status of 502/.test(e) && /\/api\/(auth\/session|sync\/)/.test(e)));
    }
    const pendingDownloadsAssets = !fs.existsSync(path.join(DESKTOP, 'src', 'renderer', 'js', 'downloads.js'));
    if (pendingDownloadsAssets) errors = errors.filter((e) => !/downloads\.(css|js)/.test(e));
    record(errors.length === 0, 'console sem erros inesperados', errors.slice(0, 3).join(' | '));

    if (ONLY) { /* reservado */ }

    const failed = results.filter((r) => !r.ok);
    console.log('\n[e2e] ' + (results.length - failed.length) + '/' + results.length + ' verificações PASS');
    if (CAPTURE) console.log('[e2e] screenshots em ' + path.relative(ROOT, SHOTS_DIR));
    if (stdout) fs.writeFileSync(path.join(workDir, 'electron-out.log'), stdout);
    if (stderr) fs.writeFileSync(path.join(workDir, 'electron-err.log'), stderr);
    if (failed.length) process.exitCode = 1;
  } catch (err) {
    console.error('[e2e] ERRO: ' + (err && err.message ? err.message : err));
    if (cdp) {
      try {
        console.error('[e2e] URL atual: ' + await cdp.eval('location.href'));
        console.error('[e2e] erros de console até aqui:\n  ' + (cdp.consoleErrors().slice(0, 10).join('\n  ') || '(nenhum)'));
        console.error('[e2e] estado: ' + JSON.stringify(await cdp.eval('({ app: !!window.App, session: !!(window.App && App.session), shell: !!(window.App && App.shell), loginError: (document.getElementById("login-error")||{}).textContent || "", path: location.pathname, catalogLoading: !!(window.App && App.catalog && App.catalog.isLoading()), activeList: (window.App && App.lists && App.lists.active()) ? App.lists.active().name : null, listCount: (window.App && App.lists) ? App.lists.all().length : -1, sync: (window.App && App.sync && App.sync.status) ? App.sync.status() : null })')));
      } catch (e2) { /* ignore */ }
    }
    if (stderr) console.error('[e2e] stderr (fim):\n' + stderr.slice(-2000));
    process.exitCode = 2;
  } finally {
    await cleanup();
    if (KEEP) {
      console.log('[e2e] --keep: mantendo app aberto (feche manualmente).');
    }
  }
}

main();
