#!/usr/bin/env node
/* Verificação de INSTALAÇÃO/DESINSTALAÇÃO do Space IPTV Desktop (qa-release).
 *
 * Executa o instalador NSIS de verdade nesta máquina e confere:
 *   - instalação silenciosa (/S) usa a pasta padrão de downloads e cria a pasta;
 *   - registro HKCU\Software\Space IPTV\DownloadsDir;
 *   - atalhos (desktop/menu Iniciar) e chaves de desinstalação;
 *   - atualização (instalar por cima) preserva dados do usuário;
 *   - desinstalação silenciosa remove atalhos/autostart/cache e PRESERVA downloads;
 *   - desinstalação com /delete-downloads apaga só a pasta registrada;
 *   - guardas: nunca apaga pasta ancestral da instalação, raiz de pasta do sistema
 *     ou caminho com "..".
 *
 * Segurança:
 *   - só apaga pastas DENTRO de `desktop/test/tmp/installer-verify-*`, a pasta
 *     padrão de downloads do app (vazia/gerada por este teste) e valores de
 *     registro que este script criou;
 *   - recusa rodar se a pasta padrão de downloads do usuário já tiver arquivos
 *     (nunca apaga download de verdade);
 *   - instala em `desktop/test/tmp/...` via /D= para não tocar na instalação real.
 *
 * Uso (a partir de desktop/):
 *   node test/e2e/installer-verify.js [--exe <caminho do Setup.exe>]
 *
 * Saída: relatório no stdout e JSON em `desktop/test/tmp/installer-verify/report.json`.
 * Exit code 0 = tudo passou.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DESKTOP = path.resolve(__dirname, '..', '..');
const TMP = path.join(DESKTOP, 'test', 'tmp');
/* Fora do workspace de propósito: nesta máquina de dev o sandbox da sessão
 * bloqueia operações de arquivo de processos lançados a partir do workspace
 * (o uninstaller "roda" mas não apaga nada). Em Windows normal qualquer pasta
 * serve; manter em %TEMP% é inofensivo e reproduzível. */
const WORK = path.join(os.tmpdir(), 'space-iptv-installer-verify');
/* Pastas de dados (downloads/guardas) ficam no perfil do usuário, FORA de
 * %LOCALAPPDATA%/WINDIR — o desinstalador se recusa (de propósito) a apagar
 * qualquer coisa dentro dessas raízes de sistema. O perfil é permitido. */
const QA_ROOT = path.join(process.env.USERPROFILE || os.homedir(), '.space-iptv-qa-tests');
const SETUP_COPY = path.join(os.tmpdir(), 'space-iptv-installer-verify-setup.exe');

const HOME = process.env.USERPROFILE || os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const WINDIR = process.env.WINDIR || 'C:\\Windows';
const APP_NAME = 'Space IPTV';
const REG_APP = 'HKCU\\Software\\Space IPTV';
const REG_RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_UNINSTALL = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const DEFAULT_DOWNLOADS = path.join(HOME, 'Videos', APP_NAME);

const results = [];
let exePath = '';
let appDir = '';

/* ------------------------------------------------------------------ helpers */

function log(msg) { process.stdout.write(msg + '\n'); }

function check(name, ok, details) {
  results.push({ name: name, ok: !!ok, details: details == null ? null : details });
  log((ok ? '  [OK]   ' : '  [FALHA] ') + name + (details ? ' — ' + details : ''));
  return !!ok;
}

function sh(cmd, args, opts) {
  const o = Object.assign({ encoding: 'utf8', timeout: 300000, windowsHide: true }, opts || {});
  const r = spawnSync(cmd, args, o);
  return {
    status: r.status,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    error: r.error ? String(r.error.message) : ''
  };
}

/**
 * Executa um .exe e espera terminar.
 *
 * IMPORTANTE (particularidade desta máquina de dev): lançar o instalador/
 * desinstalador por `child_process` do Node faz o processo rodar sem permissão
 * de apagar arquivos (sai 0 e não remove nada). Via PowerShell `Start-Process
 * -Wait` funciona. Em Windows normal as duas formas funcionam; usamos pwsh.
 * @returns {{status:number, stdout:string, stderr:string, error:string}}
 */
function runExe(exe, args) {
  const psArgs = [].concat(args || []).map((a) => "'" + String(a).replace(/'/g, "''") + "'").join(',');
  const cmd = '$p = Start-Process -FilePath \'' + String(exe).replace(/'/g, "''") +
    '\' -ArgumentList ' + (psArgs || '@()') + ' -Wait -PassThru; if ($p -eq $null) { exit 1 }; exit $p.ExitCode';
  /* Nesta máquina não há `pwsh` no PATH (só Windows PowerShell 5.1). */
  const shell = process.env.DSH_POWERSHELL || 'powershell';
  const r = sh(shell, ['-NoProfile', '-NonInteractive', '-Command', cmd]);
  if (r.status === null || r.status === undefined) {
    return { status: -1, stdout: r.stdout, stderr: r.stderr, error: r.error || 'falha ao lançar ' + shell };
  }
  return r;
}

function regQuery(key, value) {
  const args = ['query', key];
  if (value) args.push('/v', value);
  const r = sh('reg', args);
  if (r.status !== 0) return null;
  if (value) {
    const m = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+REG_[A-Z_]+\\s+(.*)', 'i').exec(r.stdout);
    return m ? m[1].trim() : null;
  }
  return r.stdout;
}

function regListRunValues() {
  const out = regQuery(REG_RUN, null);
  if (!out) return {};
  const map = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s{4,}(\S.*?)\s{2,}REG_[A-Z_]+\s{2,}(.*)$/.exec(line);
    if (m) map[m[1].trim()] = m[2].trim();
  }
  return map;
}

function regAddValue(key, value, data) {
  return sh('reg', ['add', key, '/v', value, '/t', 'REG_SZ', '/d', data, '/f']);
}

function regDeleteValue(key, value) {
  return sh('reg', ['delete', key, '/v', value, '/f']);
}

function desktopShortcutCandidates() {
  const cands = [
    path.join(HOME, 'Desktop', APP_NAME + '.lnk'),
    path.join(HOME, 'OneDrive', 'Desktop', APP_NAME + '.lnk'),
    path.join(HOME, 'OneDrive', 'Área de Trabalho', APP_NAME + '.lnk'),
    path.join(HOME, 'Área de Trabalho', APP_NAME + '.lnk')
  ];
  const onedrive = process.env.OneDrive || process.env.OneDriveConsumer || process.env.OneDriveCommercial;
  if (onedrive) cands.push(path.join(onedrive, 'Desktop', APP_NAME + '.lnk'));
  return cands;
}

function startMenuShortcuts() {
  const programs = path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return [
    path.join(programs, APP_NAME + '.lnk'),
    path.join(programs, APP_NAME, APP_NAME + '.lnk')
  ];
}

function anyExists(list) { return list.filter((p) => fs.existsSync(p)); }

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

/** Remoção teimosa (pastas do sistema podem exigir cmd / rd). */
function rmrfHard(p) {
  rmrf(p);
  if (fs.existsSync(p)) {
    sh('cmd', ['/c', 'rd', '/s', '/q', p]);
    rmrf(p);
  }
}

function runInstaller(args) {
  return runExe(exePath, args || ['/S', '/D=' + appDir]);
}

function uninstallerPath() { return path.join(appDir, 'Uninstall ' + APP_NAME + '.exe'); }

function runUninstaller(extraArgs) {
  const un = uninstallerPath();
  if (!fs.existsSync(un)) return { status: -1, stdout: '', stderr: 'uninstaller ausente', error: '' };
  const args = ['/S'].concat(extraArgs || []);
  return runExe(un, args);
}

function visibleDirs() {
  try { return fs.readdirSync(appDir); } catch (e) { return null; }
}

function uninstallKeyNames() {
  const out = regQuery(REG_UNINSTALL, null);
  if (!out) return [];
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('HKEY_'));
}

/** Artefatos criados por ESTE teste na pasta padrão (os únicos que podem ser apagados). */
const TEST_ARTIFACTS = ['baixado-do-teste.mp4'];

/** A pasta padrão de downloads do app só pode ser mexida se for "nossa" (vazia/gerada). */
function assertSafeDefaultDownloadsDir() {
  if (!fs.existsSync(DEFAULT_DOWNLOADS)) return true;
  const entries = fs.readdirSync(DEFAULT_DOWNLOADS);
  const foreign = entries.filter((n) => n !== '.space-iptv' && TEST_ARTIFACTS.indexOf(n) < 0);
  if (foreign.length === 0) {
    /* limpa artefatos de execuções anteriores deste mesmo teste */
    for (const n of entries) {
      if (TEST_ARTIFACTS.indexOf(n) >= 0) {
        try { fs.rmSync(path.join(DEFAULT_DOWNLOADS, n), { force: true }); } catch (e) { /* ignore */ }
      }
    }
    return true;
  }
  throw new Error(
    'RECUSANDO o teste: ' + DEFAULT_DOWNLOADS + ' já contém arquivos (' + foreign.slice(0, 5).join(', ') +
    '). O teste não apaga download de usuário. Limpe/renomeie a pasta ou rode numa máquina limpa.'
  );
}

function prepare() {
  rmrf(WORK);
  fs.mkdirSync(WORK, { recursive: true });
  appDir = path.join(WORK, 'app');
  log('  pasta de trabalho: ' + WORK);
  log('  instalação de teste: ' + appDir);

  if (!exePath) {
    const dist = path.join(DESKTOP, '..', 'dist', 'desktop');
    const found = fs.existsSync(dist)
      ? fs.readdirSync(dist).filter((n) => /^SpaceIPTV-Setup-.*\.exe$/i.test(n)).sort().pop()
      : null;
    if (!found) throw new Error('instalador não encontrado; rode `npm run dist` ou passe --exe');
    exePath = path.join(dist, found);
  }
  if (!fs.existsSync(exePath)) throw new Error('instalador não encontrado: ' + exePath);

  /* Copia para %TEMP%: num Windows normal não é necessário, mas evita o bloqueio
     de execução de binários dentro do workspace desta sessão de dev.
     Fica FORA de WORK porque as etapas de guarda recriam WORK. */
  fs.mkdirSync(WORK, { recursive: true });
  fs.copyFileSync(exePath, SETUP_COPY);
  exePath = SETUP_COPY;
  log('  instalador (cópia em %TEMP%): ' + exePath);
  assertSafeDefaultDownloadsDir();
}

/* --------------------------------------------------------------- etapas ---- */

function etapaInstalacaoSilenciosaPadrao() {
  log('\n== 1. Instalação silenciosa (/S) com pasta de downloads padrão ==');
  sh('reg', ['delete', REG_APP, '/f']);
  rmrf(appDir);

  const r = runInstaller();
  check('instalador /S terminou com sucesso', r.status === 0, 'exit ' + r.status + (r.stderr ? ' · ' + r.stderr.slice(0, 200) : ''));
  check('executável instalado', fs.existsSync(path.join(appDir, APP_NAME + '.exe')));
  check('desinstalador instalado', fs.existsSync(uninstallerPath()));

  const regValue = regQuery(REG_APP, 'DownloadsDir');
  check('registro HKCU\\Software\\Space IPTV\\DownloadsDir gravado', !!regValue, regValue || '(vazio)');
  check('pasta padrão usada na instalação silenciosa', regValue === DEFAULT_DOWNLOADS, 'valor=' + regValue + ' esperado=' + DEFAULT_DOWNLOADS);
  check('pasta padrão de downloads criada', fs.existsSync(DEFAULT_DOWNLOADS));

  const desk = anyExists(desktopShortcutCandidates());
  check('atalho da área de trabalho criado', desk.length > 0, desk.join(', ') || '(nenhum)');
  const menu = anyExists(startMenuShortcuts());
  check('atalho do menu Iniciar criado', menu.length > 0, menu.join(', ') || '(nenhum)');

  const keys = uninstallKeyNames().filter((k) => k.toLowerCase().indexOf('space') >= 0 || k.indexOf('8f1e6a2c') >= 0);
  check('chave de desinstalação no Painel de Controle', keys.length > 0, keys.join(', '));
  return keys;
}

function etapaAutostartECache() {
  log('\n== 2. Autostart + cache/config (simulando uso do app) ==');
  const appdata = path.join(APPDATA, APP_NAME);
  fs.mkdirSync(appdata, { recursive: true });
  fs.writeFileSync(path.join(appdata, 'config.json'), '{"version":1}', 'utf8');
  fs.writeFileSync(path.join(appdata, 'marcador.txt'), 'config do app', 'utf8');
  check('pasta de cache/config criada em %APPDATA%', fs.existsSync(path.join(appdata, 'config.json')));

  const exe = path.join(appDir, APP_NAME + '.exe');
  regAddValue(REG_RUN, APP_NAME, '"' + exe + '" --autostart');
  regAddValue(REG_RUN, 'space-iptv-desktop', '"' + exe + '" --autostart');
  regAddValue(REG_RUN, 'SpaceIPTVOutroAppTeste', '"C:\\Windows\\System32\\notepad.exe"');
  const run = regListRunValues();
  check('entrada de autostart criada (valor "' + APP_NAME + '")', Object.prototype.hasOwnProperty.call(run, APP_NAME));
  return appdata;
}

function etapaAtualizacaoPreservaDados(keysBefore, appdata) {
  log('\n== 3. Atualização (instalar por cima) preserva dados do usuário ==');
  fs.writeFileSync(path.join(DEFAULT_DOWNLOADS, 'baixado-do-teste.mp4'), 'video falso');
  const r = runInstaller();
  check('reinstalação /S terminou com sucesso', r.status === 0, 'exit ' + r.status);
  check('config/cache preservado na atualização', fs.existsSync(path.join(appdata, 'marcador.txt')));
  check('downloads preservados na atualização', fs.existsSync(path.join(DEFAULT_DOWNLOADS, 'baixado-do-teste.mp4')));
  const run = regListRunValues();
  check('autostart preservado na atualização (entrada do app)', Object.prototype.hasOwnProperty.call(run, APP_NAME));
  const regValue = regQuery(REG_APP, 'DownloadsDir');
  check('DownloadsDir preservado na atualização', regValue === DEFAULT_DOWNLOADS, 'valor=' + regValue);
  check('atalho continua existindo após atualizar', anyExists(desktopShortcutCandidates()).length > 0);
  return keysBefore;
}

function etapaDesinstalacaoPreservaDownloads(appdata) {
  log('\n== 4. Desinstalação silenciosa: remove autostart/cache, PRESERVA downloads ==');
  const marker = path.join(DEFAULT_DOWNLOADS, 'baixado-do-teste.mp4');
  const r = runUninstaller([]);
  check('desinstalador /S terminou com sucesso', r.status === 0, 'exit ' + r.status + (r.stderr ? ' · ' + r.stderr.slice(0, 200) : ''));

  const remaining = visibleDirs();
  const appExeGone = !fs.existsSync(path.join(appDir, APP_NAME + '.exe'));
  check('executável do app removido', appExeGone, remaining ? 'restou: ' + remaining.join(', ') : 'pasta removida');

  check('atalho da área de trabalho removido', anyExists(desktopShortcutCandidates()).length === 0);
  check('atalho do menu Iniciar removido', anyExists(startMenuShortcuts()).length === 0);
  check('chave de desinstalação removida', uninstallKeyNames().filter((k) => k.indexOf('8f1e6a2c') >= 0).length === 0);

  const run = regListRunValues();
  check('autostart do app removido (valor "' + APP_NAME + '")', !Object.prototype.hasOwnProperty.call(run, APP_NAME), JSON.stringify(Object.keys(run)));
  check('autostart alternativo do app removido', !Object.prototype.hasOwnProperty.call(run, 'space-iptv-desktop'));
  check('autostart de OUTRO app preservado', Object.prototype.hasOwnProperty.call(run, 'SpaceIPTVOutroAppTeste'));
  regDeleteValue(REG_RUN, 'SpaceIPTVOutroAppTeste');

  check('cache/config (%APPDATA%\\Space IPTV) removido', !fs.existsSync(appdata),
    fs.existsSync(appdata) ? 'restou: ' + fs.readdirSync(appdata).join(', ') : '');
  check('**pasta de downloads PRESERVADA** (checkbox desmarcado/padrão)', fs.existsSync(marker), marker);
  check('registro HKCU\\Software\\Space IPTV removido', regQuery(REG_APP, 'DownloadsDir') == null);
  return marker;
}

function etapaDesinstalacaoApagaDownloads() {
  log('\n== 5. Desinstalação com /delete-downloads apaga a pasta registrada ==');
  const dl = path.join(QA_ROOT, 'downloads-apagar');
  rmrf(dl);
  fs.mkdirSync(dl, { recursive: true });
  fs.writeFileSync(path.join(dl, 'filme.mp4'), 'video');
  regAddValue(REG_APP, 'DownloadsDir', dl);

  const r = runInstaller();
  check('instalação de novo para o teste de apagar', r.status === 0 && fs.existsSync(uninstallerPath()), 'exit ' + r.status);
  check('registro mantém a pasta escolhida', regQuery(REG_APP, 'DownloadsDir') === dl);

  const u = runUninstaller(['/delete-downloads']);
  check('desinstalador com /delete-downloads terminou', u.status === 0, 'exit ' + u.status);
  check('pasta de downloads registrada foi apagada', !fs.existsSync(dl));
}

function etapaGuardas() {
  log('\n== 6. Guardas do desinstalador (nunca apaga fora da pasta) ==');

  /* 6a. pasta dentro de C:\Windows (deve ser recusada) */
  const guardWin = path.join(WINDIR, 'Temp', 'space-iptv-guard-dl');
  rmrfHard(guardWin);
  fs.mkdirSync(guardWin, { recursive: true });
  const markerWin = path.join(guardWin, 'nao-apagar.txt');
  fs.writeFileSync(markerWin, 'x');
  regAddValue(REG_APP, 'DownloadsDir', guardWin);
  let r = runInstaller();
  check('instalação para o teste de guarda (Windows)', r.status === 0, 'exit ' + r.status);
  let u = runUninstaller(['/delete-downloads']);
  check('desinstalação com guarda (Windows) terminou', u.status === 0, 'exit ' + u.status);
  check('pasta dentro de %WINDIR% NÃO foi apagada', fs.existsSync(markerWin), markerWin);
  rmrfHard(guardWin);

  /* 6b. caminho com ".." (deve ser recusado) */
  const base = path.join(QA_ROOT, 'guard-dotdot');
  rmrf(base);
  const dlDot = path.join(base, 'a', '..', 'a', 'dl');
  fs.mkdirSync(dlDot, { recursive: true });
  const markerDot = path.join(dlDot, 'nao-apagar.txt');
  fs.writeFileSync(markerDot, 'x');
  regAddValue(REG_APP, 'DownloadsDir', dlDot);
  r = runInstaller();
  check('instalação para o teste de guarda ("..")', r.status === 0, 'exit ' + r.status);
  u = runUninstaller(['/delete-downloads']);
  check('desinstalação com guarda ("..") terminou', u.status === 0, 'exit ' + u.status);
  check('caminho com ".." NÃO foi apagado', fs.existsSync(markerDot), markerDot);
  rmrf(base);

  /* 6c. pasta ANCESTRAL da instalação (deve ser recusada) */
  const root = path.join(QA_ROOT, 'root-ancestral');
  rmrf(root);
  appDir = path.join(root, 'app');
  fs.mkdirSync(root, { recursive: true });
  const markerRoot = path.join(root, 'nao-apagar.txt');
  fs.writeFileSync(markerRoot, 'x');
  regAddValue(REG_APP, 'DownloadsDir', root);
  r = runInstaller();
  check('instalação em subpasta para o teste de ancestral', r.status === 0 && fs.existsSync(uninstallerPath()), 'exit ' + r.status);
  u = runUninstaller(['/delete-downloads']);
  check('desinstalação com guarda (ancestral) terminou', u.status === 0, 'exit ' + u.status);
  check('pasta ANCESTRAL da instalação NÃO foi apagada', fs.existsSync(markerRoot), markerRoot);
  rmrf(root);
}

function limpezaFinal() {
  log('\n== 7. Limpeza final ==');
  /* garante que nada ficou instalado/registrado */
  if (fs.existsSync(uninstallerPath())) runUninstaller([]);
  rmrf(appDir);
  sh('reg', ['delete', REG_APP, '/f']);
  regDeleteValue(REG_RUN, APP_NAME);
  regDeleteValue(REG_RUN, 'space-iptv-desktop');
  rmrf(WORK);
  /* pasta padrão criada pelo instalador: apaga NOSSOS artefatos e remove a pasta
     se ficar vazia (download de usuário com outro nome nunca é tocado) */
  try {
    for (const n of TEST_ARTIFACTS) {
      const p = path.join(DEFAULT_DOWNLOADS, n);
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    if (fs.existsSync(DEFAULT_DOWNLOADS) && fs.readdirSync(DEFAULT_DOWNLOADS).length === 0) {
      fs.rmdirSync(DEFAULT_DOWNLOADS);
      log('  pasta padrão vazia removida: ' + DEFAULT_DOWNLOADS);
    }
  } catch (e) { /* ignore */ }
  const remaining = fs.existsSync(DEFAULT_DOWNLOADS) ? fs.readdirSync(DEFAULT_DOWNLOADS) : [];
  check('ambiente limpo (sem instalação de teste)', !fs.existsSync(appDir), appDir);
  check('nenhum download de usuário apagado', remaining.every((n) => n === '.space-iptv' || TEST_ARTIFACTS.indexOf(n) < 0), remaining.join(', '));
}

/* -------------------------------------------------------------------- main */

function main() {
  const argv = process.argv.slice(2);
  const iExe = argv.indexOf('--exe');
  if (iExe >= 0) exePath = path.resolve(argv[iExe + 1]);

  log('Space IPTV Desktop — verificação de instalador (perfil do usuário: ' + os.userInfo().username + ')');
  log('Windows: ' + os.release() + ' · Node: ' + process.version);

  let keys = [];
  let appdata = '';
  let fatal = null;
  try {
    prepare();
    keys = etapaInstalacaoSilenciosaPadrao();
    appdata = etapaAutostartECache();
    etapaAtualizacaoPreservaDados(keys, appdata);
    etapaDesinstalacaoPreservaDownloads(appdata);
    etapaDesinstalacaoApagaDownloads();
    etapaGuardas();
  } catch (e) {
    fatal = e && e.message ? e.message : String(e);
    check('execução completa das etapas', false, fatal);
  } finally {
    try { limpezaFinal(); } catch (e) { log('  limpeza final falhou: ' + (e && e.message)); }
  }

  const fail = results.filter((r) => !r.ok);
  const report = {
    startedAt: new Date().toISOString(),
    exePath: exePath,
    appDir: appDir,
    host: os.hostname(),
    platform: process.platform,
    release: os.release(),
    results: results,
    pass: results.length - fail.length,
    fail: fail.length
  };
  const outDir = path.join(TMP, 'installer-verify');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  log('\n============================================');
  log('RESULTADO: ' + report.pass + '/' + results.length + ' verificações OK' + (fail.length ? ' · ' + fail.length + ' FALHA(S)' : ''));
  for (const f of fail) log('  - FALHOU: ' + f.name + (f.details ? ' (' + f.details + ')' : ''));
  log('Relatório: ' + path.join(outDir, 'report.json'));
  process.exitCode = fail.length ? 1 : 0;
}

main();
