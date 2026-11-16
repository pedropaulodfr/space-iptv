/* Helpers comuns dos testes do Space IPTV Desktop (qa-release).
 *
 * Sem dependências externas. Tudo em `test/helpers/` é importado pelos testes;
 * estes arquivos não devem ter efeito colateral ao serem carregados (o runner
 * do Node pode executá-los como "arquivo de teste" vazio — nada acontece).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const DESKTOP = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(DESKTOP, '..');
const TMP_ROOT = path.join(DESKTOP, 'test', 'tmp');

/** Caminho absoluto relativo a desktop/. */
function desktopPath() {
  return path.join.apply(path, [DESKTOP].concat(Array.prototype.slice.call(arguments)));
}

/** Caminho absoluto relativo à raiz do repo. */
function repoPath() {
  return path.join.apply(path, [REPO].concat(Array.prototype.slice.call(arguments)));
}

/**
 * Cria uma pasta temporária exclusiva em `test/tmp` e registra limpeza no `t`
 * do node:test (`t.after`). Fora do node:test devolve sem registrar.
 * @param {object|string} t contexto do node:test (ou nome, quando sem t)
 * @param {string} name
 * @returns {string} caminho absoluto
 */
function makeTmp(t, name) {
  let ctx = t;
  let label = name;
  if (typeof t === 'string') { label = t; ctx = null; }
  const dir = path.join(TMP_ROOT, (label || 'tmp') + '-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  if (ctx && typeof ctx.after === 'function') {
    ctx.after(function () { rmrf(dir); });
  }
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/**
 * Carrega um módulo opcional. Devolve null quando o arquivo ainda não existe,
 * para que os testes possam marcar `skip` em vez de quebrar a suíte.
 * @param {string} rel caminho relativo a desktop/ (ex.: 'src/main/hls.js')
 */
function tryRequire(rel) {
  const file = path.isAbsolute(rel) ? rel : path.join(DESKTOP, rel);
  if (!fs.existsSync(file)) return null;
  // eslint-disable-next-line import/no-dynamic-require
  return require(file);
}

/** Verdadeiro quando o módulo opcional já foi entregue. */
function hasModule(rel) {
  const file = path.isAbsolute(rel) ? rel : path.join(DESKTOP, rel);
  return fs.existsSync(file);
}

/** Motivo de skip padronizado. */
function skipReason(rel) {
  return 'aguardando módulo ' + rel;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * Sobe um http.Server local (127.0.0.1, porta efêmera).
 * @param {(req:import('http').IncomingMessage, res:import('http').ServerResponse)=>void} handler
 * @returns {Promise<{server:import('http').Server, port:number, url:string, close:()=>Promise<void>}>}
 */
function listen(handler) {
  return new Promise(function (resolve, reject) {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      resolve({
        server: server,
        port: port,
        url: 'http://127.0.0.1:' + port,
        close: function () {
          return new Promise(function (res) {
            try { server.close(function () { res(); }); } catch (e) { res(); }
            try { server.closeAllConnections && server.closeAllConnections(); } catch (e) { /* ignore */ }
          });
        }
      });
    });
  });
}

/**
 * Requisição HTTP simples (sem redirecionar automaticamente).
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:string|Buffer, timeoutMs?:number}} [opts]
 * @returns {Promise<{status:number, headers:object, body:Buffer, text:string, json:()=>any}>}
 */
function request(url, opts) {
  const o = opts || {};
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: o.method || 'GET',
      headers: o.headers || {},
      timeout: o.timeoutMs || 15000
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body,
          text: body.toString('utf8'),
          json: function () { return JSON.parse(body.toString('utf8')); }
        });
      });
      res.on('error', reject);
    });
    req.on('timeout', function () { req.destroy(new Error('timeout na requisição de teste')); });
    req.on('error', reject);
    if (o.body != null) req.write(o.body);
    req.end();
  });
}

/** Porta que estava livre (para simular "sem upstream"/conexão recusada). */
async function freePort() {
  const s = await listen(function (req, res) { res.end('x'); });
  const port = s.port;
  await s.close();
  return port;
}

/** Espera uma condição virar verdadeira (polling curto). */
async function waitFor(fn, opts) {
  const o = opts || {};
  const timeout = o.timeoutMs || 5000;
  const interval = o.intervalMs || 25;
  const started = Date.now();
  for (;;) {
    let value;
    try { value = await fn(); } catch (e) { value = false; }
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor: condição não atingida em ' + timeout + 'ms');
    await sleep(interval);
  }
}

/** Escreve JSON (cria pastas). */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

/** Lê JSON (erro claro). */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Garante que o objeto tem apenas texto/chaves esperadas (helper de asserção). */
function listFilesRecursive(dir) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  })(dir);
  return out.sort();
}

module.exports = {
  DESKTOP: DESKTOP,
  REPO: REPO,
  TMP_ROOT: TMP_ROOT,
  desktopPath: desktopPath,
  repoPath: repoPath,
  makeTmp: makeTmp,
  rmrf: rmrf,
  tryRequire: tryRequire,
  hasModule: hasModule,
  skipReason: skipReason,
  sleep: sleep,
  listen: listen,
  request: request,
  freePort: freePort,
  waitFor: waitFor,
  writeJson: writeJson,
  readJson: readJson,
  listFilesRecursive: listFilesRecursive
};
