#!/usr/bin/env node
/* CLI de reporte dos agentes. Zero dependências.
 *
 * Exemplo:
 *   node tools/agents-live/report.js --agent player --role "Player web" \
 *     --status working --phase F2 --task "Integrando hls.js" --progress 40 \
 *     --files web/js/player.js
 *
 * --list                     imprime o estado atual
 * --remove [--agent slug]    remove o estado de um agente (ou de todos)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, 'state');
const EVENTS_FILE = path.join(STATE_DIR, 'events.ndjson');
const STATUSES = ['idle', 'working', 'blocked', 'done', 'error'];

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function slugOf(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agente';
}

function statePath(agent) {
  return path.join(STATE_DIR, slugOf(agent) + '.json');
}

function readState(agent) {
  try {
    return JSON.parse(fs.readFileSync(statePath(agent), 'utf8'));
  } catch (e) {
    return null;
  }
}

function listStates() {
  ensureDir();
  const out = [];
  for (const name of fs.readdirSync(STATE_DIR)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), 'utf8'));
      if (data && data.agent) out.push(data);
    } catch (e) { /* ignora */ }
  }
  out.sort((a, b) => {
    const ao = a.agent === 'orquestrador' ? 0 : 1;
    const bo = b.agent === 'orquestrador' ? 0 : 1;
    return ao - bo || String(a.agent).localeCompare(String(b.agent));
  });
  return out;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback ocupado */ }
  }
}

function writeState(data) {
  ensureDir();
  const file = statePath(data.agent);
  const tmp = file + '.' + process.pid + '.tmp';
  const json = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, json);

  /* No Windows, renomear sobre um arquivo que o servidor acabou de ler pode
   * falhar transitoriamente (EPERM/EBUSY). Tenta de novo e, em último caso,
   * grava direto (o conteúdo é pequeno e completo). */
  let renamed = false;
  for (let attempt = 0; attempt < 6 && !renamed; attempt++) {
    try {
      fs.renameSync(tmp, file);
      renamed = true;
    } catch (e) {
      if (['EPERM', 'EBUSY', 'EACCES'].indexOf(e.code) === -1 || attempt === 5) {
        fs.writeFileSync(file, json);
        try { fs.unlinkSync(tmp); } catch (ignore) { /* ignore */ }
        renamed = true;
      } else {
        sleepSync(35);
      }
    }
  }

  const event = {
    ts: data.updatedAt,
    agent: data.agent,
    role: data.role,
    status: data.status,
    phase: data.phase,
    task: data.task,
    progress: data.progress,
    note: data.note
  };
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n');
  } catch (e) { /* timeline é opcional; estado já foi gravado */ }
  return file;
}

/* Aplica uma atualização preservando startedAt e stateSince. */
function applyState(input) {
  if (!input || !input.agent) throw new Error('--agent é obrigatório');
  const current = readState(input.agent) || {};
  const now = Date.now();
  const status = input.status || current.status || 'idle';
  if (STATUSES.indexOf(status) === -1) {
    throw new Error('status inválido: ' + status + ' (use ' + STATUSES.join('|') + ')');
  }

  let progress = input.progress;
  if (progress == null || progress === '' || !isFinite(Number(progress))) {
    progress = current.progress != null ? current.progress : 0;
  }
  progress = Math.max(0, Math.min(100, Math.round(Number(progress))));

  const files = input.files && input.files.length
    ? input.files.slice()
    : (Array.isArray(current.files) ? current.files : []);

  let note;
  if (input.note != null) note = String(input.note);
  else if (status === 'blocked' || status === 'error') note = current.note || '';
  else note = '';

  const data = {
    agent: input.agent,
    role: input.role || current.role || input.agent,
    status: status,
    phase: input.phase != null ? String(input.phase) : (current.phase || ''),
    task: input.task != null ? String(input.task) : (current.task || ''),
    progress: progress,
    files: files,
    note: note,
    startedAt: current.startedAt || now,
    stateSince: current.status === status ? (current.stateSince || current.startedAt || now) : now,
    updatedAt: now
  };
  writeState(data);
  return data;
}

function removeState(agent) {
  try {
    fs.unlinkSync(statePath(agent));
    return true;
  } catch (e) {
    return false;
  }
}

function removeAllStates() {
  let count = 0;
  ensureDir();
  for (const name of fs.readdirSync(STATE_DIR)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      fs.unlinkSync(path.join(STATE_DIR, name));
      count++;
    } catch (e) { /* ignore */ }
  }
  return count;
}

function parseArgs(argv) {
  const out = { files: [] };
  const valueFlags = ['--agent', '--role', '--status', '--phase', '--task', '--progress', '--files', '--note'];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    } else if (valueFlags.indexOf(arg) !== -1) {
      value = argv[++i];
      if (value === undefined) throw new Error('faltou valor para ' + arg);
    }
    switch (arg) {
      case '--agent': out.agent = value; break;
      case '--role': out.role = value; break;
      case '--status': out.status = value; break;
      case '--phase': out.phase = value; break;
      case '--task': out.task = value; break;
      case '--progress': out.progress = value; break;
      case '--note': out.note = value; break;
      case '--files':
        for (const f of String(value).split(',')) {
          const clean = f.trim();
          if (clean) out.files.push(clean);
        }
        break;
      case '--list': out.list = true; break;
      case '--remove': out.remove = true; break;
      case '--help': case '-h': out.help = true; break;
      default:
        throw new Error('opção desconhecida: ' + arg);
    }
  }
  return out;
}

function usage() {
  console.log([
    'Uso: node tools/agents-live/report.js --agent SLUG --status STATUS [opções]',
    '',
    '  --agent     nome do agente (obrigatório; vira state/<slug>.json)',
    '  --role      papel legível (ex.: "Player web")',
    '  --status    idle | working | blocked | done | error',
    '  --phase     fase (ex.: F2)',
    '  --task      tarefa atual',
    '  --progress  0..100',
    '  --files     arquivos sob responsabilidade (vírgula ou repetir --files)',
    '  --note      nota curta (obrigatória para blocked/error)',
    '  --list      imprime o estado atual dos agentes',
    '  --remove    remove o estado do agente informado (ou de todos, sem --agent)',
    '  --help      esta ajuda'
  ].join('\n'));
}

function printStates() {
  const states = listStates();
  if (!states.length) {
    console.log('(sem estado — nenhum agente reportou ainda)');
    return;
  }
  for (const s of states) {
    console.log(
      String(s.agent).padEnd(16) + ' ' +
      String(s.status).padEnd(9) + ' ' +
      String(s.phase || '-').padEnd(4) + ' ' +
      String(s.progress || 0).padStart(3) + '%  ' +
      (s.task || '-') +
      (s.note ? '  [' + s.note + ']' : '')
    );
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('erro: ' + e.message);
    usage();
    process.exit(2);
  }

  if (args.help) return usage();
  if (args.list) return printStates();

  if (args.remove) {
    if (args.agent) {
      const ok = removeState(args.agent);
      console.log(ok ? 'removido: ' + args.agent : 'nada para remover: ' + args.agent);
    } else {
      const n = removeAllStates();
      console.log('removidos ' + n + ' estado(s)');
    }
    return;
  }

  if (!args.agent) {
    console.error('erro: --agent é obrigatório (ou use --list / --remove)');
    usage();
    process.exit(2);
  }

  if (args.status && STATUSES.indexOf(args.status) === -1) {
    console.error('erro: status inválido "' + args.status + '"; use ' + STATUSES.join('|'));
    process.exit(2);
  }

  try {
    const data = applyState(args);
    console.log(
      data.agent + ' → ' + data.status + ' · ' + data.progress + '%' +
      (data.phase ? ' · ' + data.phase : '') +
      (data.task ? ' · ' + data.task : '')
    );
  } catch (e) {
    console.error('erro: ' + e.message);
    process.exit(2);
  }
}

module.exports = {
  STATE_DIR,
  STATUSES,
  applyState,
  readState,
  writeState,
  removeState,
  removeAllStates,
  listStates,
  slugOf
};

if (require.main === module) main();
