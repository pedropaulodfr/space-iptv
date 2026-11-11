// DESENVOLVIMENTO: poe um texto na area de transferencia do aparelho para testar
// o botao "Colar" dos formularios.
//
// Por que existe: a WebView so deixa copiar (document.execCommand('copy')) quando
// o comando parte de um gesto de verdade do usuario. Um clique injetado pelo
// protocolo de depuracao conta como gesto; um clique feito por JavaScript nao.
//
// Pre-requisito: adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
//
// Uso: node tools\clip.js "https://exemplo.com/lista.m3u"
const http = require('http');
const WS = require('./node_modules/ws');

const PORT = Number(process.env.CDP_PORT || 9222);
const texto = process.argv.slice(2).join(' ') || 'https://exemplo.com/lista.m3u';

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  const list = JSON.parse(await get('/json/list'));
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('WebView nao encontrada');

  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  function send(method, params) {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    return new Promise((r) => pending.set(mid, r));
  }
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.on('open', r));

  async function ev(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    const res = r.result || {};
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result && res.result.value;
  }

  // 1) um alvo de 1x1 no canto (nao atrapalha a interface) que copia ao ser clicado
  const box = await ev(`(function(){
    var old = document.getElementById('__clip');
    if (old) old.parentNode.removeChild(old);
    var t = document.createElement('textarea');
    t.id = '__clip';
    t.value = ${JSON.stringify(texto)};
    t.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;opacity:.01;border:0;padding:0';
    t.addEventListener('mousedown', function(){
      t.select();
      try { document.execCommand('copy'); window.__copiou = true; } catch (e) { window.__copiou = String(e); }
    });
    document.body.appendChild(t);
    return { x: 8, y: 8 };
  })()`);

  // 2) clique de verdade (o protocolo gera um evento confiavel)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(400);

  const copiou = await ev('window.__copiou === true');
  const lido = await ev('(window.SpaceNative && SpaceNative.clipboard) ? SpaceNative.clipboard() : "(sem bridge)"');
  await ev("(function(){var e=document.getElementById('__clip'); if(e) e.parentNode.removeChild(e); return 1;})()");

  console.log('copiou:  ' + copiou);
  console.log('clipboard do aparelho agora: ' + JSON.stringify(lido));
  ws.close();
  setTimeout(() => process.exit(copiou ? 0 : 2), 80);
})().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });

