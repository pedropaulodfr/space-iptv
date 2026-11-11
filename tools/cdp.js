// DESENVOLVIMENTO: avalia JavaScript dentro da WebView do app via Chrome DevTools Protocol.
// Uso:  node tools\cdp.js "expressao JS"
// Requer: adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>  (ver tools\cdp.ps1)
const http = require('http');
const WS = require('./node_modules/ws');

const expr = process.argv.slice(2).join(' ') || '1+1';
const PORT = Number(process.env.CDP_PORT || 9222);

function targets() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

targets().then((list) => {
  const page = list.find((t) => t.type === 'page') || list[0];
  if (!page) throw new Error('nenhum target de pagina');
  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();

  function send(method, params) {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    return new Promise((res) => pending.set(mid, res));
  }

  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });

  ws.on('open', async () => {
    const r = await send('Runtime.evaluate', {
      expression: '(async function(){try{var __v=(await (' + expr + '));return JSON.stringify({ok:true,value:__v===undefined?null:__v});}catch(e){return JSON.stringify({ok:false,error:String(e&&e.stack||e)});}})()',
      returnByValue: true,
      awaitPromise: true
    });
    const out = r.result && r.result.result && r.result.result.value;
    if (out) {
      const parsed = JSON.parse(out);
      if (parsed.ok) console.log(typeof parsed.value === 'string' ? parsed.value : JSON.stringify(parsed.value, null, 1));
      else { console.log('ERRO: ' + parsed.error); process.exitCode = 2; }
    } else {
      console.log(JSON.stringify(r, null, 1));
      process.exitCode = 3;
    }
    ws.close();
    setTimeout(() => process.exit(), 60);
  });

  ws.on('error', (e) => { console.log('WS erro: ' + e.message); process.exit(4); });
}).catch((e) => { console.log('FALHA: ' + e.message); process.exit(1); });
