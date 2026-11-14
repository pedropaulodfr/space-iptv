#!/usr/bin/env node
/* Runner Node das Pages Functions do Space IPTV (zero dependencias).
 *
 * Por que existe: `wrangler pages dev` depende do runtime nativo `workerd`, que
 * nao sobe em alguns ambientes restritos (ele tenta criar diretorios fora do
 * projeto e recebe "acesso negado"). Este runner executa OS MESMOS modulos de
 * `functions/` em Node 18+, com Request/Response/fetch/crypto nativos, servindo
 * `dist/web` e respeitando `_routes.json` e `_middleware.js`.
 *
 * O contrato do handler e o das Pages Functions: export function onRequest(ctx)
 * com ctx { request, env, params, data, next, waitUntil }.
 *
 * Uso:
 *   node tools/pages-runner.js [--dir dist/web] [--port 8788]
 *   # le as variaveis de .dev.vars (se existir) e imprime a URL
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
};

/* ---------- rotas ---------- */

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesPattern(pattern, pathname) {
  if (pattern === pathname) return true;
  if (pattern.indexOf('*') < 0) return false;
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$');
  return re.test(pathname);
}

function loadRoutes(dir) {
  const file = path.join(dir, '_routes.json');
  if (!fs.existsSync(file)) return { include: ['/*'], exclude: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      include: Array.isArray(parsed.include) ? parsed.include : ['/*'],
      exclude: Array.isArray(parsed.exclude) ? parsed.exclude : []
    };
  } catch (e) {
    return { include: ['/*'], exclude: [] };
  }
}

function shouldInvoke(routes, pathname) {
  for (let i = 0; i < routes.exclude.length; i++) {
    if (matchesPattern(routes.exclude[i], pathname)) return false;
  }
  for (let i = 0; i < routes.include.length; i++) {
    if (matchesPattern(routes.include[i], pathname)) return true;
  }
  return false;
}

/* Coleta as rotas das Functions: [caminho]/index.js, [caminho].js e [param].js */
function collectFunctions(functionsDir) {
  const out = [];
  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (entry.name === '_middleware.js') continue;
      if (entry.name.startsWith('_')) continue;
      const abs = path.join(dir, entry.name);
      const relNext = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { walk(abs, relNext); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const segments = relNext.replace(/\.js$/, '').split('/');
      if (segments.length > 1 && segments[segments.length - 1] === 'index') segments.pop();
      out.push({ segments: segments, file: abs });
    }
  }
  walk(functionsDir, '');
  return out;
}

function matchFunction(routes, pathname) {
  const parts = pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  const candidates = [];
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    let dynamic = 0;
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segments[i];
      const m = /^\[([^\]]+)\]$/.exec(seg);
      if (m) {
        dynamic++;
        try { params[m[1]] = decodeURIComponent(parts[i]); } catch (e) { params[m[1]] = parts[i]; }
        continue;
      }
      if (seg !== parts[i]) { ok = false; break; }
    }
    if (ok) candidates.push({ file: route.file, params: params, dynamic: dynamic });
  }
  candidates.sort(function (a, b) { return a.dynamic - b.dynamic; });
  return candidates[0] || null;
}

/* ---------- estático ---------- */

function safeFilePath(baseDir, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { return null; }
  if (rel.indexOf('\0') >= 0) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    if (part === '.' || part === '..') return null;
    if (part.indexOf(':') >= 0) return null;
  }
  const abs = path.resolve(baseDir, parts.join(path.sep));
  if (!abs.startsWith(baseDir + path.sep)) return null;
  return abs;
}

async function staticResponse(dir, pathname, method) {
  const file = safeFilePath(dir, pathname);
  if (!file) return new Response('Caminho inválido.', { status: 400 });
  let stat;
  try { stat = await fs.promises.stat(file); } catch (e) { stat = null; }
  if (!stat || !stat.isFile()) {
    return new Response('Não encontrado.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Cache-Control': 'no-store'
  };
  if (method === 'HEAD') return new Response(null, { status: 200, headers: headers });
  const body = await fs.promises.readFile(file);
  return new Response(body, { status: 200, headers: headers });
}

/* ---------- execução ---------- */

async function loadModule(file) {
  return import(pathToFileURL(file).href + '?v=' + Date.now());
}

function createContext(request, env, params, sharedData) {
  const waits = [];
  return {
    request: request,
    env: env || {},
    params: params || {},
    data: sharedData || {},
    waitUntil: function (p) { waits.push(Promise.resolve(p)); },
    _flush: function () { return Promise.all(waits.map(function (p) { return p.catch(function () {}); })); }
  };
}

function createPagesServer(options) {
  const dir = path.resolve(ROOT, options.dir || 'dist/web');
  const functionsDir = path.resolve(ROOT, options.functionsDir || 'functions');
  const env = options.env || {};
  const routes = loadRoutes(dir);
  const functions = collectFunctions(functionsDir);
  const middlewareFile = path.join(functionsDir, '_middleware.js');
  const hasMiddleware = fs.existsSync(middlewareFile);
  const log = options.log || [];

  async function dispatch(request, pathname) {
    const match = matchFunction(functions, pathname);
    const staticOnly = function () { return staticResponse(dir, pathname, request.method); };

    let handler = null;
    let params = {};
    if (match) {
      const mod = await loadModule(match.file);
      handler = mod.onRequest;
      params = match.params;
      if (typeof handler !== 'function') {
        throw new Error('a rota ' + path.relative(ROOT, match.file) + ' nao exporta onRequest');
      }
    }

    const sharedData = {};
    const context = createContext(request, env, params, sharedData);
    let nextCalls = 0;
    const next = async function () {
      nextCalls++;
      if (handler) return handler(context);
      return staticOnly();
    };

    let response;
    if (hasMiddleware) {
      const mw = await loadModule(middlewareFile);
      if (typeof mw.onRequest !== 'function') throw new Error('_middleware.js sem onRequest');
      const mwContext = createContext(request, env, {}, sharedData);
      mwContext.next = next;
      response = await mw.onRequest(mwContext);
      await mwContext._flush();
    } else if (handler) {
      response = await handler(context);
    } else {
      response = await staticOnly();
    }
    await context._flush();
    return response;
  }

  const server = http.createServer(function (req, res) {
    const host = req.headers.host || '127.0.0.1';
    const url = new URL(req.url, 'http://' + host);
    const pathname = url.pathname;

    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () { body = Buffer.concat(chunks); go(); });
      return;
    }
    go();

    function go() {
      const headers = new Headers();
      for (const key in req.headers) {
        if (key === 'host' || key === 'connection') continue;
        const value = req.headers[key];
        if (Array.isArray(value)) value.forEach(function (v) { headers.append(key, v); });
        else headers.set(key, value);
      }
      const init = {
        method: req.method,
        headers: headers,
        body: body && body.length ? body : undefined,
        redirect: 'manual'
      };
      const request = new Request(url.href, init);

      const run = shouldInvoke(routes, pathname) || pathname === '/';
      const promise = run
        ? dispatch(request, pathname)
        : staticResponse(dir, pathname, req.method);

      promise.then(async function (response) {
        const out = {};
        response.headers.forEach(function (value, key) {
          if (key.toLowerCase() === 'set-cookie') return;
          out[key] = value;
        });
        const cookies = typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
        if (cookies.length) out['set-cookie'] = cookies;
        res.writeHead(response.status, out);
        const buf = Buffer.from(await response.arrayBuffer());
        res.end(buf);
        if (options.onResponse) {
          options.onResponse({
            method: req.method,
            path: pathname,
            status: response.status,
            headers: out
          });
        }
      }).catch(function (err) {
        log.push('erro em ' + pathname + ': ' + (err && err.stack ? err.stack : err));
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ error: 'runner_error', message: String(err && err.message ? err.message : err) }));
      });
    }
  });

  return {
    dir: dir,
    routes: routes,
    log: log,
    listen: function (port) {
      return new Promise(function (resolve, reject) {
        server.once('error', reject);
        server.listen(port || 0, '127.0.0.1', function () {
          const addr = server.address();
          resolve('http://127.0.0.1:' + addr.port);
        });
      });
    },
    close: function () {
      return new Promise(function (resolve) {
        server.close(function () { resolve(); });
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    }
  };
}

module.exports = { createPagesServer: createPagesServer, shouldInvoke: shouldInvoke, matchFunction: matchFunction };

/* ---------- CLI ---------- */

function loadDevVars(root) {
  const out = {};
  const file = path.join(root, '.dev.vars');
  if (!fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let dir = 'dist/web';
  let port = 8788;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') dir = args[++i];
    else if (args[i] === '--port') port = Number(args[++i]) || port;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Uso: node tools/pages-runner.js [--dir dist/web] [--port 8788]');
      process.exit(0);
    }
  }
  const env = Object.assign(loadDevVars(ROOT), process.env);
  const server = createPagesServer({ dir: dir, env: env });
  server.listen(port).then(function (url) {
    console.log('Space IPTV (Pages Functions via Node) em ' + url);
    console.log('  estáticos: ' + server.dir);
    console.log('  rotas de Function: ' + JSON.stringify(server.routes));
    console.log('  banco: ' + (env.NEON_APP_URL ? new URL(env.NEON_APP_URL).host : '(NEON_APP_URL vazio)'));
  }).catch(function (e) {
    console.error('Falha ao subir: ' + e.message);
    process.exitCode = 1;
  });
}
