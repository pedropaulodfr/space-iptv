#!/usr/bin/env node
/* E2E do login/admin no navegador real (headless), via Chrome DevTools Protocol.
 *
 * Sobe o Postgres do Neon + o runner das Pages Functions, abre o Microsoft Edge
 * headless e percorre o fluxo de verdade:
 *   1. `/` sem sessão cai no login;
 *   2. login do admin entra no app, sidebar mostra "Administração";
 *   3. a tela de Administração lista as contas;
 *   4. login do usuário comum NÃO mostra "Administração";
 *   5. nenhuma violação de CSP no console.
 *
 * Sem dependencias: usa o WebSocket global do Node 22+ e o Edge instalado.
 * Uso: node tools/e2e-login.js [--keep] [--out pasta]
 * Saida: capturas em tools/_shots/ (gitignored) e resumo PASS/FAIL.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const fixtures = require('./db-fixtures.js');
const { createPagesServer } = require('./pages-runner.js');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(function (p) { return fs.existsSync(p); });

const args = process.argv.slice(2);
const OUT_DIR = (function () {
  const i = args.indexOf('--out');
  return i >= 0 ? path.resolve(ROOT, args[i + 1]) : path.join(ROOT, 'tools', '_shots');
})();

const results = [];
function check(name, ok, detail) { results.push({ name: name, ok: !!ok, detail: detail || '' }); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  [' + detail + ']' : '')); }

function freePort() {
  return new Promise(function (resolve, reject) {
    const server = require('net').createServer();
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      server.close(function () { resolve(port); });
    });
    server.on('error', reject);
  });
}

function httpJson(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) {
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------- CDP mínimo ---------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
    ws.addEventListener('close', function () {});
  }
  static connect(url) {
    return new Promise(function (resolve, reject) {
      const ws = new WebSocket(url);
      ws.addEventListener('open', function () { resolve(new Cdp(ws)); });
      ws.addEventListener('error', function (e) { reject(new Error('ws: ' + (e && e.message))); });
    });
  }
  send(method, params) {
    const id = ++this.id;
    const self = this;
    return new Promise(function (resolve) {
      self.pending.set(id, resolve);
      self.ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.result && r.result.exceptionDetails) {
      return { error: r.result.exceptionDetails.text };
    }
    return { value: r.result && r.result.result ? r.result.result.value : undefined };
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      return true;
    }
    return false;
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function waitFor(cdp, expression, timeoutMs) {
  const limit = Date.now() + (timeoutMs || 15000);
  while (Date.now() < limit) {
    const r = await cdp.evaluate(expression);
    if (r.value) return true;
    await sleep(250);
  }
  return false;
}

async function main() {
  if (!EDGE) {
    console.log('SKIP: nenhum Edge/Chrome encontrado nesta máquina.');
    return;
  }
  if (!fs.existsSync(path.join(ROOT, 'dist', 'web', 'index.html'))) {
    console.log('FAIL: rode "node web/build.js" antes.');
    process.exitCode = 1;
    return;
  }

  const env = fixtures.loadEnv({ AUTH_RECOVERY_ENABLED: 'false' });
  await fixtures.cleanup(env);
  await fixtures.seedUser(env, { email: 'admin@e2e.local', password: 'senha-de-teste', name: 'Admin', role: 'admin' });
  await fixtures.seedUser(env, { email: 'user@e2e.local', password: 'senha-de-teste', name: 'Usuário', role: 'user' });

  const responses = [];
  const runner = createPagesServer({
    dir: 'dist/web',
    env: env,
    onResponse: function (r) { responses.push(r); }
  });
  const base = await runner.listen(0);

  const port = await freePort();
  const profile = path.join(ROOT, '.tools', 'e2e-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const browser = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try {
        targets = await httpJson('http://127.0.0.1:' + port + '/json/list');
        if (targets && targets.length) break;
      } catch (e) { /* ainda subindo */ }
      await sleep(250);
    }
    if (!targets || !targets.length) throw new Error('Edge não abriu o DevTools');
    const page = targets.filter(function (t) { return t.type === 'page'; })[0] || targets[0];
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    /* ---------- 1. gate ---------- */
    await cdp.send('Page.navigate', { url: base + '/' });
    const landed = await waitFor(cdp, 'location.pathname === "/login.html"', 15000);
    check('/ sem sessão redireciona para /login.html', landed, (await cdp.evaluate('location.href')).value);
    const nextParam = await cdp.evaluate('new URLSearchParams(location.search).get("next")');
    check('next na URL é "/"', nextParam.value === '/', String(nextParam.value));

    await sleep(600);
    await cdp.screenshot(path.join(OUT_DIR, 'login.png'));
    const hasForm = await cdp.evaluate('!!document.getElementById("login-form") && !!document.getElementById("email")');
    check('formulário de login renderizado', hasForm.value === true);

    /* ---------- 2. login do admin ---------- */
    await cdp.evaluate('(function(){' +
      'document.getElementById("email").value = "admin@e2e.local";' +
      'document.getElementById("password").value = "senha-de-teste";' +
      'document.getElementById("login-form").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true}));' +
      'return true; })()');
    const entered = await waitFor(cdp, 'location.pathname === "/"', 20000);
    check('login do admin entra no app (/)', entered, (await cdp.evaluate('location.pathname')).value);
    const booted = await waitFor(cdp, 'document.querySelectorAll("#sidebar .nav-item").length >= 7', 20000);
    check('sidebar montada', booted);

    const menu = await cdp.evaluate('Array.prototype.map.call(document.querySelectorAll("#sidebar .nav-item span"), function(s){return s.textContent;})');
    const labels = Array.isArray(menu.value) ? menu.value : [];
    check('menu do admin inclui "Administração"', labels.indexOf('Administração') >= 0, labels.join(' | '));
    const hudUser = await cdp.evaluate('(document.getElementById("hud-user")||{}).textContent || ""');
    check('HUD mostra o e-mail do usuário', String(hudUser.value).indexOf('admin@e2e.local') >= 0, String(hudUser.value));
    await sleep(800);
    await cdp.screenshot(path.join(OUT_DIR, 'app-admin.png'));

    /* ---------- 3. tela de administração ---------- */
    await cdp.evaluate('App.shell.goto("admin"); true');
    const rowsReady = await waitFor(cdp, 'document.querySelectorAll("#screen .admin-row").length >= 2', 15000);
    check('tela de Administração lista contas', rowsReady,
      String((await cdp.evaluate('document.querySelectorAll("#screen .admin-row").length')).value));
    const names = await cdp.evaluate('Array.prototype.map.call(document.querySelectorAll("#screen .admin-row .t"), function(n){return n.textContent;})');
    check('lista traz Admin e Usuário', Array.isArray(names.value) && names.value.length >= 2, JSON.stringify(names.value));
    await sleep(500);
    await cdp.screenshot(path.join(OUT_DIR, 'admin.png'));

    /* ---------- 3a. criar usuário pela tela (e ver a senha temporária) ---------- */
    await cdp.evaluate('(function () {' +
      'var b = document.querySelectorAll("#screen .actions-pane .btn");' +
      'for (var i = 0; i < b.length; i++) { if (b[i].textContent.indexOf("Novo usuário") >= 0) { b[i]._act(); return true; } }' +
      'return false; })()');
    await sleep(350);
    await cdp.evaluate('(function () {' +
      'var m = document.querySelectorAll("#overlays .modal"); m = m[m.length - 1];' +
      'var b = m && m.querySelectorAll(".btn"); if (b && b.length) { b[0]._act(); return true; } return false; })()');
    await sleep(350);
    await cdp.evaluate('(function () {' +
      'var m = document.querySelectorAll("#overlays .modal"); m = m[m.length - 1];' +
      'if (!m) return false;' +
      'var inputs = m.querySelectorAll("input");' +
      'inputs[0].value = "Conta E2E"; inputs[1].value = "conta.e2e@e2e.local";' +
      'var save = m.querySelector(".btn.primary"); if (save) { save._act(); return true; } return false; })()');
    const tempShown = await waitFor(cdp, '!!document.querySelector(".temp-pass")', 15000);
    const tempText = await cdp.evaluate('(document.querySelector(".temp-pass") || {}).textContent || ""');
    check('criar usuário pela tela mostra a senha temporária', tempShown, String(tempText.value).slice(0, 4) + '…');
    check('senha temporária tem 16 caracteres', String(tempText.value).length === 16, String(tempText.value.length));
    await cdp.screenshot(path.join(OUT_DIR, 'admin-senha.png'));
    await cdp.evaluate('(function () {' +
      'var m = document.querySelectorAll("#overlays .modal"); m = m[m.length - 1];' +
      'var b = m && m.querySelector(".btn"); if (b && b._act) { b._act(); return true; } return false; })()');
    await sleep(900);
    const rowsAfter = await cdp.evaluate('document.querySelectorAll("#screen .admin-row").length');
    check('lista de usuários recarrega com a conta nova', rowsAfter.value === 3, String(rowsAfter.value));

    /* ---------- 3b. sincronização de ida e volta ---------- */
    const created = await cdp.evaluate(
      'App.lists.save({name:"Lista E2E", type:"m3u", url:"https://exemplo.test/lista.m3u"})' +
      '.then(function(rec){ return rec && rec.id; }, function(){ return ""; })');
    check('lista criada no app recebe UUID', /^[0-9a-f-]{36}$/i.test(String(created.value)), String(created.value));

    /* O debounce é de 800 ms, mas em headless a aba fica em segundo plano e o
       navegador estrangula timers. Espera até 5 s e, se preciso, força o flush
       (o que importa aqui é o round-trip, não o relógio). */
    let pushed = false;
    for (let i = 0; i < 20 && !pushed; i++) {
      await sleep(250);
      const pending = await cdp.evaluate('App.sync.pending()');
      if (pending.value === 0) pushed = true;
    }
    if (!pushed) {
      await cdp.evaluate('App.sync.flush()');
      await sleep(400);
    }
    if (process.env.E2E_DEBUG) {
      console.log('DEBUG status: ' + JSON.stringify((await cdp.evaluate('App.sync.status()')).value));
      console.log('DEBUG respostas: ' + JSON.stringify(responses.filter(function (r) {
        return r.path.indexOf('/api/sync') === 0;
      }).map(function (r) { return r.method + ' ' + r.path + ' ' + r.status; })));
    }
    const pulled = await cdp.evaluate(
      'fetch("/api/sync/pull").then(function(r){return r.json();}).then(function(d){' +
      'return { n: (d.playlists||[]).length, name: d.playlists&&d.playlists[0]&&d.playlists[0].name,' +
      ' secret: d.secrets&&d.secrets[0]&&d.secrets[0].m3u_url }; })');
    const pv = pulled.value || {};
    check('a lista criada sobe para a nuvem', pv.n === 1 && pv.name === 'Lista E2E', JSON.stringify(pv));
    check('a URL da lista chega à nuvem em claro (TLS + RLS)',
      pv.secret === 'https://exemplo.test/lista.m3u', String(pv.secret));

    const queue = await cdp.evaluate('App.sync.pending()');
    check('fila de sincronização fica vazia depois do push', queue.value === 0, String(queue.value));

    await cdp.send('Page.reload');
    const backAfterReload = await waitFor(cdp, 'window.App && App.lists && App.lists.all().length === 1', 20000);
    check('após reload o pull devolve a lista da conta', backAfterReload,
      String((await cdp.evaluate('App.lists.all().length')).value));

    /* ---------- 4. usuário comum não vê Administração ---------- */
    await cdp.send('Network.clearBrowserCookies');
    await cdp.send('Page.navigate', { url: base + '/' });
    await waitFor(cdp, 'location.pathname === "/login.html"', 15000);
    await sleep(400);
    await cdp.evaluate('(function(){' +
      'document.getElementById("email").value = "user@e2e.local";' +
      'document.getElementById("password").value = "senha-de-teste";' +
      'document.getElementById("login-form").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true}));' +
      'return true; })()');
    const userIn = await waitFor(cdp, 'location.pathname === "/"', 20000);
    check('login do usuário comum entra no app', userIn);
    await waitFor(cdp, 'document.querySelectorAll("#sidebar .nav-item").length >= 6', 20000);
    const menuUser = await cdp.evaluate('Array.prototype.map.call(document.querySelectorAll("#sidebar .nav-item span"), function(s){return s.textContent;})');
    const userLabels = Array.isArray(menuUser.value) ? menuUser.value : [];
    check('menu do usuário comum NÃO tem "Administração"', userLabels.indexOf('Administração') < 0, userLabels.join(' | '));
    await sleep(500);
    await cdp.screenshot(path.join(OUT_DIR, 'app-user.png'));

    const pushBodies = cdp.events.filter(function (e) {
      return e.method === 'Network.requestWillBeSent' && String(e.params.request.url).indexOf('/api/sync/push') >= 0;
    }).map(function (e) { return e.params.request.postData; });
    if (process.env.E2E_DEBUG) console.log('DEBUG push bodies: ' + JSON.stringify(pushBodies));

    /* ---------- 5. CSP / erros de console ---------- */
    const logs = cdp.events.filter(function (e) { return e.method === 'Log.entryAdded'; })
      .map(function (e) { return e.params.entry; });
    const cspViolations = logs.filter(function (e) {
      return /Content Security Policy|Refused to/i.test(String(e.text || ''));
    });
    check('nenhuma violação de CSP no console', cspViolations.length === 0,
      cspViolations.map(function (e) { return e.text; }).join(' | '));
    const severe = logs.filter(function (e) {
      if (e.level !== 'error') return false;
      if (/401|403|404/.test(String(e.text))) return false;
      /* o provedor falso do teste não existe: falha de DNS é esperada */
      if (/exemplo\.test|ERR_NAME_NOT_RESOLVED/.test(String(e.text) + ' ' + String(e.url || ''))) return false;
      return true;
    });
    check('nenhum erro grave de console', severe.length === 0,
      severe.slice(0, 3).map(function (e) { return e.text + ' @ ' + (e.url || ''); }).join(' | '));
  } catch (e) {
    check('execução do E2E', false, e && e.message);
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (e) { /* ignore */ }
    await runner.close();
    await fixtures.cleanup(env);
    if (args.indexOf('--keep') < 0) {
      /* o Edge demora um instante para soltar o perfil; falhar aqui não é erro do teste */
      await sleep(600);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* perfil em uso */ }
    }
  }

  const failCount = results.filter(function (r) { return !r.ok; }).length;
  console.log('');
  console.log('Resumo E2E: ' + (results.length - failCount) + ' PASS, ' + failCount + ' FAIL');
  console.log('Capturas: ' + OUT_DIR);
  process.exitCode = failCount ? 1 : 0;
}

main().catch(function (e) {
  console.error('falha fatal: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
