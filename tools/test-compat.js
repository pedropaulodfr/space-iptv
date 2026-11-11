// Verifica se a interface Android usa algum recurso que a WebView do projetor
// HY300 nao entende. O aparelho roda Android 9 com Chrome 71 como WebView, e la
// nao existem: `inset`, `aspect-ratio`, `min()/max()/clamp()`, `gap` em flexbox,
// `backdrop-filter`, `:focus-visible`, `dvh`, `color-mix` nem a sintaxe moderna
// de JavaScript (`?.`, `??`, `replaceAll`, ...).
//
// Rodar: node tools\test-compat.js
// Sai com codigo 1 se encontrar algo (use nas mudancas da interface do APK).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'celular', 'app', 'src', 'main', 'assets', 'mobile');
const COMPARTILHADO = path.join(__dirname, '..', 'tv', 'js');

let falhas = 0;
let checagens = 0;

function falhar(arquivo, linha, texto, motivo) {
  falhas++;
  console.log('  FALHOU ' + path.basename(arquivo) + ':' + linha + '  ' + motivo);
  console.log('         ' + texto.trim().slice(0, 140));
}

function ok(nome) {
  checagens++;
  console.log('  ok   ' + nome);
}

/* Regras de CSS: [regex, explicacao] */
const REGRAS_CSS = [
  [/(^|[;{\s])inset\s*:/i, '`inset` nao existe no Chrome 71 (use top/right/bottom/left)'],
  [/aspect-ratio\s*:/i, '`aspect-ratio` nao existe no Chrome 71 (use padding-bottom num filho)'],
  [/\bwidth\s*:\s*(min|max|clamp)\(/i, '`min()/max()/clamp()` nao existem no Chrome 71'],
  [/\bheight\s*:\s*(min|max|clamp)\(/i, '`min()/max()/clamp()` nao existem no Chrome 71'],
  [/\bmax-width\s*:\s*(min|max|clamp)\(/i, '`min()/max()/clamp()` nao existem no Chrome 71'],
  [/\bmax-height\s*:\s*(min|max|clamp)\(/i, '`min()/max()/clamp()` nao existem no Chrome 71'],
  [/backdrop-filter\s*:/i, '`backdrop-filter` nao existe no Chrome 71'],
  [/:focus-visible/i, '`:focus-visible` nao existe no Chrome 71'],
  [/\b(100|1)0?dvh\b|dvh\s*[;)]/i, 'unidades `dvh/svh/lvh` nao existem no Chrome 71'],
  [/color-mix\(/i, '`color-mix()` nao existe no Chrome 71'],
  [/:is\(|:where\(/i, '`:is()/:where()` nao existem no Chrome 71'],
  [/position\s*:\s*sticky/i, 'sticky funciona, mas evite em listas virtualizadas'],
  [/\bgap\s*:\s*[^;}]*(?![^}]*grid)/i, null]   // tratado a parte (gap em flex)
];

/* Regras de JavaScript (sintaxe/API que o motor de 2018 nao tem) */
const REGRAS_JS = [
  [/\?\.\s*[A-Za-z_$(]/, 'encadeamento opcional (`?.`) e de 2020'],
  [/\?\?/, 'coalescencia nula (`??`) e de 2020'],
  [/\.replaceAll\s*\(/, '`String.replaceAll` e de 2020'],
  [/Object\.fromEntries\s*\(/, '`Object.fromEntries` e de 2019'],
  [/\.flatMap\s*\(|\.flat\s*\(/, '`Array.flat/flatMap` e de 2019'],
  [/\.matchAll\s*\(/, '`String.matchAll` e de 2020'],
  [/\.at\s*\(-?\d/, '`Array.at` e de 2021'],
  [/replaceChildren\s*\(/, '`Element.replaceChildren` e de 2020'],
  [/\bstructuredClone\s*\(/, '`structuredClone` e de 2022'],
  [/\bclass\s+[A-Za-z_$][\w$]*\s+extends\b[\s\S]{0,200}#/, 'campos privados de classe sao de 2022']
];

function linhas(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function arquivos(dir, ext) {
  const out = [];
  (function anda(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) anda(p);
      else if (p.endsWith(ext)) out.push(p);
    }
  })(dir);
  return out;
}

/* ---------------------------------------------------------------- CSS ---- */
console.log('CSS:');
for (const arq of arquivos(ROOT, '.css')) {
  const ls = linhas(arq);
  ls.forEach((linha, i) => {
    if (/^\s*\/\*/.test(linha) || /^\s*\*/.test(linha)) return;   // comentario
    for (const [re, motivo] of REGRAS_CSS) {
      if (!motivo) continue;
      if (re.test(linha)) falhar(arq, i + 1, linha, motivo);
    }
  });
}
ok('nenhum recurso de CSS posterior ao Chrome 71');

/* `gap` em flexbox: o CSS do app usa margem entre irmaos. `gap` so e aceito em
   grid (grid-gap/gap dentro de display:grid). */
for (const arq of arquivos(ROOT, '.css')) {
  const texto = fs.readFileSync(arq, 'utf8');
  let dentroDeGrid = 0;
  const ls = texto.split(/\r?\n/);
  ls.forEach((linha, i) => {
    if (/display\s*:\s*grid/.test(linha)) dentroDeGrid = 1;
    if (/\bgap\s*:/.test(linha) && !/grid-gap/.test(linha) && !dentroDeGrid) {
      falhar(arq, i + 1, linha, '`gap` em flexbox nao existe no Chrome 71 (use margem entre irmaos)');
    }
  });
}
ok('nenhum `gap` de flexbox (so grid)');

/* ----------------------------------------------------------- JavaScript --- */
console.log('JavaScript:');
const arquivosJs = arquivos(ROOT, '.js').concat(arquivos(COMPARTILHADO, '.js'));
for (const arq of arquivosJs) {
  const ls = linhas(arq);
  ls.forEach((linha, i) => {
    const semComentario = linha.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(linha)) return;
    for (const [re, motivo] of REGRAS_JS) {
      if (re.test(semComentario)) falhar(arq, i + 1, linha, motivo);
    }
  });
}
ok('nenhuma sintaxe/API de JavaScript posterior a 2018');

/* O index.html tem de carregar todos os scripts usados (senao a tela quebra
   so no aparelho, onde nao ha console). */
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const esperados = ['js/native.js', 'js/ui.js', 'js/focus.js', 'js/player.js', 'js/shell.js'];
const faltando = esperados.filter((e) => !scripts.includes(e));
if (faltando.length) { falhas++; console.log('  FALHOU index.html sem: ' + faltando.join(', ')); }
else ok('index.html carrega a camada Android inteira (' + scripts.length + ' scripts)');

console.log('');
console.log(falhas ? falhas + ' PROBLEMA(S) de compatibilidade' : 'TODOS OS TESTES DE COMPATIBILIDADE PASSARAM (' + (checagens + 1) + ' grupos)');
process.exit(falhas ? 1 : 0);
