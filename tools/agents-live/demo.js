#!/usr/bin/env node
/* Simulador de agentes para validar o painel. Estado 100% fictício.
 * Uso: node tools/agents-live/demo.js [--seconds 30]
 * Ao encerrar (SIGINT, SIGTERM ou --seconds), remove apenas os estados demo-*.
 */
'use strict';

const report = require('./report.js');

const AGENTS = [
  {
    agent: 'demo-orquestrador',
    role: 'Orquestração e integração',
    phase: 'F1',
    files: ['tools/agents-live/*', 'web/NOTES.md'],
    tasks: ['Congelando contratos da seção 6', 'Revisando diff do shell', 'Integrando player e rede']
  },
  {
    agent: 'demo-shell',
    role: 'Shell web',
    phase: 'F1',
    files: ['web/index.html', 'web/js/shell.js'],
    tasks: ['Montando palco 1920x1080', 'Ligando menu e HUD', 'Testando foco do teclado']
  },
  {
    agent: 'demo-player',
    role: 'Player web',
    phase: 'F2',
    files: ['web/js/player.js', 'web/vendor/hls.min.js'],
    tasks: ['Integrando hls.js', 'Ajustando painel de canais', 'Testando reconexão de live']
  },
  {
    agent: 'demo-net',
    role: 'Rede e proxy local',
    phase: 'F4',
    files: ['web/server.js', 'web/js/net.js'],
    tasks: ['Servidor estático na 8095', 'Testando CORS', 'Reescrevendo playlist no proxy']
  },
  {
    agent: 'demo-qa',
    role: 'QA e auditoria UI/UX',
    phase: 'F5',
    files: ['web/smoke.js', 'web/UI-UX-AUDIT.md'],
    tasks: ['Matriz de navegadores', 'Auditando contraste e foco', 'Capturando telas']
  }
];

const STATUS_PLAN = {
  'demo-net': [{ tick: 3, status: 'blocked', note: 'Aguardando contrato de rede congelado' }, { tick: 6, status: 'working', note: '' }, { tick: 10, status: 'done', note: 'Proxy validado com playlist HLS' }],
  'demo-shell': [{ tick: 5, status: 'done', note: 'Navegação por teclado validada' }],
  'demo-player': [{ tick: 8, status: 'error', note: 'Stream de teste respondeu 404' }, { tick: 10, status: 'working', note: '' }],
  'demo-qa': [{ tick: 4, status: 'working', note: '' }, { tick: 12, status: 'done', note: 'Auditoria registrada' }]
};

const startedAt = Date.now();
let tick = 0;
let timer = null;
let closing = false;
let seconds = 0;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--seconds' || argv[i] === '-s') seconds = Number(argv[++i]) || 0;
  else if (argv[i].startsWith('--seconds=')) seconds = Number(argv[i].slice(10)) || 0;
  else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('Uso: node tools/agents-live/demo.js [--seconds N]');
    console.log('Cria 5 agentes fictícios, cicla status/tarefa a cada 1,5 s e limpa demo-* ao encerrar.');
    process.exit(0);
  }
}

const runtime = new Map();
for (const def of AGENTS) {
  runtime.set(def.agent, {
    status: def.agent === 'demo-qa' ? 'idle' : 'working',
    progress: def.agent === 'demo-qa' ? 0 : 6,
    note: ''
  });
}

function writeAll() {
  for (let i = 0; i < AGENTS.length; i++) {
    const def = AGENTS[i];
    const run = runtime.get(def.agent);
    let status = run.status;
    let note = run.note;

    const plan = STATUS_PLAN[def.agent] || [];
    const step = plan.filter((p) => p.tick === tick)[0];
    if (step) {
      status = step.status;
      note = step.note;
    } else if (tick === 16) {
      status = def.agent === 'demo-qa' ? 'idle' : 'working';
      note = '';
    } else if (status === 'done' || status === 'error') {
      status = 'working';
      note = '';
    }

    let progress = run.progress;
    if (status === 'working') progress = Math.min(96, progress + 2 + ((tick + i) % 5));
    if (status === 'done') progress = 100;
    if (status === 'blocked') progress = Math.min(progress, 62);
    if (status === 'error') progress = Math.min(progress, 70);
    if (status === 'idle') progress = 0;

    const task = def.tasks[tick % def.tasks.length];
    run.status = status;
    run.progress = progress;
    run.note = note;

    report.applyState({
      agent: def.agent,
      role: def.role,
      status: status,
      phase: def.phase,
      task: status === 'idle' ? 'Aguardando dependências' : task,
      progress: progress,
      files: def.files,
      note: note
    });
  }
}

function cleanupEvents() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, 'state', 'events.ndjson');
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    const kept = lines.filter((line) => {
      try {
        const ev = JSON.parse(line);
        return String(ev.agent || '').indexOf('demo-') !== 0;
      } catch (e) {
        return false;
      }
    });
    fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '');
  } catch (e) { /* timeline pode não existir */ }
}

function shutdown(code) {
  if (closing) return;
  closing = true;
  if (timer) clearInterval(timer);
  for (const def of AGENTS) report.removeState(def.agent);
  cleanupEvents();
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log('\n[demo] encerrado após ' + elapsed + 's; estados demo-* removidos.');
  process.exit(code || 0);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[demo] criando 5 agentes fictícios em tools/agents-live/state (1,5 s por ciclo).');
console.log('[demo] painel: http://127.0.0.1:8096/ — Ctrl+C encerra e limpa os estados demo-*.');

writeAll();
tick = 1;
timer = setInterval(() => {
  tick = tick >= 16 ? 1 : tick + 1;
  writeAll();
}, 1500);

if (seconds > 0) {
  setTimeout(() => shutdown(0), seconds * 1000).unref();
}
