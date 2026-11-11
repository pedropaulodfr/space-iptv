// Gera as imagens da Samsung Apps TV Seller Office a partir do app rodando no navegador.
// Uso (o mock-server e o Edge com --remote-debugging-port=9222 precisam estar rodando):
//   node tools\make-store-images.js
// Saida: dist\tv\store\images\
'use strict';

const WebSocket = require('./node_modules/ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'dist', 'tv', 'store', 'images');
const ART = path.join(__dirname, '_art');
const CDP = 9222;

function rm(dir) { if (fs.existsSync(dir)) fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f))); }
function mkdirp(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

/* servidor estatico para a arte dos icones */
function serveArt() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.css': 'text/css' };
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/art.html';
    const f = path.join(ART, path.normalize(p).replace(/^[\\/]+/, ''));
    if (!f.startsWith(ART) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  }).listen(8091);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pend = {};
    ws.on('message', m => { const d = JSON.parse(m); if (d.id && pend[d.id]) { pend[d.id](d.result || d.error); delete pend[d.id]; } });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      send: (method, params) => new Promise(res => { const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method, params: params || {} })); }),
      close: () => ws.close()
    }));
  });
}

const espera = ms => new Promise(r => setTimeout(r, ms));
const rel = f => path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/');

async function main() {
  mkdirp(OUT); rm(OUT);
  const art = serveArt();                                  // arte em 8091
  const tabs = (await getJson('http://127.0.0.1:' + CDP + '/json')).filter(t => t.type === 'page');
  const tab = tabs.filter(t => (t.url || '').indexOf('8080') >= 0)[0] || tabs[0];
  if (!tab) throw new Error('nenhuma aba no Edge');
  const cdp = await connect(tab.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r && r.result ? r.result.value : undefined;
  };
  const view = (w, h) => cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const shot = async (nome, opts) => {
    const r = await cdp.send('Page.captureScreenshot', Object.assign({ captureBeyondViewport: false }, opts || {}));
    if (!r || !r.data) throw new Error('falha no screenshot ' + nome);
    const buf = Buffer.from(r.data, 'base64');
    fs.writeFileSync(path.join(OUT, nome), buf);
    console.log('  ' + nome.padEnd(34) + (buf.length / 1024).toFixed(0).padStart(5) + ' KB   ' + rel(path.join(OUT, nome)));
    return buf.length;
  };

  console.log('\n== app: preparando a lista de demonstração ==');
  await view(1920, 1080);
  /* a aba pode ter ficado na pagina de arte numa execucao anterior: volta para o app */
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8080/' });
  let pronto = false;
  for (let i = 0; i < 25; i++) {
    await espera(400);
    try { if (await ev('typeof App !== "undefined" && !!App.lists && !!App.shell')) { pronto = true; break; } } catch (e) { /* ainda carregando */ }
  }
  if (!pronto) throw new Error('o app nao carregou em http://127.0.0.1:8080/');
  await espera(600);
  const seed = await ev(`(function(){
    if (!App || !App.lists) return 'app nao carregado';
    var ex = App.lists.all().filter(function(l){ return l.name === 'Demonstração'; })[0];
    if (ex) {
      App.lists.setActive(ex.id);
      /* sempre rebusca: o catalogo em cache pode ser de antes das artes do mock */
      return App.catalog.refresh(ex).then(function(){ return 'pronto'; }, function(e){ return 'erro: ' + (e && (e.code || e.message)); });
    }
    return App.lists.save({ name: 'Demonstração', type: 'xtream', server: 'http://127.0.0.1:8080', user: 'test', pass: 'test' })
      .then(function(rec){ App.lists.setActive(rec.id); return App.catalog.refresh(rec); })
      .then(function(){ return 'pronto'; }, function(e){ return 'erro: ' + (e && (e.message || e.code)); });
  })()`);
  console.log('  seed: ' + seed);
  await espera(1200);
  const info = await ev("JSON.stringify({ live: App.catalog.data.live.length, movie: App.catalog.data.movie.length, series: App.catalog.data.series.length })");
  console.log('  catálogo: ' + info);

  console.log('\n== 4 capturas (1920x1080 JPG) ==');
  await ev("App.shell.goto('home')"); await espera(1600);
  await shot('01-inicio.jpg', { format: 'jpeg', quality: 92 });

  await ev("App.shell.goto('live')"); await espera(8000);           // espera a saúde dos canais
  await shot('02-tv-ao-vivo.jpg', { format: 'jpeg', quality: 92 });

  await ev("App.shell.goto('series'); var it = App.catalog.items('series','*')[0]; App.actions.open(it);"); await espera(2600);
  await shot('03-serie.jpg', { format: 'jpeg', quality: 92 });

  await ev("App.nav.dispatch('back'); App.shell.goto('settings');"); await espera(1200);
  await shot('04-configuracoes.jpg', { format: 'jpeg', quality: 92 });

  console.log('\n== ícones e background (arte) ==');
  const artUrl = 'http://127.0.0.1:8091/art.html';
  const irArte = async (v, w, h) => {
    await view(w, h);
    await cdp.send('Page.navigate', { url: artUrl + '?v=' + v });
    await espera(900);
    await ev('document.fonts.ready.then(function(){ return document.fonts.check("800 112px Orbitron"); })');
    await espera(250);
  };

  await irArte('logo', 1920, 1080);
  /* fundo transparente de verdade -> PNG 32 bits (RGBA) */
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await shot('05-icone-logo-1920x1080.png', { format: 'png', omitBackground: true });
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {});

  await irArte('bg', 1920, 1080);
  /* a loja aceita PNG(RGB) ou JPG ate 300 KB; o gradiente com estrelas passa de 300 KB em PNG */
  await shot('06-icone-fundo-1920x1080.jpg', { format: 'jpeg', quality: 90 });

  await irArte('icon', 512, 423);
  await shot('07-icone-512x423.png', { format: 'png' });                                // RGB opaco

  await irArte('hero', 1920, 1080);
  await shot('08-background-ficha.jpg', { format: 'jpeg', quality: 92 });               // background da ficha

  cdp.close();
  art.close();
  console.log('\npronto: ' + rel(OUT));
}

main().catch(e => { console.error('ERRO: ' + e.message); process.exit(1); });
