// DESENVOLVIMENTO: captura o que a WebView do app esta realmente pintando (via CDP).
// Uso:  node tools\cdp-shot.js saida.png
const http = require('http');
const fs = require('fs');
const WS = require('./node_modules/ws');

const out = process.argv[2] || 'shot.png';
const PORT = Number(process.env.CDP_PORT || 9222);

http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
  let d = '';
  res.setEncoding('utf8');
  res.on('data', (c) => { d += c; });
  res.on('end', () => {
    const page = (JSON.parse(d) || []).find((t) => t.type === 'page');
    if (!page) { console.log('sem target'); return process.exit(1); }
    const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    const send = (method, params) => {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
      return new Promise((r) => pending.set(mid, r));
    };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    ws.on('open', async () => {
      await send('Page.enable');
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const data = r.result && r.result.data;
      if (!data) { console.log('falha na captura: ' + JSON.stringify(r).slice(0, 300)); process.exit(2); }
      fs.writeFileSync(out, Buffer.from(data, 'base64'));
      console.log('capturado: ' + out + ' (' + fs.statSync(out).size + ' bytes)');
      ws.close();
      setTimeout(() => process.exit(), 50);
    });
    ws.on('error', (e) => { console.log('ws erro: ' + e.message); process.exit(4); });
  });
}).on('error', (e) => { console.log('http erro: ' + e.message); process.exit(1); });
