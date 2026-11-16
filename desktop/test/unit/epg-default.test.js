/* Testes unitários da fonte pública de EPG padrão.
 *
 * Cobre:
 *  - `src/main/config.js`: `epgUrl` no DEFAULTS/get/set/sanitize ('' = desligado,
 *    http(s) válido, valor inválido no arquivo volta para a fonte padrão);
 *  - `src/renderer/js/epg/epg.js`: ordem de descoberta
 *    url-tvg da lista > xmltv.php do Xtream > `space.config.get().epgUrl` > 'none',
 *    além de `state.sourceKind`, meta do cache e allowlist do host.
 *
 * Renderer em Node puro: `epg.js` é UMD/IIFE como no navegador. Mocks mínimos de
 * App/bus/IndexedDB/fetch; nenhuma rede real.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const util = require('../helpers/util');
const configMod = require(util.desktopPath('src', 'main', 'config.js'));

const { createConfig, DEFAULT_EPG_URL, sanitize, normalizeEpgUrl } = configMod;

const FIXTURE_XML = fs.readFileSync(util.desktopPath('test', 'fixtures', 'xmltv-basic.xml'), 'utf8');

/* ------------------------------------------------------------------ config */

function isolatedConfig(t, name) {
  const dir = util.makeTmp(t, name || 'epg-default');
  return {
    cfg: createConfig({ env: { SPACE_CONFIG_FILE: path.join(dir, 'config.json') }, appDataDir: dir }),
    dir: dir
  };
}

test('config: epgUrl tem a fonte pública BR1 como padrão', (t) => {
  assert.equal(DEFAULT_EPG_URL, 'https://epgshare01.online/epgshare01/epg_ripper_BR1.xml.gz');
  assert.equal(configMod.DEFAULTS.epgUrl, DEFAULT_EPG_URL);
  const { cfg } = isolatedConfig(t);
  assert.equal(cfg.get().epgUrl, DEFAULT_EPG_URL);
});

test('config: normalizeEpgUrl aceita só http(s) e mantém a URL como veio', () => {
  assert.equal(normalizeEpgUrl(DEFAULT_EPG_URL), DEFAULT_EPG_URL);
  assert.equal(normalizeEpgUrl('  https://exemplo.com/guia.xml.gz  '), 'https://exemplo.com/guia.xml.gz');
  assert.equal(normalizeEpgUrl('http://exemplo.com/guia.xml?token=abc'), 'http://exemplo.com/guia.xml?token=abc');
  assert.equal(normalizeEpgUrl(''), '');
  assert.equal(normalizeEpgUrl(null), '');
  assert.equal(normalizeEpgUrl('ftp://exemplo.com/guia.xml'), '');
  assert.equal(normalizeEpgUrl('javascript:alert(1)'), '');
  assert.equal(normalizeEpgUrl('não é uma url'), '');
  assert.equal(normalizeEpgUrl('https://' + 'a'.repeat(2100) + '.com/x'), '');
});

test('config: set(epgUrl) valida e persiste URL personalizada', (t) => {
  const { cfg } = isolatedConfig(t, 'epg-set-url');
  const custom = 'https://meu-epg.exemplo.invalid/guia.xml.gz';
  const out = cfg.set({ epgUrl: custom });
  assert.equal(out.epgUrl, custom);
  const reloaded = createConfig({ env: { SPACE_CONFIG_FILE: cfg.configFile }, appDataDir: path.dirname(cfg.configFile) });
  assert.equal(reloaded.get().epgUrl, custom);
});

test('config: set(epgUrl "") desliga e persiste desligado; URL inválida lança invalid_url', (t) => {
  const { cfg } = isolatedConfig(t, 'epg-set-off');
  assert.equal(cfg.set({ epgUrl: '   ' }).epgUrl, '', 'vazio/limpo desliga');
  const reloaded = createConfig({ env: { SPACE_CONFIG_FILE: cfg.configFile }, appDataDir: path.dirname(cfg.configFile) });
  assert.equal(reloaded.get().epgUrl, '', 'desligado persiste (não volta ao padrão)');

  for (const bad of ['ftp://exemplo.com/x.xml', 'exemplo.com/x.xml', 'javascript:alert(1)', 'não é url']) {
    assert.throws(() => cfg.set({ epgUrl: bad }), (e) => e && e.code === 'invalid_url', 'deve recusar ' + JSON.stringify(bad));
  }
});

test("config: sanitize usa padrão para lixo e respeita '' (desligado)", () => {
  assert.equal(sanitize({}).epgUrl, DEFAULT_EPG_URL);
  assert.equal(sanitize({ epgUrl: '' }).epgUrl, '');
  assert.equal(sanitize({ epgUrl: null }).epgUrl, DEFAULT_EPG_URL);
  assert.equal(sanitize({ epgUrl: 'https://ok.exemplo.invalid/guia.xml' }).epgUrl, 'https://ok.exemplo.invalid/guia.xml');
  assert.equal(sanitize({ epgUrl: 'ftp://invalido' }).epgUrl, DEFAULT_EPG_URL, 'lixo no arquivo não desliga a fonte padrão');
  assert.equal(sanitize({ epgUrl: 42 }).epgUrl, DEFAULT_EPG_URL);
});

/* -------------------------------------------------- renderer (epg.js) em Node */

function makeIdb() {
  const store = new Map();
  function copy(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  return {
    _store: store,
    get: (k) => Promise.resolve(store.has(k) ? copy(store.get(k)) : undefined),
    put: (k, v) => { store.set(k, copy(v)); return Promise.resolve(); },
    del: (k) => { store.delete(k); return Promise.resolve(); }
  };
}

function makeBus() {
  const subs = {};
  return {
    on(ev, fn) { (subs[ev] = subs[ev] || []).push(fn); },
    off(ev, fn) { const a = subs[ev] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    emit(ev, d) { (subs[ev] || []).slice().forEach((fn) => { try { fn(d); } catch (e) { /* ignore */ } }); }
  };
}

const env = {
  idb: makeIdb(),
  config: { epgUrl: DEFAULT_EPG_URL, epgTtlHours: 24 },
  creds: null,
  fetchCount: 0,
  fetchUrls: [],
  registerCalls: []
};

const App = {
  bus: makeBus(),
  idb: env.idb,
  catalog: { data: { head: {} }, listId: null },
  lists: {
    active: () => null,
    creds: () => Promise.resolve(env.creds)
  },
  desktop: {
    api: {
      registerMediaHosts(hosts) {
        env.registerCalls.push(Array.from(hosts || []));
        return Promise.resolve(true);
      }
    }
  }
};

global.App = App;
require(util.desktopPath('src', 'renderer', 'js', 'epg', 'epg-parse.js'));
require(util.desktopPath('src', 'renderer', 'js', 'epg', 'epg.js'));

if (!App.epg) throw new Error('epg.js não registrou App.epg');

global.space = {
  config: {
    get: () => Promise.resolve(Object.assign({}, env.config))
  }
};

global.fetch = function (url) {
  env.fetchCount++;
  env.fetchUrls.push(String(url));
  return Promise.resolve(new Response(FIXTURE_XML, { status: 200, headers: { 'content-type': 'application/xml' } }));
};

const epg = App.epg;

function resetEnv() {
  epg.__reset();
  env.idb._store.clear();
  env.config = { epgUrl: DEFAULT_EPG_URL, epgTtlHours: 24 };
  env.creds = null;
  env.fetchCount = 0;
  env.fetchUrls.length = 0;
  env.registerCalls.length = 0;
  App.catalog.listId = null;
  App.catalog.data = { head: {} };
  App.lists.active = () => null;
  App.lists.creds = () => Promise.resolve(env.creds);
}

function urlFromServerRoute(raw) {
  const s = String(raw || '');
  const m = s.split('url=')[1];
  return m ? decodeURIComponent(m) : '';
}

function registeredHosts() {
  return [].concat.apply([], env.registerCalls);
}

/* 1) fallback: M3U sem url-tvg usa a fonte pública padrão */
test('epg: M3U sem url-tvg cai na fonte pública padrão (state.sourceKind = default)', async () => {
  resetEnv();
  const list = { id: 'm3u-sem-epg', name: 'Lista sem EPG', type: 'm3u' };
  const s = await epg.load(list);

  assert.equal(s.status, 'ready', 'estado: ' + JSON.stringify(s));
  assert.equal(s.error, '');
  assert.equal(s.sourceKind, 'default');
  assert.equal(s.source, DEFAULT_EPG_URL);
  assert.equal(s.channelCount > 0, true);
  assert.equal(s.programmeCount > 0, true);

  assert.equal(env.fetchCount, 1, 'um único download');
  assert.match(env.fetchUrls[0], /^\/_epg\/source\?url=/, 'passa pela rota interna (allowlist)');
  assert.equal(urlFromServerRoute(env.fetchUrls[0]), DEFAULT_EPG_URL);

  assert.ok(registeredHosts().includes('epgshare01.online'), 'host padrão na allowlist: ' + JSON.stringify(registeredHosts()));

  const meta = env.idb._store.get('epg.meta.m3u-sem-epg');
  assert.ok(meta, 'meta do cache gravado');
  assert.equal(meta.sourceKind, 'default');
  assert.equal(meta.source, DEFAULT_EPG_URL);
});

/* 2) url-tvg da lista tem prioridade sobre a fonte padrão */
test('epg: url-tvg do M3U vence a fonte padrão (state.sourceKind = list)', async () => {
  resetEnv();
  const list = { id: 'm3u-com-epg', name: 'Lista com EPG', type: 'm3u' };
  const tvg = 'https://epg.exemplo.invalid/guia.xml.gz';
  App.catalog.listId = list.id;
  App.catalog.data = { head: { 'url-tvg': tvg } };

  const s = await epg.load(list);

  assert.equal(s.status, 'ready');
  assert.equal(s.sourceKind, 'list');
  assert.equal(s.source, tvg);
  assert.equal(env.fetchCount, 1);
  assert.equal(urlFromServerRoute(env.fetchUrls[0]), tvg);
  assert.equal(env.fetchUrls[0].indexOf(encodeURIComponent(DEFAULT_EPG_URL)), -1, 'fonte padrão não é usada');

  const meta = env.idb._store.get('epg.meta.m3u-com-epg');
  assert.equal(meta.sourceKind, 'list');
  assert.equal(meta.source, tvg);
});

/* 3) Xtream: xmltv.php vence; sem credenciais cai na fonte padrão; nada sensível no estado/cache */
test('epg: Xtream usa xmltv.php sem expor credenciais', async () => {
  resetEnv();
  env.creds = {
    server: 'https://xt.exemplo.invalid:8443/',
    user: 'usuario-teste',
    pass: 'senha-segredo'
  };
  const list = { id: 'xtream-1', name: 'Xtream', type: 'xtream' };
  const s = await epg.load(list);

  assert.equal(s.status, 'ready');
  assert.equal(s.sourceKind, 'xtream');
  assert.equal(s.source, 'https://xt.exemplo.invalid:8443/xmltv.php');
  assert.ok(!/usuario-teste|senha-segredo/.test(s.source), 'state.source sem credenciais');
  assert.ok(!/usuario-teste|senha-segredo/.test(JSON.stringify(s)), 'estado inteiro sem credenciais');

  const meta = env.idb._store.get('epg.meta.xtream-1');
  assert.equal(meta.sourceKind, 'xtream');
  assert.ok(!/usuario-teste|senha-segredo/.test(JSON.stringify(meta)), 'meta do cache sem credenciais');
});

test('epg: Xtream sem credenciais legíveis cai na fonte padrão', async () => {
  resetEnv();
  env.creds = null;
  const list = { id: 'xtream-sem-creds', name: 'Xtream sem creds', type: 'xtream' };
  const s = await epg.load(list);
  assert.equal(s.status, 'ready');
  assert.equal(s.sourceKind, 'default');
  assert.equal(s.source, DEFAULT_EPG_URL);
});

/* 4) fonte desligada (epgUrl '') volta ao estado 'none' de antes */
test('epg: epgUrl vazio desliga a fonte padrão (none, sem download)', async () => {
  resetEnv();
  env.config = { epgUrl: '', epgTtlHours: 24 };
  const list = { id: 'm3u-desligado', name: 'Sem fonte', type: 'm3u' };
  const s = await epg.load(list);

  assert.equal(s.status, 'none');
  assert.equal(s.error, '');
  assert.equal(s.source, '');
  assert.equal(s.sourceKind, '');
  assert.equal(env.fetchCount, 0, 'não deve baixar nada');
});

/* 5) URL personalizada (Configurações) e allowlist do host personalizado */
test('epg: epgUrl personalizada é usada e o host entra na allowlist', async () => {
  resetEnv();
  const custom = 'https://meu-epg.exemplo.invalid/guia.xml.gz';
  env.config = { epgUrl: custom, epgTtlHours: 24 };
  const s = await epg.load({ id: 'm3u-custom', name: 'Custom', type: 'm3u' });

  assert.equal(s.status, 'ready');
  assert.equal(s.sourceKind, 'default');
  assert.equal(s.source, custom);
  assert.equal(urlFromServerRoute(env.fetchUrls[0]), custom);
  assert.ok(registeredHosts().includes('meu-epg.exemplo.invalid'), 'allowlist: ' + JSON.stringify(registeredHosts()));
});

/* 6) cache: meta guarda a origem e o load seguinte reaproveita sem baixar */
test('epg: meta do cache preserva sourceKind/source e é reutilizado', async () => {
  resetEnv();
  const list = { id: 'm3u-cache', name: 'Cache', type: 'm3u' };
  const first = await epg.load(list);
  assert.equal(first.fromCache, false);
  const fetches = env.fetchCount;

  epg.__reset();   /* descarta só a RAM; IndexedDB fake continua com o cache */
  const second = await epg.load(list);

  assert.equal(second.fromCache, true);
  assert.equal(second.sourceKind, 'default');
  assert.equal(second.source, DEFAULT_EPG_URL);
  assert.equal(env.fetchCount, fetches, 'cache válido não baixa de novo');
});
