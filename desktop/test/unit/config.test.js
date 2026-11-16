/* Testes unitários de `src/main/config.js` (Node puro, sem Electron).
 * Contrato: CONTRACTS.md §2.1/§2.4 — JSON atômico, precedência env/config/registry,
 * porta interna estável, pasta de downloads validada, nada de segredo no arquivo.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const util = require('../helpers/util');
const configMod = require(util.desktopPath('src', 'main', 'config.js'));

const { createConfig, DEFAULTS, DEFAULT_API_ORIGIN, PORT_MIN, PORT_MAX, EPG_TTL_ALLOWED } = configMod;

/** Config isolada: nenhuma leitura/escrita no %APPDATA% real do usuário. */
function isolatedConfig(t, envPatch, name) {
  const dir = util.makeTmp(t, name || 'config');
  const env = Object.assign({}, envPatch || {});
  if (!env.SPACE_CONFIG_FILE) env.SPACE_CONFIG_FILE = path.join(dir, 'config.json');
  return { cfg: createConfig({ env: env, appDataDir: dir }), dir: dir, env: env };
}

test('expoe as constantes do contrato', () => {
  assert.equal(typeof DEFAULT_API_ORIGIN, 'string');
  assert.ok(DEFAULT_API_ORIGIN.startsWith('https://'));
  assert.equal(PORT_MIN, 41000);
  assert.equal(PORT_MAX, 49000);
  assert.deepEqual(EPG_TTL_ALLOWED, [12, 24, 48]);
  assert.equal(DEFAULTS.epgTtlHours, 24);
  assert.equal(DEFAULTS.startWithWindows, false);
  assert.equal(DEFAULTS.startMinimizedToTray, false);
  assert.equal(DEFAULTS.minimizeToTrayOnClose, false);
  assert.equal(DEFAULTS.internalPort, 0);
});

test('defaults quando o arquivo não existe (get não grava sozinho)', (t) => {
  const { cfg, dir } = isolatedConfig(t);
  const got = cfg.get();
  assert.equal(got.apiOrigin, DEFAULT_API_ORIGIN);
  assert.equal(got.internalPort, 0);
  assert.equal(got.epgTtlHours, 24);
  assert.equal(got.startWithWindows, false);
  assert.equal(got.startMinimizedToTray, false);
  assert.equal(got.minimizeToTrayOnClose, false);
  assert.equal(got.version, 1);
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false, 'get() não deve gravar');
  assert.ok(got.window && got.window.width >= 800);
});

test('SPACE_API_ORIGIN tem prioridade sobre o arquivo', (t) => {
  const { cfg } = isolatedConfig(t, { SPACE_API_ORIGIN: 'http://127.0.0.1:8789' });
  assert.equal(cfg.effectiveApiOrigin(), 'http://127.0.0.1:8789');
  assert.equal(cfg.get().apiOrigin, 'http://127.0.0.1:8789');

  const bad = isolatedConfig(t, { SPACE_API_ORIGIN: 'javascript:alert(1)' });
  assert.equal(bad.cfg.effectiveApiOrigin(), DEFAULT_API_ORIGIN);
});

test('normalizeOrigin aceita só http/https válidos', () => {
  assert.equal(configMod.normalizeOrigin('https://space-iptv.pages.dev/'), 'https://space-iptv.pages.dev');
  assert.equal(configMod.normalizeOrigin('http://127.0.0.1:8789/api'), 'http://127.0.0.1:8789');
  assert.equal(configMod.normalizeOrigin('ftp://x'), '');
  assert.equal(configMod.normalizeOrigin('não é url'), '');
  assert.equal(configMod.normalizeOrigin(''), '');
  assert.equal(configMod.normalizeOrigin(null), '');
});

test('porta interna: sorteia 41000–49000 no primeiro uso e persiste', (t) => {
  const { cfg, dir } = isolatedConfig(t, {}, 'config-port');
  const port = cfg.effectiveInternalPort();
  assert.ok(port >= PORT_MIN && port <= PORT_MAX, 'porta ' + port);
  assert.equal(cfg.internalPort, port, 'deve manter a mesma porta na sessão');
  // segunda instância lê do arquivo
  const cfg2 = createConfig({ env: { SPACE_CONFIG_FILE: path.join(dir, 'config.json') }, appDataDir: dir });
  assert.equal(cfg2.effectiveInternalPort(), port);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).internalPort, port);
});

test('porta interna: SPACE_INTERNAL_PORT vence e 0 significa automático', (t) => {
  const { cfg } = isolatedConfig(t, { SPACE_INTERNAL_PORT: '45999' });
  assert.equal(cfg.effectiveInternalPort(), 45999);
  const auto = isolatedConfig(t, { SPACE_INTERNAL_PORT: '0' });
  const p = auto.cfg.effectiveInternalPort();
  assert.ok(p >= PORT_MIN && p <= PORT_MAX);
});

test('pasta de downloads: precedência env > config > padrão', (t) => {
  const a = util.makeTmp(t, 'dl-env');
  const b = util.makeTmp(t, 'dl-config');
  const { cfg } = isolatedConfig(t, { SPACE_DOWNLOADS_DIR: a }, 'config-dl');
  cfg.set({ downloadsDir: b });
  assert.equal(cfg.get().downloadsDir, b, 'config definido');
  const cfgEnv = createConfig({
    env: { SPACE_CONFIG_FILE: cfg.configFile, SPACE_DOWNLOADS_DIR: a },
    appDataDir: path.dirname(cfg.configFile)
  });
  assert.equal(cfgEnv.resolveDownloadsDir().path, a, 'env vence o config');
  assert.equal(cfgEnv.resolveDownloadsDir().from, 'env');
});

test('set(downloadsDir) valida escrita e recusa pasta inválida', (t) => {
  const good = util.makeTmp(t, 'dl-good');
  const { cfg } = isolatedConfig(t, {}, 'config-dl-set');

  const out = cfg.set({ downloadsDir: good });
  assert.equal(out.downloadsDir, good);
  // arquivo não-pasta
  const file = path.join(util.makeTmp(t, 'dl-file'), 'arquivo.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => cfg.set({ downloadsDir: file }), (e) => e.code === 'invalid_dir');
  // vazio
  assert.throws(() => cfg.set({ downloadsDir: '   ' }), (e) => e.code === 'invalid_dir');
});

test('validateDownloadsDir devolve {ok,path,freeBytes} ou erro claro', (t) => {
  const dir = util.makeTmp(t, 'dl-valid');
  const ok = cfgValidate(t, dir);
  assert.equal(ok.ok, true);
  assert.equal(ok.path, dir);
  assert.ok(ok.freeBytes === undefined || typeof ok.freeBytes === 'number');
  const bad = cfgValidate(t, '');
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.error, 'string');
});

/* helper: validateDownloadsDir usa a mesma regra de pasta, mas não precisa de config isolada */
function cfgValidate(t, dir) {
  const { cfg } = isolatedConfig(t, {}, 'config-valid');
  return cfg.validateDownloadsDir(dir);
}

test('epgTtlHours aceita 12/24/48 e recusa o resto', (t) => {
  const { cfg } = isolatedConfig(t, {}, 'config-epg');
  for (const ttl of [12, 24, 48]) {
    assert.equal(cfg.set({ epgTtlHours: ttl }).epgTtlHours, ttl);
  }
  for (const ttl of [5, 0, 100, 24.5]) {
    assert.throws(() => cfg.set({ epgTtlHours: ttl }), (e) => e.code === 'invalid_value', 'ttl ' + ttl);
  }
});

test('booleanos só viram true com true de verdade', (t) => {
  const { cfg } = isolatedConfig(t, {}, 'config-bool');
  const got = cfg.set({ startWithWindows: 'sim', startMinimizedToTray: 1, minimizeToTrayOnClose: {} });
  assert.equal(got.startWithWindows, false);
  assert.equal(got.startMinimizedToTray, false);
  assert.equal(got.minimizeToTrayOnClose, false);
  assert.equal(cfg.set({ startWithWindows: true }).startWithWindows, true);
});

test('janela: normalização e persistência', (t) => {
  const { cfg } = isolatedConfig(t, {}, 'config-window');
  const state = cfg.setWindowState({ x: 12, y: 34, width: 1000, height: 700, maximized: true });
  assert.deepEqual(state, { x: 12, y: 34, width: 1000, height: 700, maximized: true });
  const crazy = cfg.setWindowState({ x: 999999, y: null, width: 50, height: 999999, maximized: false });
  assert.ok(crazy.width >= 800, 'largura mínima');
  assert.ok(crazy.height <= 8000, 'altura máxima');
  assert.equal(crazy.x, null, 'x absurdo é descartado');
  assert.equal(crazy.maximized, false);
});

test('JSON corrompido não derruba: volta ao padrão e reescreve no próximo save', (t) => {
  const dir = util.makeTmp(t, 'config-corrupt');
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ isso não é json', 'utf8');
  const cfg = createConfig({ env: { SPACE_CONFIG_FILE: file }, appDataDir: dir });
  assert.equal(cfg.get().epgTtlHours, 24);
  cfg.set({ epgTtlHours: 48 });
  assert.equal(cfg.get().epgTtlHours, 48);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
});

test('sanitize descarta chaves desconhecidas e tipos inválidos', () => {
  const out = configMod.sanitize({
    version: 1,
    apiOrigin: 'https://example.com/',
    internalPort: 99999,
    downloadsDir: '  C:\\Vídeos  ',
    epgTtlHours: 7,
    startWithWindows: 'yes',
    hacker: true,
    window: { width: 'x' }
  });
  assert.equal(out.apiOrigin, 'https://example.com');
  assert.equal(out.internalPort, 0);
  assert.equal(out.downloadsDir, 'C:\\Vídeos');
  assert.equal(out.epgTtlHours, 24);
  assert.equal(out.startWithWindows, false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'hacker'), false);
  assert.ok(out.window.width >= 800);
});

test('usuário em cache: separado do config e sem papel de admin', (t) => {
  const { cfg } = isolatedConfig(t, {}, 'config-user');
  assert.equal(cfg.getCachedUser(), null);
  cfg.setCachedUser({ email: 'desktop.user@example.com', name: 'Teste', role: 'admin' });
  const cached = cfg.getCachedUser();
  assert.equal(cached.email, 'desktop.user@example.com');
  assert.equal(cached.name, 'Teste');
  assert.equal(cached.role, 'user', 'desktop não tem papel administrativo');
  cfg.clearCachedUser();
  assert.equal(cfg.getCachedUser(), null);

  // nada do usuário no config.json versionável (só no cache local, best effort)
  cfg.setCachedUser({ email: 'desktop.user@example.com' });
  cfg.save(); // garante o config.json no disco para a checagem abaixo
  const configText = fs.readFileSync(cfg.configFile, 'utf8');
  assert.ok(configText.indexOf('desktop.user@example.com') < 0, 'config.json não guarda e-mail');
  assert.ok(fs.existsSync(cfg.cacheFile), 'cache em arquivo separado');
});

test('getCachedUser tolera cache corrompido ou incompleto', (t) => {
  const { cfg } = isolatedConfig(t, {}, 'config-cache-bad');
  fs.writeFileSync(cfg.cacheFile, 'lixo', 'utf8');
  assert.equal(cfg.getCachedUser(), null);
  fs.writeFileSync(cfg.cacheFile, JSON.stringify({ user: { email: '' } }), 'utf8');
  assert.equal(cfg.getCachedUser(), null);
  fs.writeFileSync(cfg.cacheFile, JSON.stringify({ user: { email: 'a@b.c' } }), 'utf8');
  assert.deepEqual(cfg.getCachedUser(), { email: 'a@b.c', name: '', role: 'user' });
});

test('ensureInitialized cria o arquivo e devolve porta/pasta/warnings', (t) => {
  const { cfg, dir } = isolatedConfig(t, {}, 'config-init');
  const info = cfg.ensureInitialized();
  assert.equal(info.configFile, path.join(dir, 'config.json'));
  assert.ok(fs.existsSync(info.configFile));
  assert.ok(info.port >= PORT_MIN && info.port <= PORT_MAX);
  assert.equal(typeof info.downloads.path, 'string');
  assert.ok(Array.isArray(info.warnings));
});

test('writeJsonAtomic grava com rename e não deixa .tmp', (t) => {
  const dir = util.makeTmp(t, 'config-atomic');
  const file = path.join(dir, 'sub', 'dados.json');
  configMod.writeJsonAtomic(file, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true });
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('formatBytes do config (informativo) devolve texto com unidade', () => {
  assert.match(configMod.formatBytes(1536), /KB/);
  assert.equal(configMod.formatBytes(-1), '');
  assert.equal(configMod.formatBytes('x'), '');
});

test('readRegistryDownloadsDir: no Windows devolve string (vazia se ausente)', () => {
  if (process.platform !== 'win32') {
    assert.equal(configMod.readRegistryDownloadsDir(), '');
    return;
  }
  const value = configMod.readRegistryDownloadsDir();
  assert.equal(typeof value, 'string');
  if (value) assert.ok(path.isAbsolute(value), 'valor do registro deve ser absoluto: ' + value);
});
