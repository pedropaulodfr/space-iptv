// Controle de DESENVOLVIMENTO da pagina na TV via Chrome DevTools Protocol (porta encaminhada 9333).
// uso: node tv.js eval "<js>" | key <codigo>[,<codigo>...] [pausaMs] | shot <arquivo.png> | logs <segundos>
const WebSocket = require('ws'), http = require('http'), fs = require('fs');
const [,, cmd, a1, a2] = process.argv;
http.get('http://localhost:9333/json', r => { let b = ''; r.on('data', c => b += c); r.on('end', () => run(JSON.parse(b)[0].webSocketDebuggerUrl)); }).on('error', e => { console.log('sem conexao:', e.message); process.exit(1); });
function run(url) {
  const ws = new WebSocket(url); let id = 0; const pend = {};
  const send = (method, params) => new Promise(res => { const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  ws.on('message', m => { const d = JSON.parse(m); if (d.id && pend[d.id]) pend[d.id](d.result || d.error); else if (cmd === 'logs' && d.method === 'Runtime.consoleAPICalled') console.log('[' + d.params.type + ']', d.params.args.map(a => a.value !== undefined ? a.value : a.description).join(' ')); else if (cmd === 'logs' && d.method === 'Runtime.exceptionThrown') console.log('[EXC]', JSON.stringify(d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description)); });
  ws.on('open', async () => {
    if (cmd === 'eval') { const r = await send('Runtime.evaluate', { expression: a1, awaitPromise: true, returnByValue: true }); console.log(r.result ? JSON.stringify(r.result.value) : JSON.stringify(r)); if (r.exceptionDetails) console.log('EXC', JSON.stringify(r.exceptionDetails.exception.description)); }
    if (cmd === 'key') { for (const k of a1.split(',')) { const c = +k; await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: c, nativeVirtualKeyCode: c }); await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: c, nativeVirtualKeyCode: c }); await new Promise(r => setTimeout(r, +a2 || 250)); } console.log('ok'); }
    if (cmd === 'shot') { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(a1, Buffer.from(r.data, 'base64')); console.log('salvo', a1); }
    if (cmd === 'logs') { await send('Runtime.enable'); setTimeout(() => process.exit(0), (+a1 || 10) * 1000); return; }
    process.exit(0);
  });
}
