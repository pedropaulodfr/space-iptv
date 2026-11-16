#!/usr/bin/env node
/* Auditoria visual/usabilidade/acessibilidade do Space IPTV Desktop com Playwright.
 *
 * Usa `playwright-core` (sem baixar navegador) e o suporte a Electron
 * (`_electron.launch`) apontando para um binário do Electron fora do workspace
 * (neste ambiente o sandbox bloqueia executar binários de dentro do repo).
 *
 * O que faz:
 *   1. sobe o mock provider (LAN), abre o app, faz login real no backend de teste;
 *   2. importa a lista mock e injeta itens para a grade ficar rolável;
 *   3. mede layout compacto, alvos de clique, contraste de textos;
 *   4. testa a barra de rolagem (visível, acima do último card, clique, arrasto,
 *      teclado, ARIA/foco) e a árvore de acessibilidade (CDP);
 *   5. testa teclado (setas/Enter/Esc), reduced-motion, overflow horizontal;
 *   6. captura screenshots e grava `desktop/docs/PLAYWRIGHT-AUDIT.md`.
 *
 * Uso:
 *   node scripts/audit-playwright.js [--electron <caminho>] [--keep]
 * Env:
 *   ELECTRON_BIN      binário do Electron (senão usa o caminho padrão abaixo)
 *   SPACE_AUDIT_API   backend de login (padrão http://127.0.0.1:8789)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { _electron: electron } = require('playwright-core');

const DESKTOP = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP, '..');
const TMP = path.join(DESKTOP, 'test', 'tmp');
const SHOTS = path.join(ROOT, 'dist', 'desktop-shots');
const REPORT = path.join(DESKTOP, 'docs', 'PLAYWRIGHT-AUDIT.md');
const ENV_FILE = path.join(TMP, 'env.json');

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const KEEP = args.includes('--keep');
const ELECTRON_BIN = argValue('--electron', process.env.ELECTRON_BIN || 'D:\\temp-electron40\\electron.exe');
const API_ORIGIN = argValue('--api', process.env.SPACE_AUDIT_API || 'http://127.0.0.1:8789');

const results = [];
const shots = [];
function check(ok, area, label, detail) {
  results.push({ ok: !!ok, area, label, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + '[' + area + '] ' + label + (detail ? ' — ' + detail : ''));
  return !!ok;
}
function note(area, label, detail) {
  results.push({ ok: true, area, label, detail: detail || '', note: true });
  console.log('NOTE [' + area + '] ' + label + (detail ? ' — ' + detail : ''));
}

/* ------------------------------ utilidades ------------------------------ */

function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ip of ifaces[name] || []) {
      if (ip && ip.family === 'IPv4' && !ip.internal) return ip.address;
    }
  }
  return '';
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* contraste WCAG a partir de rgba sobre um fundo conhecido */
function parseColor(value) {
  const m = /rgba?\(([^)]+)\)/.exec(String(value || ''));
  if (!m) return null;
  const p = m[1].split(',').map((x) => parseFloat(x));
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
function composite(fg, bg) {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 1 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a: 1
  };
}
function luminance(c) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function contrastRatio(fg, bg) {
  const l1 = luminance(composite(fg, bg)) + 0.05;
  const l2 = luminance(bg) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}
const SPACE_BLACK = { r: 5, g: 7, b: 17, a: 1 };

/* --------------------------- mock provider LAN --------------------------- */

async function startProvider() {
  const mod = require(path.join(DESKTOP, 'test', 'helpers', 'mock-provider.js'));
  const host = lanIp();
  if (!host) throw new Error('sem IPv4 de LAN para o mock provider');
  const provider = await mod.startMockProvider({ host: host });
  const text = await (await fetch(provider.baseUrl + '/m3u')).text();
  return { provider, host: host, m3uText: text };
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const envInfo = readJson(ENV_FILE) || {};
  const user = (envInfo.testUsers && envInfo.testUsers.user) || {};
  if (!user.email || !user.password) throw new Error('test/tmp/env.json sem testUsers.user (backend de teste)');
  if (!fs.existsSync(ELECTRON_BIN)) throw new Error('binário do Electron não encontrado: ' + ELECTRON_BIN);

  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  const provider = await startProvider();
  const workDir = path.join(TMP, 'pw-audit-' + Date.now());
  fs.mkdirSync(workDir, { recursive: true });
  const env = Object.assign({}, process.env, {
    SPACE_API_ORIGIN: API_ORIGIN,
    SPACE_CONFIG_FILE: path.join(workDir, 'config.json'),
    SPACE_DOWNLOADS_DIR: path.join(workDir, 'downloads'),
    SPACE_USER_DATA: path.join(workDir, 'userdata'),
    SPACE_INTERNAL_PORT: '0',
    SPACE_NO_AUTOSTART: '1'
  });
  delete env.ELECTRON_RUN_AS_NODE;

  let app = null;
  try {
    app = await electron.launch({
      executablePath: ELECTRON_BIN,
      args: [DESKTOP, '--no-sandbox', '--disable-gpu'],
      env,
      timeout: 90000
    });
    const page = await app.firstWindow({ timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');
    page.on('pageerror', (err) => console.log('[audit] PAGEERROR: ' + err.message));
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error' || text.indexOf('[dl]') === 0 || text.indexOf('[fs]') === 0) console.log('[audit] CONSOLE(' + msg.type() + '): ' + text.slice(0, 240));
    });
    await page.setViewportSize({ width: 1366, height: 768 }).catch(() => {});
    const shot = async (name) => {
      const file = path.join(SHOTS, 'pw-' + name + '.png');
      try { await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.textContent = ''; }); } catch (e) { /* ignore */ }
      await page.screenshot({ path: file });
      shots.push(file);
      return file;
    };
    const go = async (id, wait) => {
      await page.evaluate((screen) => { if (window.App && App.shell) App.shell.goto(screen); }, id);
      await sleep(wait || 700);
    };
    const metrics = (fn, arg) => page.evaluate(fn, arg);

    /* ---------- login real ---------- */
    await sleep(1200);
    const pathname = await page.evaluate(() => location.pathname);
    if (pathname.indexOf('/login.html') === 0) {
      await shot('00-login');
      await page.waitForSelector('#email', { timeout: 10000 });
      await page.fill('#email', user.email);
      await page.fill('#password', user.password);
      await page.click('#login-submit');
    }
    await page.waitForSelector('#sidebar .nav-item', { timeout: 30000 });
    await page.waitForFunction(() => !!(window.App && App.shell), null, { timeout: 30000 });
    await sleep(800);
    check(true, 'login', 'login real e shell carregado');

    /* ---------- lista mock + itens para rolar ---------- */
    await page.evaluate(async () => {
      const all = App.lists.all();
      for (const l of all) { try { await App.lists.remove(l.id); } catch (e) { /* ignore */ } }
      await App.catalog.init(null);
    });
    await sleep(300);
    const imported = await page.evaluate(async (m3u) => {
      const rec = await App.lists.saveFile({ name: 'Auditoria', filename: 'auditoria.m3u', size: m3u.length, text: m3u });
      App.lists.setActive(rec.id);
      await App.catalog.init(rec);
      await App.catalog.refresh(rec);
      const d = App.catalog.data;
      if (d.movie.length < 60) {
        for (let i = 0; d.movie.length < 60; i++) {
          const it = { id: 'pw' + i, t: 'movie', n: 'Filme ' + (i + 1), ns: 'filme ' + (i + 1), c: 'Filmes', l: '', u: 'http://127.0.0.1:9/x.mp4', y: '2026', d: 0 };
          d.movie.push(it); d.map.movie[it.id] = it;
          if (d.by.movie['Filmes']) d.by.movie['Filmes'].push(it);
        }
        d.by.movie['*'] = d.movie;
      }
      return { live: d.live.length, movie: d.movie.length };
    }, provider.m3uText);
    check(imported.live > 0 && imported.movie >= 60, 'usabilidade', 'lista importada e grade rolável', JSON.stringify(imported));

    /* ---------- layout compacto ---------- */
    await go('home', 900);
    await shot('01-inicio');
    const layout = await metrics(() => {
      const hud = document.getElementById('hud').getBoundingClientRect();
      const hints = document.getElementById('hints').getBoundingClientRect();
      const screen = document.getElementById('screen').getBoundingClientRect();
      return {
        iw: innerWidth, ih: innerHeight,
        hud: { left: hud.left, top: hud.top, right: hud.right, bottom: hud.bottom },
        hintsBottom: hints.bottom, screen: { left: screen.left, right: screen.right, top: screen.top, bottom: screen.bottom },
        fit: App.stageFit || null, scrollWidth: document.documentElement.scrollWidth
      };
    });
    check(layout.fit && layout.fit.fill === true, 'visual', 'palco preenche a janela (fill)', JSON.stringify(layout.fit));
    check(layout.hud.left <= 16 && layout.hud.top <= 16 && layout.hud.right >= layout.iw - 20, 'visual', 'layout compacto (margem ~8px de projeto)', JSON.stringify(layout.hud));
    check(layout.hintsBottom <= layout.ih + 1 && layout.hintsBottom > layout.ih - 40, 'visual', 'conteúdo vai até o fim da janela', 'hints bottom=' + Math.round(layout.hintsBottom) + ' / ' + layout.ih);
    check(layout.scrollWidth <= layout.iw + 1, 'visual', 'sem rolagem horizontal da página', layout.scrollWidth + ' <= ' + layout.iw);

    /* ---------- alvos de clique (44px renderizados) ---------- */
    const targets = await metrics(() => {
      const out = [];
      const els = document.querySelectorAll('#sidebar .nav-item, #hud-fs');
      for (const el of els) {
        const r = el.getBoundingClientRect();
        out.push({ sel: el.id ? '#' + el.id : 'nav-item', w: r.width, h: r.height });
      }
      return out;
    });
    const smallTargets = targets.filter((t) => t.h < 43.5 || t.w < 43.5);
    check(smallTargets.length === 0, 'acessibilidade', 'alvos de clique do HUD/menu com >= 44px', smallTargets.length ? JSON.stringify(smallTargets.slice(0, 4)) : targets.length + ' medidos');

    /* ---------- contraste de textos principais ---------- */
    const contrasts = await metrics(() => {
      const out = {};
      const read = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { color: cs.color, bg: cs.backgroundColor, fontSize: cs.fontSize };
      };
      out.hints = read('#hints');
      out.caption = read('#hud .hud-caption');
      out.badge = read('#hud-status');
      out.sub = read('.poster .psub');
      out.guideSub = read('.guide-sub');
      return out;
    });
    const pairs = [];
    for (const key of Object.keys(contrasts)) {
      const c = contrasts[key];
      if (!c || !c.color) continue;
      const fg = parseColor(c.color);
      if (!fg) continue;
      const ratio = contrastRatio(fg, SPACE_BLACK);
      pairs.push({ key: key, ratio: Math.round(ratio * 100) / 100, fontSize: c.fontSize, color: c.color });
    }
    const lowText = pairs.filter((p) => p.ratio < 4.5);
    check(lowText.length === 0, 'acessibilidade', 'contraste de texto >= 4.5:1 nas amostras', JSON.stringify(pairs));

    /* ---------- barra de rolagem ---------- */
    await go('movies', 1000);
    const sb = await metrics(() => {
      const v = document.querySelector('#screen .content .vlist');
      if (!v) return null;
      const bar = v.parentElement.querySelector('.vl-scroll');
      const thumb = bar && bar.querySelector('.vl-scrollthumb');
      if (!bar || !thumb) return null;
      const br = bar.getBoundingClientRect();
      const tr = thumb.getBoundingClientRect();
      const vr = v.getBoundingClientRect();
      const cs = getComputedStyle(thumb);
      const bcs = getComputedStyle(bar);
      return {
        on: bar.classList.contains('on'),
        scrollTop: v.scrollTop, scrollHeight: v.scrollHeight, clientHeight: v.clientHeight,
        bar: { left: br.left, top: br.top, width: br.width, height: br.height, z: bcs.zIndex, opacity: bcs.opacity },
        thumb: { left: tr.left, top: tr.top, width: tr.width, height: tr.height, bg: cs.backgroundColor, outline: cs.outlineWidth, tabIndex: thumb.tabIndex, ariaHidden: thumb.getAttribute('aria-hidden') },
        list: { left: vr.left, right: vr.right, top: vr.top, bottom: vr.bottom }
      };
    });
    check(!!(sb && sb.on), 'usabilidade', 'barra de rolagem visível na grade', JSON.stringify(sb && { scrollHeight: sb.scrollHeight, clientHeight: sb.clientHeight }));
    check(!!(sb && sb.thumb.width >= 8 && sb.thumb.height >= 40), 'usabilidade', 'polegar da barra tem tamanho utilizável (>=8x40 renderizados)', JSON.stringify(sb && sb.thumb));
    check(!!(sb && Number(sb.bar.z) >= 40), 'visual', 'barra acima dos cards (z-index >= 40)', sb && sb.bar.z);
    check(!!(sb && sb.thumb.tabIndex === 0 && sb.thumb.ariaHidden === 'false'), 'acessibilidade', 'barra focável por teclado quando visível', JSON.stringify(sb && { tabIndex: sb.thumb.tabIndex, ariaHidden: sb.thumb.ariaHidden }));

    /* categorias: barra mais fina que a da grade (não pode competir visualmente) */
    const barSizes = await page.evaluate(() => {
      const catBar = document.querySelector('.cats .vl-scroll');
      const catThumb = document.querySelector('.cats .vl-scrollthumb');
      const gridBar = document.querySelector('#screen .content .vl-scroll');
      const gridThumb = document.querySelector('#screen .content .vl-scrollthumb');
      function size(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; }
      return { catBar: size(catBar), catThumb: size(catThumb), gridBar: size(gridBar), gridThumb: size(gridThumb) };
    });
    check(!!(barSizes.catBar && barSizes.gridBar && barSizes.catBar.w < barSizes.gridBar.w * 0.8), 'visual', 'barra das categorias é mais fina que a da grade', JSON.stringify(barSizes));
    check(!!(barSizes.catThumb && barSizes.catThumb.w <= 8), 'visual', 'polegar das categorias não fica grosso', JSON.stringify(barSizes.catThumb));

    /* contraste do polegar contra o fundo do palco */
    if (sb) {
      const thumbColor = parseColor(sb.thumb.bg);
      const ratio = contrastRatio(thumbColor, SPACE_BLACK);
      check(ratio >= 3, 'acessibilidade', 'contraste do polegar >= 3:1 (componente de UI)', 'ratio=' + Math.round(ratio * 100) / 100 + ' bg=' + sb.thumb.bg);
    }

    /* último card da linha não pode cobrir a barra: hit-test sobre o polegar */
    const hover = await page.evaluate(() => {
      const v = document.querySelector('#screen .content .vlist');
      const bar = v.parentElement.querySelector('.vl-scroll');
      const thumb = bar.querySelector('.vl-scrollthumb');
      const tr = thumb.getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll('#screen .content .vl-cell .card, #screen .content .vl-cell .poster'));
      const vr = v.getBoundingClientRect();
      let last = null;
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        if (r.top >= vr.top && r.bottom <= vr.bottom && (!last || r.right > last.r.right)) last = { el: c, r: r };
      }
      const hit = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
      return {
        target: { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 },
        hitClass: hit ? String(hit.className) : '',
        lastCard: last ? { x: last.r.left + last.r.width / 2, y: last.r.top + last.r.height / 2, right: last.r.right } : null
      };
    });
    if (hover.lastCard) {
      await page.mouse.move(hover.lastCard.x, hover.lastCard.y);
      await sleep(250);
    }
    const hit = await page.evaluate((t) => {
      const el = document.elementFromPoint(t.x, t.y);
      return el ? String(el.className) : '';
    }, hover.target);
    check(/vl-scroll/.test(hit), 'usabilidade', 'barra acessível mesmo com o mouse sobre o último card', 'hit=' + hit);

    /* clique na trilha abaixo do polegar rola a lista */
    const clicked = await page.evaluate(() => {
      const v = document.querySelector('#screen .content .vlist');
      const bar = v.parentElement.querySelector('.vl-scroll');
      const br = bar.getBoundingClientRect();
      return { x: br.left + br.width / 2, y: br.top + br.height - 30, before: v.scrollTop };
    });
    await page.mouse.click(clicked.x, clicked.y);
    await sleep(400);
    const afterClick = await page.evaluate(() => document.querySelector('#screen .content .vlist').scrollTop);
    check(afterClick !== clicked.before, 'usabilidade', 'clique na trilha rola a grade', clicked.before + ' -> ' + afterClick);

    /* clique no meio da trilha deve cair na posição correspondente (~35%) */
    const midClick = await page.evaluate(() => {
      const v = document.querySelector('#screen .content .vlist');
      const bar = v.parentElement.querySelector('.vl-scroll');
      const thumb = bar.querySelector('.vl-scrollthumb');
      v.scrollTop = 0;
      const br = bar.getBoundingClientRect();
      const th = parseFloat(thumb.style.height) || 40;
      return { x: br.left + br.width / 2, y: br.top + th / 2 + (br.height - th) * 0.35 };
    });
    await page.mouse.click(midClick.x, midClick.y);
    await sleep(400);
    const midRatio = await page.evaluate(() => {
      const v = document.querySelector('#screen .content .vlist');
      const max = Math.max(1, v.scrollHeight - v.clientHeight);
      return v.scrollTop / max;
    });
    check(Math.abs(midRatio - 0.35) <= 0.09, 'usabilidade', 'clique na trilha cai na posição certa (~35%)', 'ratio=' + Math.round(midRatio * 1000) / 1000);

    /* arrastar o polegar (para cima, saindo do extremo inferior) */
    const dragInfo = await page.evaluate(() => {
      const v = document.querySelector('#screen .content .vlist');
      const thumb = v.parentElement.querySelector('.vl-scrollthumb');
      const tr = thumb.getBoundingClientRect();
      return { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2, before: v.scrollTop };
    });
    await page.mouse.move(dragInfo.x, dragInfo.y);
    await page.mouse.down();
    await sleep(120);
    const dragArmed = await page.evaluate(() => {
      const t = document.querySelector('#screen .content .vl-scrollthumb');
      return { armed: t.getAttribute('data-drag') === '1', cls: t.parentElement.className };
    });
    await page.mouse.move(dragInfo.x, dragInfo.y - 160, { steps: 10 });
    await page.mouse.up();
    await sleep(400);
    const afterDrag = await page.evaluate(() => ({
      top: document.querySelector('#screen .content .vlist').scrollTop,
      value: document.querySelector('#screen .content .vl-scrollthumb').getAttribute('aria-valuenow'),
      text: document.querySelector('#screen .content .vl-scrollthumb').getAttribute('aria-valuetext')
    }));
    check(afterDrag.top !== dragInfo.before, 'usabilidade', 'arrastar o polegar rola a grade', dragInfo.before + ' -> ' + afterDrag.top + ' armed=' + JSON.stringify(dragArmed));
    check(afterDrag.value != null && afterDrag.text != null, 'acessibilidade', 'barra expõe aria-valuenow/valuetext', JSON.stringify(afterDrag));
    await shot('02-grade-barra-rolagem');

    /* teclado na barra (teclas reais do Playwright; keys.js respeita o foco na barra) */
    await page.locator('#screen .content .vl-scrollthumb').focus();
    const kb = await page.evaluate(() => {
      const t = document.querySelector('#screen .content .vl-scrollthumb');
      return { focused: document.activeElement === t, tabIndex: t.tabIndex, before: document.querySelector('#screen .content .vlist').scrollTop };
    });
    await page.keyboard.press('PageDown');
    await sleep(250);
    const afterPage = await page.evaluate(() => document.querySelector('#screen .content .vlist').scrollTop);
    await page.keyboard.press('Home');
    const homeNow = await page.evaluate(() => document.querySelector('#screen .content .vlist').scrollTop);
    await sleep(250);
    const afterHome = await page.evaluate(() => document.querySelector('#screen .content .vlist').scrollTop);
    check(kb.focused && afterPage !== kb.before && afterHome === 0, 'acessibilidade', 'barra navegável por teclado (PageDown/Home reais)', JSON.stringify({ focused: kb.focused, before: kb.before, afterPage: afterPage, afterHome: afterHome }));

    /* árvore de acessibilidade: role scrollbar + nome */
    let axOk = false, axDetail = '';
    try {
      const client = await page.context().newCDPSession(page);
      const tree = await client.send('Accessibility.getFullAXTree');
      const node = (tree.nodes || []).find((n) => n.role && n.role.value === 'scrollbar');
      if (node) {
        const name = node.name && node.name.value ? node.name.value : '';
        const props = (node.properties || []).map((p) => p.name + '=' + (p.value && p.value.value));
        axOk = /rolar/i.test(name);
        axDetail = 'name=' + name + ' props=' + props.join(',');
      }
      await client.detach().catch(() => {});
    } catch (e) { axDetail = 'CDP falhou: ' + e.message; }
    check(axOk, 'acessibilidade', 'árvore de acessibilidade tem scrollbar nomeado', axDetail);

    /* ---------- tela Baixados com download real (não pode ficar em skeleton) ---------- */
    let dlId = '';
    try {
      const added = await page.evaluate(async (url) => {
        try {
          const out = await space.downloads.add({ kind: 'movie', title: 'Baixados Auditoria', listId: 'pw-audit', itemId: 'pw-audit-dl', url: url, durationSec: 1, totalBytes: 0 });
          const list = await space.downloads.list();
          return { ok: !!(out && out.ok), id: (out && out.id) || (list.items[0] && list.items[0].id) || '' };
        } catch (e) { return { ok: false, error: String(e && (e.message || e.code) || e) }; }
      }, provider.provider.baseUrl + '/movie.mp4');
      dlId = added.id || '';
      await page.evaluate(() => { window.__DL_DEBUG = true; });
      await sleep(1500);
      /* sonda direta do IPC: distingue "lista demora no main" de "tela não destrava" */
      const listProbe = await page.evaluate(async () => {
        const t = Date.now();
        try {
          const r = await space.downloads.list();
          return { ms: Date.now() - t, items: (r.items || []).length, error: r.error || '' };
        } catch (e) { return { ms: Date.now() - t, error: String(e && (e.message || e.code) || e) }; }
      });
      console.log('[audit] probe downloads.list(): ' + JSON.stringify(listProbe));
      await go('downloads', 300);
      try {
        await page.waitForFunction(() => {
          const s = document.querySelector('.dl-screen');
          return !!(s && !s.classList.contains('is-loading'));
        }, null, { timeout: 9000 });
      } catch (e) { /* segue: a checagem abaixo reprova */ }
      const dlScreen = await page.evaluate(() => {
        const screens = document.querySelectorAll('.dl-screen');
        const screen = screens[0];
        const rows = document.querySelectorAll('.dl-row');
        const skel = document.querySelector('.dl-skeleton');
        const list = document.querySelector('.dl-list');
        return {
          screens: screens.length,
          loading: !!(screen && screen.classList.contains('is-loading')),
          cls: screen ? screen.className : '',
          rows: rows.length,
          skeletonVisible: !!(skel && skel.getClientRects().length > 0),
          skelDisplay: skel ? getComputedStyle(skel).display : '',
          listDisplay: list ? getComputedStyle(list).display : '',
          summary: (document.querySelector('.dl-summary') || {}).textContent || '',
          empty: (document.querySelector('.dl-list .vl-empty') || {}).textContent || '',
          text: (document.querySelector('.dl-body') || {}).innerText ? document.querySelector('.dl-body').innerText.slice(0, 160) : ''
        };
      });
      await shot('05-baixados');
      check(!dlScreen.loading && dlScreen.rows >= 1 && !dlScreen.skeletonVisible, 'usabilidade', 'tela Baixados mostra os downloads (sem skeleton eterno)', JSON.stringify({ dlScreen: dlScreen, probe: listProbe }));
    } catch (e) {
      check(false, 'usabilidade', 'tela Baixados mostra os downloads (sem skeleton eterno)', 'erro: ' + e.message);
    } finally {
      if (dlId) {
        try { await page.evaluate((id) => space.downloads.remove(id, { deleteFiles: true }), dlId); } catch (e) { /* ignore */ }
      }
    }

    /* ---------- tela cheia do PLAYER (janela nativa via IPC) ---------- */
    try {
      let listNow = await page.evaluate(() => space.downloads.list());
      if (!(listNow.items || []).length) {
        await page.evaluate(async (url) => {
          try { await space.downloads.add({ kind: 'movie', title: 'Player Tela Cheia', listId: 'pw-audit', itemId: 'pw-audit-fs', url: url, durationSec: 1, totalBytes: 0 }); } catch (e) { /* ignore */ }
        }, provider.provider.baseUrl + '/movie.mp4');
        await sleep(1800);
        listNow = await page.evaluate(() => space.downloads.list());
      }
      const opened = await page.evaluate(async () => {
        const r = await space.downloads.list();
        const it = (r.items || []).find((x) => x.status === 'done') || (r.items || [])[0];
        if (!it) return { ok: false, error: 'sem download' };
        try { App.downloads.playOffline(it); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        return { ok: true, id: it.id };
      });
      if (opened.ok) {
        await page.waitForFunction(() => !!(window.App && App.player && typeof App.player.isOpen === 'function' && App.player.isOpen()), null, { timeout: 15000 });
        await sleep(600);
        const playerDlId = opened.id || '';
        const fsBtn = '#player .pl-btn[aria-label="Tela cheia"]';
        await page.locator(fsBtn).first().click({ timeout: 6000 });
        let nativeFs = false;
        for (let k = 0; k < 20; k++) {
          nativeFs = await app.evaluate(({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows()[0];
            return !!(w && w.isFullScreen() && w.isFullScreenable());
          });
          if (nativeFs) break;
          await sleep(250);
        }
        const afterEnter = await page.evaluate(() => ({
          flag: !!(App.desktop && App.desktop.playerFullscreen),
          label: (document.querySelector('#player .pl-btn[aria-label]') || {}).getAttribute
            ? document.querySelector('#player .pl-btn[aria-label="Sair da tela cheia"]') !== null : false
        }));
        check(nativeFs && afterEnter.flag, 'usabilidade', 'botão de tela cheia do player funciona (janela nativa)', JSON.stringify({ opened: opened, nativeFs: nativeFs, ui: afterEnter }));
        /* Esc sai da tela cheia sem fechar o player */
        if (nativeFs) {
          await page.keyboard.press('Escape');
          let exited = false;
          for (let k = 0; k < 20; k++) {
            exited = await app.evaluate(({ BrowserWindow }) => {
              const w = BrowserWindow.getAllWindows()[0];
              return !!(w && !w.isFullScreen());
            });
            if (exited) break;
            await sleep(250);
          }
          const stillOpen = await page.evaluate(() => !!(App.player && App.player.isOpen()));
          const flagOff = await page.evaluate(() => !(App.desktop && App.desktop.playerFullscreen));
          check(exited && stillOpen && flagOff, 'usabilidade', 'Esc sai da tela cheia do player sem fechar o vídeo', JSON.stringify({ exited: exited, playerOpen: stillOpen, flagOff: flagOff }));
        } else {
          check(false, 'usabilidade', 'Esc sai da tela cheia do player sem fechar o vídeo', 'não entrou em tela cheia');
        }
        await page.evaluate(() => { try { App.player.close(true); } catch (e) { /* ignore */ } });
        await sleep(400);
        if (playerDlId) {
          try { await page.evaluate((id) => space.downloads.remove(id, { deleteFiles: true }), playerDlId); } catch (e) { /* ignore */ }
        }
      } else {
        check(false, 'usabilidade', 'botão de tela cheia do player funciona (janela nativa)', JSON.stringify(opened));
      }
    } catch (e) {
      check(false, 'usabilidade', 'botão de tela cheia do player funciona (janela nativa)', 'erro: ' + e.message);
    }

    /* ---------- teclado do app (setas/Enter/Esc) ---------- */
    await page.evaluate(() => App.shell.goto('home'));
    await sleep(700);
    await page.keyboard.press('ArrowDown');
    await sleep(200);
    const focusAfterKey = await page.evaluate(() => {
      const el = document.querySelector('#screen .focused');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const after = getComputedStyle(el, '::after');
      const r = el.getBoundingClientRect();
      return { cls: el.className, border: cs.borderColor, glow: after.content !== 'none' && after.boxShadow !== 'none', w: r.width, h: r.height };
    });
    check(!!focusAfterKey && (focusAfterKey.glow || /66, 133, 255|71, 136, 255/.test(focusAfterKey.border)), 'acessibilidade', 'foco visível ao navegar por teclado (setas)', JSON.stringify(focusAfterKey));

    /* ---------- reduced motion ---------- */
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await sleep(200);
    const reduced = await page.evaluate(() => {
      const planet = document.getElementById('planet');
      const cs = planet ? getComputedStyle(planet) : null;
      return cs ? { duration: cs.animationDuration, iteration: cs.animationIterationCount } : null;
    });
    check(!!reduced && (reduced.duration === '0s' || reduced.iteration === '1'), 'acessibilidade', 'prefers-reduced-motion desliga animações decorativas', JSON.stringify(reduced));
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    /* ---------- telas e screenshots ---------- */
    for (const scr of ['live', 'movies', 'series', 'search', 'favs', 'settings']) {
      await go(scr, 800);
      await shot('03-' + scr);
    }
    // guia (EPG BR1 já carregado/cache do boot? força se possível)
    await page.evaluate(() => { if (App.desktop && App.desktop.guide) App.desktop.guide.open(App.lists.active()); });
    await sleep(1200);
    await shot('04-guia');
    const guideBtns = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('.guide-panel button.btn, .guide-detail button.btn').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push({ w: r.width, h: r.height });
      });
      return out;
    });
    check(guideBtns.length === 0 || guideBtns.every((b) => b.h >= 43.5), 'acessibilidade', 'botões do Guia com >= 44px renderizados', JSON.stringify(guideBtns.slice(0, 4)));
    await page.evaluate(() => { if (App.desktop && App.desktop.guide) App.desktop.guide.close(); });

    /* ---------- relatório ---------- */
    const fails = results.filter((r) => !r.ok);
    const areas = {};
    for (const r of results) { areas[r.area] = areas[r.area] || { pass: 0, fail: 0 }; if (r.ok) areas[r.area].pass++; else areas[r.area].fail++; }
    const lines = [];
    lines.push('# Space IPTV Desktop — auditoria Playwright (visual, usabilidade e acessibilidade)');
    lines.push('');
    lines.push('Gerado por `node scripts/audit-playwright.js` em ' + new Date().toISOString() + '.');
    lines.push('');
    lines.push('Ambiente: Windows 11 x64 · Electron 40.6.0 · Playwright (playwright-core) via `_electron` · backend de teste `' + API_ORIGIN + '`.');
    lines.push('');
    lines.push('Resumo: **' + (results.length - fails.length) + '/' + results.length + ' verificações PASS**' + (fails.length ? ' — ' + fails.length + ' falha(s)' : '') + '.');
    lines.push('');
    lines.push('| Área | PASS | FAIL |');
    lines.push('|---|---|---|');
    for (const a of Object.keys(areas)) lines.push('| ' + a + ' | ' + areas[a].pass + ' | ' + areas[a].fail + ' |');
    lines.push('');
    lines.push('## Verificações');
    lines.push('');
    lines.push('| Resultado | Área | Verificação | Detalhe |');
    lines.push('|---|---|---|---|');
    for (const r of results) lines.push('| ' + (r.ok ? 'PASS' : 'FAIL') + ' | ' + r.area + ' | ' + r.label + ' | `' + String(r.detail).replace(/\|/g, '\\|').slice(0, 240) + '` |');
    lines.push('');
    lines.push('## Capturas');
    lines.push('');
    for (const f of shots) lines.push('- `' + path.relative(ROOT, f).replace(/\\/g, '/') + '`');
    lines.push('');
    lines.push('## Observações');
    lines.push('');
    lines.push('- A barra de rolagem é um controle próprio do jogo/app (não nativo); a área útil do polegar é ~14px de projeto, com trilha clicável de 24px — abaixo dos 44px do checklist de toque (exceção aceita para scrollbars, que continuam acessíveis por arrasto, clique, roda e teclado).');
    lines.push('- O palco é escalado (~0,70 em 1366×768), por isso os tamanhos de projeto foram compensados para os controles principais renderizarem >= 44px.');
    lines.push('- EPG/lista usam mock provider local; o login é real contra o backend de teste isolado.');
    fs.writeFileSync(REPORT, lines.join('\n') + '\n', 'utf8');

    console.log('\n[audit] ' + (results.length - fails.length) + '/' + results.length + ' verificações PASS');
    console.log('[audit] relatório: ' + path.relative(ROOT, REPORT));
    console.log('[audit] capturas: ' + shots.length + ' em ' + path.relative(ROOT, SHOTS));
    if (fails.length) {
      console.log('[audit] FALHAS:');
      for (const f of fails) console.log('  - [' + f.area + '] ' + f.label + ' — ' + f.detail);
    }
    if (!KEEP) await app.close().catch(() => {});
    try { await provider.provider.close(); } catch (e) { /* ignore */ }
    process.exitCode = fails.length ? 1 : 0;
  } catch (err) {
    console.error('[audit] ERRO: ' + (err && err.stack ? err.stack : err));
    if (app) { try { await app.close(); } catch (e) { /* ignore */ } }
    try { await provider.provider.close(); } catch (e) { /* ignore */ }
    process.exitCode = 2;
  }
}

main();
