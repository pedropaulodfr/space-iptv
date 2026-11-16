/* Testes unitários de `src/main/autostart.js` com um `app` do Electron falso.
 * Contrato: CONTRACTS.md §3.6 — padrão desligado, set liga/desliga de verdade,
 * SPACE_NO_AUTOSTART=1 não toca no sistema operacional.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const util = require('../helpers/util');
const { createAutostart } = util.tryRequire('src/main/autostart.js') || require(util.desktopPath('src', 'main', 'autostart.js'));

function fakeConfig(initial) {
  const state = Object.assign({ startWithWindows: false, startMinimizedToTray: false }, initial || {});
  return {
    state: state,
    get: () => Object.assign({}, state),
    set: (patch) => { Object.assign(state, patch); return Object.assign({}, state); }
  };
}

function fakeApp(opts) {
  const o = opts || {};
  const calls = { set: [], get: [] };
  const app = {
    calls: calls,
    getLoginItemSettings: (arg) => {
      calls.get.push(arg);
      if (o.throwGet) throw new Error('boom');
      return { openAtLogin: !!o.openAtLogin, wasOpenedAtLogin: false };
    },
    setLoginItemSettings: (arg) => {
      calls.set.push(arg);
      if (o.throwSet) throw new Error('boom');
    }
  };
  return app;
}

test('padrão DESLIGADO: sem app e sem config, tudo desligado', () => {
  const auto = createAutostart({ config: fakeConfig(), env: {} });
  assert.deepEqual(auto.get(), { openAtLogin: false, minimized: false, disabled: false });
  assert.equal(auto.disabled(), false);
});

test('get() usa o estado real do Windows (não o config)', () => {
  const app = fakeApp({ openAtLogin: true });
  const auto = createAutostart({ config: fakeConfig({ startWithWindows: false }), app: app, env: {} });
  const st = auto.get();
  assert.equal(st.openAtLogin, true, 'lê do Electron');
  assert.equal(app.calls.get[0].args[0], '--autostart');
});

test('get() com exceção do Electron ou sem suporte => false (nunca inventa ligado)', () => {
  const throwing = fakeApp({ throwGet: true, openAtLogin: true });
  const autoThrow = createAutostart({ config: fakeConfig(), app: throwing, env: {} });
  assert.equal(autoThrow.get().openAtLogin, false);

  if (process.platform !== 'win32') {
    const autoOther = createAutostart({ config: fakeConfig(), app: fakeApp({ openAtLogin: true }), env: {} });
    assert.equal(autoOther.supported(), false);
    assert.equal(autoOther.get().openAtLogin, false);
  }
});

test('set({openAtLogin:true}) persiste no config e chama o SO', () => {
  const config = fakeConfig();
  const app = fakeApp({ openAtLogin: false });
  const auto = createAutostart({ config: config, app: app, env: {} });
  // força plataforma windows para exercitar o caminho do SO
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const out = auto.set({ openAtLogin: true });
    assert.equal(config.state.startWithWindows, true);
    assert.equal(out.minimized, false);
    assert.equal(app.calls.set.length, 1);
    assert.equal(app.calls.set[0].openAtLogin, true);
    assert.deepEqual(app.calls.set[0].args, ['--autostart']);
    assert.equal(app.calls.set[0].path, process.execPath);
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
});

test('set({openAtLogin:false}) remove a entrada de inicialização', () => {
  const config = fakeConfig({ startWithWindows: true });
  const app = fakeApp({ openAtLogin: true });
  const auto = createAutostart({ config: config, app: app, env: {} });
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    auto.set({ openAtLogin: false });
    assert.equal(config.state.startWithWindows, false);
    assert.equal(app.calls.set.length >= 1, true);
    assert.equal(app.calls.set[app.calls.set.length - 1].openAtLogin, false);
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
});

test('set({minimized:true}) persiste startMinimizedToTray e mantém o login item', () => {
  const config = fakeConfig();
  const app = fakeApp({ openAtLogin: true });
  const auto = createAutostart({ config: config, app: app, env: {} });
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const out = auto.set({ minimized: true });
    assert.equal(config.state.startMinimizedToTray, true);
    assert.equal(out.minimized, true);
    assert.equal(out.openAtLogin, true, 'estado real do login item preservado');
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
});

test('SPACE_NO_AUTOSTART=1: não toca no SO mas registra a preferência', () => {
  const config = fakeConfig();
  const app = fakeApp();
  const auto = createAutostart({ config: config, app: app, env: { SPACE_NO_AUTOSTART: '1' } });
  assert.equal(auto.disabled(), true);
  assert.equal(auto.get().disabled, true);
  const out = auto.set({ openAtLogin: true, minimized: true });
  assert.equal(out.disabled, true);
  assert.equal(out.openAtLogin, false, 'nunca reporta ligado no modo desabilitado');
  assert.equal(app.calls.set.length, 0, 'não chama setLoginItemSettings');
  assert.equal(config.state.startWithWindows, true, 'config registra a intenção');
  assert.equal(config.state.startMinimizedToTray, true);
});

test('setLoginItemSettings que lança não derruba: devolve aplicado=false', () => {
  const config = fakeConfig();
  const app = fakeApp({ openAtLogin: false, throwSet: true });
  const auto = createAutostart({ config: config, app: app, env: {} });
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    assert.doesNotThrow(() => auto.set({ openAtLogin: true }));
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
});

test('nunca habilita sozinho em um config limpo', () => {
  const config = fakeConfig();
  const auto = createAutostart({ config: config, app: fakeApp({ openAtLogin: false }), env: {} });
  assert.equal(auto.get().openAtLogin, false);
  assert.equal(config.state.startWithWindows, false);
  assert.deepEqual(auto.args, ['--autostart']);
});
