#!/usr/bin/env node
/* tools/test-auth.js — testes de aceite de login, admin, gate e sincronização.
 *
 * ZERO dependências. Executa as Pages Functions reais (tools/pages-runner.js)
 * contra o Postgres do Neon configurado em `.dev.vars`, usando o mesmo papel de
 * aplicação (space_app) e o mesmo segredo de sessão. Cria e apaga contas de teste
 * no domínio @e2e.local — nunca toca em contas reais.
 *
 * Uso:
 *   node web/build.js && node tools/test-auth.js
 *   node tools/test-auth.js --filter login
 *   node tools/test-auth.js --json
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const fixtures = require('./db-fixtures.js');
const { createPagesServer } = require('./pages-runner.js');

const argv = process.argv.slice(2);
const flags = { json: false, filter: '', keep: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--json') flags.json = true;
  else if (argv[i] === '--keep') flags.keep = true;
  else if (argv[i] === '--filter') flags.filter = argv[++i] || '';
  else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('Uso: node tools/test-auth.js [--filter texto] [--json] [--keep]');
    process.exit(0);
  }
}

const results = [];
let currentGroup = '';

function group(name) { currentGroup = name; }

function record(name, ok, detail) {
  if (flags.filter && (name + ' ' + currentGroup).toLowerCase().indexOf(flags.filter.toLowerCase()) < 0) return;
  results.push({ group: currentGroup, name: name, status: ok ? 'pass' : 'fail', detail: detail || '' });
}

function check(name, ok, detail) { record(name, !!ok, detail); }

function checkEq(name, actual, expected) {
  const ok = actual === expected;
  record(name, ok, ok ? '' : 'esperado ' + JSON.stringify(expected) + ', veio ' + JSON.stringify(actual));
}

/* ---------- cliente HTTP com cookie jar ---------- */

function createClient(base) {
  const jar = {};
  return {
    jar: jar,
    cookies: function () {
      const parts = [];
      for (const name in jar) if (jar[name]) parts.push(name + '=' + jar[name]);
      return parts.join('; ');
    },
    setCookie: function (name, value) { jar[name] = value; },
    clear: function () { for (const k in jar) delete jar[k]; },
    call: function (pathname, opts) {
      const o = opts || {};
      const baseUrl = new URL(base);
      const headers = Object.assign({}, o.headers || {});
      const cookie = o.cookie !== undefined ? o.cookie : this.cookies();
      if (cookie) headers.Cookie = cookie;
      let body;
      if (o.body !== undefined) {
        body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      }
      return new Promise(function (resolve, reject) {
        const req = http.request({
          host: baseUrl.hostname,
          port: Number(baseUrl.port || 80),
          method: o.method || 'GET',
          path: pathname,
          headers: headers,
          timeout: o.timeout || 15000
        }, function (res) {
          const chunks = [];
          res.on('data', function (c) { chunks.push(c); });
          res.on('end', function () {
            const text = Buffer.concat(chunks).toString('utf8');
            const setCookie = res.headers['set-cookie'] || [];
            setCookie.forEach(function (line) {
              const pair = String(line).split(';')[0];
              const eq = pair.indexOf('=');
              if (eq < 0) return;
              jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
            });
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
            resolve({ status: res.statusCode, headers: res.headers, setCookie: setCookie, body: text, json: json });
          });
        });
        req.on('timeout', function () { req.destroy(new Error('timeout')); });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
      });
    }
  };
}

function headerOf(res, name) {
  return res.headers[String(name).toLowerCase()] || '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Espelha functions/_lib/token.js para forjar tokens nos testes. */
function signAccess(payload, secret, expOffsetSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({ i: now, e: now + (expOffsetSeconds == null ? 900 : expOffsetSeconds) }, payload);
  const encoded = b64url(Buffer.from(JSON.stringify(body), 'utf8'));
  const sig = crypto.createHmac('sha256', secret).update('v1.' + encoded).digest();
  return 'v1.' + encoded + '.' + b64url(sig);
}

/* ---------- cenário ---------- */

const ADMIN = { email: 'admin@e2e.local', password: 'senha-de-teste', name: 'Admin', role: 'admin' };
const USER = { email: 'user@e2e.local', password: 'senha-de-teste', name: 'Usuário', role: 'user' };

async function login(client, email, password) {
  return client.call('/api/auth/login', { method: 'POST', body: { email: email, password: password } });
}

async function main() {
  const env = fixtures.loadEnv({ AUTH_RECOVERY_ENABLED: 'false' });
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) {
    console.error('AUTH_SECRET ausente/curto no .dev.vars (mínimo 32 caracteres).');
    process.exitCode = 2;
    return;
  }
  if (!env.NEON_APP_URL) {
    console.error('NEON_APP_URL ausente no .dev.vars.');
    process.exitCode = 2;
    return;
  }

  await fixtures.cleanup(env);
  const adminId = await fixtures.seedUser(env, ADMIN);
  const userId = await fixtures.seedUser(env, USER);

  const runner = createPagesServer({ dir: 'dist/web', env });
  const base = await runner.listen(0);

  const anon = createClient(base);
  const admin = createClient(base);
  const user = createClient(base);

  try {
    /* ---------------- gate ---------------- */
    group('gate');
    const home = await anon.call('/');
    checkEq('GET / sem cookie responde 302', home.status, 302);
    checkEq('Location aponta para /login.html?next=%2F', headerOf(home, 'location'), '/login.html?next=%2F');
    const pullAnon = await anon.call('/api/sync/pull');
    checkEq('GET /api/sync/pull sem cookie responde 401', pullAnon.status, 401);
    check('401 devolve error unauthorized', !!(pullAnon.json && pullAnon.json.error === 'unauthorized'), pullAnon.body.slice(0, 120));
    const loginPage = await anon.call('/login.html');
    checkEq('GET /login.html sem cookie responde 200', loginPage.status, 200);
    check('login.html tem formulário e CSP anti-clickjacking', loginPage.body.indexOf('id="login-form"') >= 0 &&
      String(headerOf(loginPage, 'content-security-policy')).indexOf("frame-ancestors 'none'") >= 0);
    check('login.html não carrega tv/js nem web/js do app',
      loginPage.body.indexOf('tv/js/') < 0 && loginPage.body.indexOf('web/js/shell.js') < 0);
    checkEq('GET /web/js/shell.js sem cookie responde 200', (await anon.call('/web/js/shell.js')).status, 200);
    checkEq('GET /index.html sem cookie responde 302', (await anon.call('/index.html')).status, 302);

    /* ---------------- login ---------------- */
    group('login');
    const badUser = await anon.call('/api/auth/login', { method: 'POST', body: { email: 'ninguem@e2e.local', password: 'x' } });
    const badPass = await anon.call('/api/auth/login', { method: 'POST', body: { email: USER.email, password: 'errada' } });
    checkEq('login com conta inexistente responde 401', badUser.status, 401);
    checkEq('login com senha errada responde 401', badPass.status, 401);
    check('os dois corpos são idênticos (sem enumeração)', badUser.body === badPass.body, badUser.body + ' / ' + badPass.body);

    const okAdmin = await login(admin, ADMIN.email, ADMIN.password);
    checkEq('login do admin responde 200', okAdmin.status, 200);
    check('login devolve user com role', !!(okAdmin.json && okAdmin.json.user && okAdmin.json.user.role === 'admin'),
      JSON.stringify(okAdmin.json));
    const atCookie = (okAdmin.setCookie || []).filter(function (c) { return String(c).indexOf('sp_at=') === 0; })[0] || '';
    const rtCookie = (okAdmin.setCookie || []).filter(function (c) { return String(c).indexOf('sp_rt=') === 0; })[0] || '';
    check('cookie sp_at é HttpOnly', /HttpOnly/i.test(atCookie), atCookie.slice(0, 60));
    check('cookie sp_at é SameSite=Lax', /SameSite=Lax/i.test(atCookie));
    check('cookie sp_at tem Path=/', /Path=\//i.test(atCookie));
    check('cookie sp_rt existe', !!rtCookie);

    const homeLogged = await admin.call('/');
    checkEq('GET / com cookie responde 200', homeLogged.status, 200);
    check('HTML autenticado tem id="stage"', homeLogged.body.indexOf('id="stage"') >= 0);
    check('HTML autenticado tem no-store e Vary: Cookie',
      /no-store/.test(headerOf(homeLogged, 'cache-control')) && /cookie/i.test(headerOf(homeLogged, 'vary')));
    check('HTML autenticado tem CSP', String(headerOf(homeLogged, 'content-security-policy')).indexOf("default-src 'self'") >= 0);

    const sessionOk = await admin.call('/api/auth/session');
    checkEq('GET /api/auth/session com cookie responde 200', sessionOk.status, 200);
    check('sessão devolve e-mail e papel', !!(sessionOk.json && sessionOk.json.user &&
      sessionOk.json.user.role === 'admin' && sessionOk.json.user.email === ADMIN.email), JSON.stringify(sessionOk.json));

    /* ---------------- logout ---------------- */
    const viewer = createClient(base);
    await login(viewer, USER.email, USER.password);
    checkEq('POST /api/auth/logout responde 204', (await viewer.call('/api/auth/logout', { method: 'POST', body: {} })).status, 204);
    checkEq('GET / depois do logout volta a 302', (await viewer.call('/')).status, 302);

    /* ---------------- token forjado ---------------- */
    group('token');
    const realLogin = await login(createClient(base), USER.email, USER.password);
    const realToken = (realLogin.setCookie || []).filter(function (c) { return String(c).indexOf('sp_at=') === 0; })[0]
      .split(';')[0].split('=').slice(1).join('=');

    const forged = createClient(base);
    forged.setCookie('sp_at', realToken.slice(0, -3) + 'AAA');
    checkEq('token com assinatura alterada responde 302', (await forged.call('/')).status, 302);

    forged.clear();
    forged.setCookie('sp_at', 'v1.abc.def');
    checkEq('token malformado responde 401 na API', (await forged.call('/api/sync/pull')).status, 401);

    forged.clear();
    forged.setCookie('sp_at', signAccess({ u: userId, r: 'user', s: crypto.randomUUID() }, env.AUTH_SECRET, -60));
    checkEq('token expirado responde 302', (await forged.call('/')).status, 302);

    forged.clear();
    forged.setCookie('sp_at', signAccess({ u: userId, r: 'admin', s: crypto.randomUUID() }, 'segredo-errado-de-32-caracteres!!', 900));
    checkEq('token assinado com outro segredo é recusado', (await forged.call('/api/admin/users')).status, 401);

    /* ---------------- open redirect ---------------- */
    group('open redirect');
    for (const bad of ['//evil.com', 'https://evil.com', '/%2F%2Fevil.com', '/\\evil.com']) {
      const r = await admin.call('/login.html?next=' + encodeURIComponent(bad));
      checkEq('next=' + bad + ' redireciona para /', r.status + ' ' + headerOf(r, 'location'), '302 /');
    }
    const goodNext = await admin.call('/login.html?next=' + encodeURIComponent('/?x=1'));
    checkEq('next relativo válido é respeitado', headerOf(goodNext, 'location'), '/?x=1');

    /* ---------------- admin: autorização ---------------- */
    group('admin');
    checkEq('login do usuário comum responde 200', (await login(user, USER.email, USER.password)).status, 200);
    checkEq('GET /api/admin/users como usuário comum responde 403', (await user.call('/api/admin/users')).status, 403);
    const listAsAdmin = await admin.call('/api/admin/users');
    checkEq('GET /api/admin/users como admin responde 200', listAsAdmin.status, 200);
    check('lista devolve users + total', !!(listAsAdmin.json && Array.isArray(listAsAdmin.json.users) &&
      typeof listAsAdmin.json.total === 'number'), JSON.stringify(listAsAdmin.json && listAsAdmin.json.total));

    /* ---------------- admin: ciclo de vida ---------------- */
    const created = await admin.call('/api/admin/users', {
      method: 'POST', body: { name: 'Novo Usuário', email: 'novo@e2e.local', role: 'user' }
    });
    checkEq('admin cria usuário (201)', created.status, 201);
    check('criação devolve senha temporária de 16 caracteres',
      !!(created.json && created.json.tempPassword && created.json.tempPassword.length === 16),
      JSON.stringify(created.json && created.json.tempPassword && created.json.tempPassword.length));
    const newUserId = created.json && created.json.user && created.json.user.id;
    const temp = created.json && created.json.tempPassword;

    const newClient = createClient(base);
    const newLogin = await login(newClient, 'novo@e2e.local', temp);
    checkEq('o usuário criado consegue logar', newLogin.status, 200);
    const newRt = (newLogin.setCookie || []).filter(function (c) { return String(c).indexOf('sp_rt=') === 0; })[0] || '';

    checkEq('admin desativa o usuário (200)', (await admin.call('/api/admin/users/' + newUserId, {
      method: 'PATCH', body: { disabled: true }
    })).status, 200);
    checkEq('usuário desativado não loga (401)', (await login(createClient(base), 'novo@e2e.local', temp)).status, 401);

    const refreshOnly = createClient(base);
    refreshOnly.setCookie('sp_rt', newRt.split(';')[0].split('=').slice(1).join('='));
    checkEq('refresh token do usuário desativado é recusado (401)', (await refreshOnly.call('/api/auth/session')).status, 401);

    checkEq('admin reativa o usuário', (await admin.call('/api/admin/users/' + newUserId, {
      method: 'PATCH', body: { disabled: false }
    })).status, 200);
    checkEq('usuário reativado volta a logar', (await login(createClient(base), 'novo@e2e.local', temp)).status, 200);

    const reset = await admin.call('/api/admin/users/' + newUserId + '/password', { method: 'POST', body: {} });
    checkEq('reset de senha responde 200', reset.status, 200);
    check('reset devolve senha temporária nova', !!(reset.json && reset.json.tempPassword && reset.json.tempPassword !== temp));
    checkEq('a senha nova funciona', (await login(createClient(base), 'novo@e2e.local', reset.json.tempPassword)).status, 200);
    checkEq('a senha antiga não funciona mais', (await login(createClient(base), 'novo@e2e.local', temp)).status, 401);

    checkEq('admin exclui o usuário (204)', (await admin.call('/api/admin/users/' + newUserId, { method: 'DELETE' })).status, 204);
    checkEq('usuário excluído não loga mais',
      (await login(createClient(base), 'novo@e2e.local', reset.json.tempPassword)).status, 401);

    /* ---------------- admin: guardrails ---------------- */
    const selfId = sessionOk.json.user.id;
    checkEq('admin não desativa a si mesmo (403)', (await admin.call('/api/admin/users/' + selfId, {
      method: 'PATCH', body: { disabled: true }
    })).status, 403);
    checkEq('admin não rebaixa a si mesmo (403)', (await admin.call('/api/admin/users/' + selfId, {
      method: 'PATCH', body: { role: 'user' }
    })).status, 403);
    checkEq('admin não exclui a si mesmo (403)', (await admin.call('/api/admin/users/' + selfId, {
      method: 'DELETE'
    })).status, 403);

    /* 409 do último admin: chamada direta com um ator que não está na lista. */
    const mod = await import(pathToFileURL(path.join(ROOT, 'functions/api/admin/users/[id].js')).href);
    const res409 = await mod.onRequest({
      request: new Request('http://local/api/admin/users/' + selfId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: true })
      }),
      env: env,
      params: { id: selfId },
      data: { auth: { payload: { u: crypto.randomUUID(), r: 'admin', s: 'x' }, token: 'x' } }
    });
    checkEq('último admin ativo não pode ser desativado (409)', res409.status, 409);

    /* ---------------- auditoria ---------------- */
    const audit = await admin.call('/api/admin/audit?limit=50');
    checkEq('GET /api/admin/audit responde 200', audit.status, 200);
    const actions = (audit.json && audit.json.events || []).map(function (e) { return e.action; });
    check('auditoria registra create/disable/password/delete',
      actions.indexOf('user.create') >= 0 && actions.indexOf('user.disable') >= 0 &&
      actions.indexOf('user.password') >= 0 && actions.indexOf('user.delete') >= 0, actions.join(','));
    checkEq('auditoria é negada ao usuário comum', (await user.call('/api/admin/audit')).status, 403);

    /* ---------------- sync: validação ---------------- */
    group('sync');
    const tooMany = [];
    for (let i = 0; i < 201; i++) {
      tooMany.push({ table: 'favorites', op: 'delete', key: { playlist_id: '00000000-0000-0000-0000-000000000000', kind: 'live', item_id: 'x' + i } });
    }
    const overflow = await user.call('/api/sync/push', { method: 'POST', body: { ops: tooMany } });
    checkEq('push com 201 operações responde 413', overflow.status, 413);
    const badTable = await user.call('/api/sync/push', {
      method: 'POST', body: { ops: [{ table: 'app_users', op: 'delete', key: { id: 'x' } }] }
    });
    checkEq('push com tabela fora da lista branca responde 400', badTable.status, 400);

    /* ---------------- sync: ida e volta ---------------- */
    const listId = crypto.randomUUID();
    const pushList = await user.call('/api/sync/push', {
      method: 'POST',
      body: {
        ops: [
          { table: 'playlists', op: 'upsert', row: { id: listId, name: 'Lista do teste', kind: 'm3u', is_active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } },
          { table: 'playlist_secrets', op: 'upsert', row: { playlist_id: listId, m3u_url: 'https://exemplo.test/lista.m3u', xtream_pass: '' } },
          { table: 'favorites', op: 'upsert', row: { playlist_id: listId, kind: 'live', item_id: 'canal-1', title: 'Canal 1' } },
          { table: 'history', op: 'upsert', row: { playlist_id: listId, kind: 'movie', item_id: 'filme-1', title: 'Filme', ep: { id: 'ep1', t: 1 }, pos: 120, dur: 3600 } },
          { table: 'user_prefs', op: 'upsert', row: { resume_last: true, health_check: false, parental_enabled: true, parental_pin_hash: 'abc123', parental_pin_salt: 'def456' } }
        ]
      }
    });
    checkEq('push de 5 operações responde 200', pushList.status, 200);
    check('todas as 5 operações foram aplicadas', !!(pushList.json && pushList.json.applied === 5), JSON.stringify(pushList.json));

    const pulled = await user.call('/api/sync/pull');
    checkEq('pull responde 200', pulled.status, 200);
    check('pull devolve a playlist criada', !!(pulled.json && pulled.json.playlists.some(function (p) { return p.id === listId; })));
    check('pull devolve as credenciais da lista', !!(pulled.json && pulled.json.secrets.some(function (s) {
      return s.playlist_id === listId && s.m3u_url === 'https://exemplo.test/lista.m3u';
    })));
    check('pull devolve favoritos e histórico', !!(pulled.json && pulled.json.favorites.length === 1 && pulled.json.history.length === 1));
    check('pull devolve o ep do histórico como objeto', !!(pulled.json && pulled.json.history[0].ep && pulled.json.history[0].ep.id === 'ep1'),
      JSON.stringify(pulled.json && pulled.json.history[0]));
    check('pull devolve preferências', !!(pulled.json && pulled.json.prefs && pulled.json.prefs.resume_last === true &&
      pulled.json.prefs.health_check === false && pulled.json.prefs.parental_pin_hash === 'abc123'));
    check('pull não traz catálogo', !!(pulled.json && !('catalog' in pulled.json) && !('items' in pulled.json)));

    /* ---------------- RLS no banco (não só na API) ---------------- */
    group('rls');
    const rowsA = await fixtures.rows(env, { uid: userId, role: 'user' }, 'select playlist_id, item_id from favorites');
    check('o dono lê os próprios favoritos', rowsA.length === 1 && rowsA[0].playlist_id === listId, JSON.stringify(rowsA));

    const rowsB = await fixtures.rows(env, { uid: adminId, role: 'user' }, 'select playlist_id from favorites');
    check('outro usuário não lê favoritos do dono', rowsB.length === 0, JSON.stringify(rowsB));

    const upd = await fixtures.rows(env, { uid: adminId, role: 'user' },
      "update favorites set title = 'invadido' where playlist_id = $1 returning item_id", [listId]);
    check('update de outro usuário afeta 0 linhas', upd.length === 0, JSON.stringify(upd));

    const del = await fixtures.rows(env, { uid: adminId, role: 'user' },
      'delete from favorites where playlist_id = $1 returning item_id', [listId]);
    check('delete de outro usuário afeta 0 linhas', del.length === 0, JSON.stringify(del));

    let spoofBlocked = false;
    try {
      await fixtures.rows(env, { uid: adminId, role: 'user' },
        'insert into favorites (user_id, playlist_id, kind, item_id) values ($1,$2,$3,$4)',
        [userId, listId, 'live', 'forjado']);
    } catch (e) {
      spoofBlocked = /row-level security|42501/i.test(String(e.message));
    }
    check('RLS recusa inserir linha com user_id de outro', spoofBlocked);

    const adminData = await fixtures.rows(env, { uid: adminId, role: 'admin' }, 'select playlist_id from favorites');
    check('nem o admin lê os dados dos usuários', adminData.length === 0, JSON.stringify(adminData));

    const spoofApi = await user.call('/api/sync/push', {
      method: 'POST',
      body: { ops: [{ table: 'favorites', op: 'upsert', row: { user_id: adminId, playlist_id: listId, kind: 'live', item_id: 'canal-2', title: 'Canal 2' } }] }
    });
    checkEq('push com user_id no corpo é recusado (400)', spoofApi.status, 400);
    const after = await fixtures.rows(env, { uid: userId, role: 'user' }, "select item_id from favorites where item_id = 'canal-2'");
    check('nada foi gravado com o user_id forjado', after.length === 0);

    /* ---------------- conflito de playlist ---------------- */
    const stale = new Date(Date.now() - 60000).toISOString();
    const fresh = new Date().toISOString();
    await user.call('/api/sync/push', {
      method: 'POST', body: { ops: [{ table: 'playlists', op: 'upsert', row: { id: listId, name: 'Nome novo', kind: 'm3u', updated_at: fresh } }] }
    });
    const conflict = await user.call('/api/sync/push', {
      method: 'POST', body: { ops: [{ table: 'playlists', op: 'upsert', row: { id: listId, name: 'Nome velho', kind: 'm3u', updated_at: stale } }] }
    });
    checkEq('push de versão antiga responde 200', conflict.status, 200);
    check('servidor devolve a linha vencedora em conflicts',
      !!(conflict.json && conflict.json.conflicts && conflict.json.conflicts.length === 1 &&
        conflict.json.conflicts[0].serverRow.name === 'Nome novo'), JSON.stringify(conflict.json));

    /* ---------------- CSRF ---------------- */
    group('csrf');
    const csrfLogin = await anon.call('/api/auth/login', {
      method: 'POST', headers: { Origin: 'https://evil.example' }, body: { email: USER.email, password: USER.password }
    });
    checkEq('POST com Origin de outro site responde 403', csrfLogin.status, 403);
    const csrfPush = await user.call('/api/sync/push', {
      method: 'POST', headers: { Origin: 'https://evil.example' }, body: { ops: [] }
    });
    checkEq('POST /api/sync/push com Origin estranho responde 403', csrfPush.status, 403);
    checkEq('POST com a própria Origin é aceito', (await user.call('/api/sync/push', {
      method: 'POST', headers: { Origin: base }, body: { ops: [] }
    })).status, 200);

    /* ---------------- capabilities / recuperação ---------------- */
    group('recuperação');
    const caps = await anon.call('/api/auth/capabilities');
    checkEq('capabilities responde 200', caps.status, 200);
    check('capabilities: recovery false e signup false',
      !!(caps.json && caps.json.recovery === false && caps.json.signup === false), JSON.stringify(caps.json));
    const forgot = await anon.call('/api/auth/forgot', { method: 'POST', body: { email: 'nao-existe@e2e.local' } });
    checkEq('forgot responde 503 (sem SMTP: reset é pelo admin)', forgot.status, 503);
    check('forgot não revela se o e-mail existe', !!(forgot.json && forgot.json.error === 'not_configured'));

    /* ---------------- troca de senha ---------------- */
    group('senha');
    const pwClient = createClient(base);
    await login(pwClient, USER.email, USER.password);
    checkEq('troca com senha atual errada responde 401', (await pwClient.call('/api/auth/password', {
      method: 'POST', body: { current: 'errada', next: 'uma-senha-nova-123' }
    })).status, 401);
    checkEq('troca com senha nova curta responde 400', (await pwClient.call('/api/auth/password', {
      method: 'POST', body: { current: USER.password, next: 'curta' }
    })).status, 400);
    checkEq('troca de senha responde 204', (await pwClient.call('/api/auth/password', {
      method: 'POST', body: { current: USER.password, next: 'uma-senha-nova-123' }
    })).status, 204);
    checkEq('a senha antiga não funciona mais', (await login(createClient(base), USER.email, USER.password)).status, 401);
    checkEq('a senha nova funciona', (await login(createClient(base), USER.email, 'uma-senha-nova-123')).status, 200);

    /* ---------------- sessões revogadas ---------------- */
    group('sessões');
    const before = (await login(createClient(base), ADMIN.email, ADMIN.password)).setCookie || [];
    const rt = (before.filter(function (c) { return String(c).indexOf('sp_rt=') === 0; })[0] || '').split(';')[0].split('=').slice(1).join('=');
    const reuse = createClient(base);
    reuse.setCookie('sp_rt', rt);
    checkEq('refresh válido renova a sessão (200)', (await reuse.call('/api/auth/session')).status, 200);

    /* ---------------- build ---------------- */
    group('build');
    const leaked = fileTreeContains('dist/web', ['NEON_APP_URL', 'AUTH_SECRET', 'space_app', 'npg_']);
    check('dist/web não contém segredo do banco', leaked.length === 0, leaked.join(','));
    check('dist/web tem login.html, _headers e _routes.json',
      ['login.html', '_headers', '_routes.json'].every(function (f) { return fs.existsSync(path.join(ROOT, 'dist', 'web', f)); }));
  } catch (e) {
    record('execução', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : String(e));
  } finally {
    if (!flags.keep) {
      await runner.close();
      try { await fixtures.cleanup(env); } catch (e) { /* deixa rastro para depurar */ }
    }
  }

  report();
}

function fileTreeContains(dir, needles) {
  const found = [];
  function walk(abs) {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const next = path.join(abs, entry.name);
      if (entry.isDirectory()) { walk(next); continue; }
      if (next.endsWith('.map')) continue;
      let text = '';
      try { text = fs.readFileSync(next, 'utf8'); } catch (e) { continue; }
      for (const needle of needles) {
        if (text.indexOf(needle) >= 0) found.push(path.relative(dir, next) + ':' + needle);
      }
    }
  }
  walk(dir);
  return found;
}

function report() {
  console.log('');
  let lastGroup = '';
  for (const r of results) {
    if (r.group !== lastGroup) { console.log('== ' + r.group + ' =='); lastGroup = r.group; }
    console.log('  ' + (r.status === 'pass' ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
  }
  const pass = results.filter(function (r) { return r.status === 'pass'; }).length;
  const fail = results.filter(function (r) { return r.status === 'fail'; }).length;
  console.log('');
  console.log('Resumo: ' + pass + ' PASS, ' + fail + ' FAIL');
  if (flags.json) console.log(JSON.stringify({ pass: pass, fail: fail, results: results }, null, 2));
  process.exitCode = fail ? 1 : 0;
}

main().then(function () {
  setTimeout(function () { process.exit(process.exitCode || 0); }, 150);
}, function (e) {
  console.error('falha fatal: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
