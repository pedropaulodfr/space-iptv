# UI/UX Audit — Space IPTV Desktop (F1–F3)

**Escopo:** camada desktop do renderer (`desktop/src/renderer/`): shell/palco, HUD,
sidebar, telas herdadas de `tv/`/`web/`, login desktop, estados de tela e convenções
para Downloads/EPG. **Não** cobre o instalador nem o painel de agentes.
**Base:** skill `ui-ux-pro-max` (checklist das 10 categorias) carregada nesta execução;
medições anteriores de `web/UI-UX-AUDIT.md` usadas como linha de base.
**Branch:** `feat/desktop-app`. **Dono:** agente `ui-ux`.

## 0. Método e honestidade

| Ferramenta | O que faz | Evidência |
|---|---|---|
| `desktop/test/tmp/ui-contrast.js` | contraste WCAG 2.1 **com composição alpha**, sobre as superfícies reais (glass sobre preto/planeta, glow do login, badges, modal) | `desktop/test/tmp/shots/contraste.txt` |
| `desktop/test/tmp/ui-visual.js` | Edge headless via CDP (zero deps): monta o palco com os 4 CSS reais na ordem do `index.html`, aplica a **mesma escala** de `web/js/shell.js`, mede fontes efetivas/alvos/foco/cursor/overflow/estados em 1366×768 e 1280×720, testa reduced-motion e carrega o `login.html` real (links remapeados) em 1366×768 e 1024×640; salva capturas | `shots/ui-visual.txt` (**43/43**), `shots/medicoes-*.json`, `shots/*.png` |
| `desktop/test/tmp/ui-css-check.js` | checagem estática: chaves, `@import` do login, ausência de token/fonte novos, classes obrigatórias, ordem dos `<link>` | `shots/css-check.txt` |

**Honestidade:** o **Electron real não foi aberto por este agente** (para não disputar a
máquina com o lead/qa-release, conforme o combinado). O CSS foi validado em Chromium
headless com o mesmo DOM do shell e a mesma escala; capturas do app real em
1366×768/1280×720 continuam como **pendência P1 para o lead/qa-release** (§9.1).
`css/epg.css` foi entregue **durante** esta auditoria e está auditado no §8.1
(23 pares de contraste + alvos/foco); `css/downloads.css` ainda **não existia** —
a auditoria dele fica pendente (§9.6). Nada aqui foi medido "no olho": cada número
veio dos scripts acima.

## 1. Arquivos entregues

| Arquivo | Conteúdo |
|---|---|
| `desktop/src/renderer/css/desktop.css` | camada desktop: janela/palco, cursor, HUD, foco global, estados `desktop-*`, utilitários 4/8/44 px, tipografia compensada, reduced-motion |
| `desktop/src/renderer/css/login.css` | `@import url("../web/css/login.css")` + camada desktop do login (foco, alvos, placeholder, rodapé, scrollbar) |
| `desktop/src/renderer/css/epg.css` (agente **epg**, auditado; não editado) | cards "Agora/A seguir", barra da TV ao vivo e tela Guia — achados no §8.1 |
| `desktop/docs/UI-UX-NOTES.md` | convenções para downloads/epg/auth seguirem |
| `desktop/docs/UI-UX-AUDIT.md` | este arquivo |
| `desktop/test/tmp/ui-*.js` | scripts de medição (temporários, `test/tmp` é gitignored) |

Nenhum arquivo de outro agente foi editado. Nenhum token/fonte/paleta novo:
`ui-css-check` confirma "nenhum token/variável nova definido" e "sem @font-face".

## 2. Resultado por categoria (10 prioridades)

| # | Categoria | Status | Evidência |
|---|---|---|---|
| 1 | Acessibilidade | **ok com 1 pendência** | Contraste medido **5,51:1 a 18,79:1** no texto em uso (pior = `--muted` sobre o planeta decorativo); todas as falhas encontradas foram corrigidas (§4). Foco visível medido no `#hud-fs` via **Tab real**: `outline: 2px solid rgb(66,133,255)` + `offset: 2px`; campo do login com borda `rgba(66,133,255,.9)` + anel `0 0 0 3px rgba(66,133,255,.28)`. Pendência: menu lateral não recebe `Tab` (`tabindex="-1"` em `web/js/shell.js:75`) — teclado navega por setas; correção depende do lead (§9.2). |
| 2 | Toque/interação (mouse) | **ok** | Alvos no espaço de design: `#hud-fs` 44×44, `.btn` 64, `.nav-item` 64, `.pin-key` 96×72, `.field` 60, linha de lista ≥72; login real: olho 44×44, Entrar 48, links/resumo 44. `#hud-downloads` tem **área de clique de 44 px** por `::after` (medido com `elementFromPoint` a ±21 px do centro). Em 1280×720 um alvo de 44 px de design renderiza ~29 px de janela (acima do mínimo WCAG 2.2 de 24 px; o contrato de 44 px é no palco 1920×1080, igual à TV/web). |
| 3 | Performance | **ok (herdada)** | VList/HRow virtualizam; skeleton reserva espaço; nenhum `layout thrashing` adicionado (só CSS). O harness não mediu FPS — não é afirmado aqui. |
| 4 | Estilo | **ok** | Tokens/fontes/logo/cards/modais vindos de `tv/`; desktop só adiciona estados e utilitários. Ícones são SVG (o harness usa SVG inline; nenhum emoji como ícone). `desktop.css` tem 1 cor literal (`#ffcf6b`) e `login.css` 1 (`#ffcf6b`), ambas do texto de atenção já usado pela web (`#hud-sync.warn`), justificadas em comentário. |
| 5 | Layout/responsivo | **ok** | 1366×768 (escala 0,711) e 1280×720 (0,667): `#stage` sem rolagem (overlay hidden), página sem barra horizontal/vertical, fundo `#050711` medido, HUD cabe com todos os badges (1366 e 1280). Login: card 500×479/465 **centralizado** (centro x = centro da janela), rodapé 500 px, sem barra horizontal em 1366×768 e 1024×640. |
| 6 | Tipografia/cor | **ok com risco documentado** | Pior par de texto em uso **5,51:1**; nenhum texto novo < 12 px de design. Risco honesto: o palco 1080p escalado em 1280×720 deixa o corpo de 16 px com **10,7 px de janela** e o micro texto (12–13 px) com 8–8,7 px; o desktop.css compensa o micro texto (**15/14 px de design → 10/9,3 px**) e `#stage-warn` passa a aparecer em janelas < 1280×720. A solução estrutural (janela padrão maior ou reflow) é decisão do lead (§9.5). |
| 7 | Animação | **ok** | `prefers-reduced-motion: reduce` medido no harness: `.desktop-skeleton` `animation: none`, `.card.focused` `transform: none`, `#planet` `animation: none`, `.btn` `transition-duration: 0s`. O CSS estende a preferência a `nav/cat/list/chip/pl-chan/pin` e ao scroll suave de Configurações. |
| 8 | Formulários/feedback | **ok com dívida herdada** | Labels visíveis (login e `App.ui.form`), erro junto do campo no padrão novo `.desktop-error` + `.field.invalid`/`aria-invalid`; placeholder do login subiu de **3,39:1 → 7,16:1**; aviso de API fora (`#login-conn-warning`) com **11,49:1**. Dívida herdada: `App.ui.form` (TV) mostra um erro único no rodapé, não por campo; downloads/conta da web também usam `App.ui.menu`/`alert` (texto único) — registrado, não bloqueante. |
| 9 | Navegação | **ok com 1 pendência** | Setas/Enter/Esc/Backspace/Home/PageUp-Down mapeados em `web/js/keys.js`; clique/roda na `web/js/pointers.js` (foco virtual + ativação). Não existe interação só-hover: hover move o foco virtual, clique e teclado sempre funcionam. Pendência: `Tab` não alcança itens do menu/cards (só controles nativos), porque o shell cria `nav-item` com `tabindex="-1"` (§9.2). |
| 10 | Dados/gráficos | **parcial** | EPG tem agora/próximo com **legenda textual** (`Agora:`/`A seguir:`), status `.warn` com texto e não só cor — ok. Downloads ainda sem CSS entregue; reauditar (§9.6). |

## 3. Contraste medido (composição alpha)

Metodologia: cada cor com alfa é composta sobre a superfície real (ex.: `--glassDark`
rgba(11,22,56,.55) sobre `#050711` = `#080f26`; login = glass sobre o glow azul do
fundo = `#0e1c3e`; campo = rgba(5,7,17,.55) sobre o card = `#091025`). Fórmula WCAG
2.1 (luminância relativa sRGB). Script: `desktop/test/tmp/ui-contrast.js`.

**Resultado: 0 falhas nos pares em uso** (texto ≥ 4,5:1; foco/estado ≥ 3:1).
Pior texto em uso: **5,51:1**; pior foco: **3,62:1**; pior estado não-textual: **5,29:1**.

| Par (texto sobre superfície) | Antes | Depois |
|---|---|---|
| `--softWhite` sobre `--spaceBlack` | — | **18,79:1** |
| `--softWhite` sobre `--spaceNavy` | — | **16,55:1** |
| `--softWhite` sobre glass (HUD/sidebar/modal) | — | **17,70:1** |
| `--softWhite` sobre glass sobre planeta | — | **14,45:1** |
| `--softWhite` sobre planeta (texto solto) | — | **11,80:1** |
| `--muted` (62%) sobre `--spaceBlack` | — | **7,32:1** |
| `--muted` sobre `--spaceNavy` | — | **6,92:1** |
| `--muted` sobre glass | — | **7,17:1** |
| `--muted` sobre glass sobre planeta | — | **6,35:1** |
| `--muted` sobre planeta (pior em uso) | — | **5,51:1** |
| Login: `--softWhite` no card | — | **15,68:1** |
| Login: `--muted` (subtítulo/labels/rodapé) | — | **6,71:1** / **6,40:1** |
| Login: texto do input | — | **17,61:1** |
| Login: placeholder (38% → 62%) | **3,39:1** ❌ | **7,16:1** ✅ |
| Login: `.login-error` (`--danger`) | — | **5,64:1** |
| Login: `.login-status` (`--ok`) | — | **9,49:1** |
| Login: aviso `#login-conn-warning` (`#ffcf6b`) | — | **11,49:1** |
| Login: borda de foco azul sobre o card | — | **4,82:1** |
| Badge azul/vermelho/verde do HUD | — | **14,09 / 14,25 / 13,37:1** |
| `#hud-sync.warn` (`#ffcf6b`) sobre badge | — | **10,33:1** |
| `.err-line` (`--danger`) no modal | — | **6,37:1** |
| `#stage-warn` e `#toast` | — | **16,69:1** |
| `nav .active` / `nav .focused` | — | **14,96:1** / **8,70:1** |
| `.tag` sobre imagem branca (pior caso) | — | **8,93:1** |
| `.psub` (`--muted`) sobre o palco | — | **7,32:1** |
| Iniciais de pôster (`.ph` 35% → 62%) | **2,90:1** ❌ | **6,01:1** ✅ |
| Iniciais de canal (`.ph` 35% → 62%) | **3,01:1** ❌ | **7,27:1** ✅ |
| `.det-plot` (82%) sobre o shield | — | **12,51:1** |
| `.desktop-kbd` | — | **14,65:1** |
| `.temp-pass` | — | **18,34:1** |
| Foco: `--electricBlue` sobre preto / glass / planeta / modal | — | **5,77 / 5,44 / 3,62 / 5,44:1** |
| Foco: `--glassFocusBorder` sobre glass | — | **4,62:1** |
| PIN desligado: borda 25% → 50% | **2,19:1** ❌ | **5,29:1** ✅ |

## 4. Alvos medidos (espaço de design 1920×1080 e tamanho na janela)

| Elemento | Design | 1366×768 (×0,711) | 1280×720 (×0,667) |
|---|---|---|---|
| `#hud-fs` (tela cheia) | 44×44 | 31,3×31,3 px | 29,3×29,3 px |
| `#hud-downloads` (área de clique) | 44 de altura | 31,3 px | 29,3 px |
| `.btn` (e botões do player via `.btn`) | altura 64 | 45,5 px | 42,7 px |
| `.nav-item` (menu) | altura 64 | 45,5 px | 42,7 px |
| `.pin-key` | 96×72 | 68,3×51,2 px | 64×48 px |
| `.field` (busca/forms) | altura 60 | 42,7 px | 40 px |
| Upload: botão nativo de arquivo | antes ~34 → **44** | — | — |
| Login: olho / Entrar / link / resumo | **44×44 / 48 / 44 / 44** (sem escala) | 44×44 / 48 / 44 / 44 px | idem em 1024×640 |

Nota técnica: 44 px é o contrato no **palco de design** (mesma regra da TV/web). Como o
palco é escalado, o alvo físico encolhe junto com o texto; o mínimo WCAG 2.2 (24×24
CSS px) é respeitado em 1280×720. Um alvo de 44 **px de janela** exigiria escala 1
(janela ≥1920×1080) ou alvos maiores no design — decisão registrada em §9.5.

## 5. Foco visível e interação

| Verificação | Resultado medido |
|---|---|
| `:focus-visible` global | `outline: 2px solid rgb(66,133,255)`, `outline-offset: 2px` (contrato) |
| `#hud-fs` via **Tab real** (CDP `Input.dispatchKeyEvent`) | `activeElement=hud-fs`, `outlineStyle=solid`, `width=2px`, `color=rgb(66,133,255)`, `offset=2px` ✅ |
| Campo do login com foco | borda `rgba(66,133,255,0.9)` + `box-shadow 0 0 0 3px rgba(66,133,255,0.28)` ✅ |
| `.field:focus-within` (busca) | borda `--glassFocusBorder` + `--glow-blue` (herdado de `web.css`, mantido) |
| Cards/linhas/menu/categorias/PIN | estado `.focused` do design system (borda + gradiente + glow) — usado tanto pelo teclado quanto pelo hover/clique da ponte |
| Remoção de foco | **nenhuma** regra removendo foco sem substituto; `outline:none` só no input dentro do `.field` (que desenha borda+glow) e no login (`:focus-visible` do input, com anel do CSS da web) |
| Cursor (desktop não esconde) | medido após `hide-cursor`: `body=auto`, `#hud-fs=pointer`, `.nav-item=pointer`, `.card=pointer`, `input=text` (a classe da TV não esconde mais o cursor) |
| Área de clique do badge de downloads | `elementFromPoint` a ±21 px do centro retorna `#hud-downloads` em cima e embaixo; `overflow: visible` ✅ |

Entrada por teclado (`web/js/keys.js`): setas navegam, Enter ativa, Esc/Backspace
voltam, Home vai ao Início, PageUp/PageDown trocam de canal, `0–9` favoritos, `G`
abre o Guia (bootstrap), `Tab` fica com campos/controles nativos. Entrada por mouse
(`web/js/pointers.js`): hover move o foco virtual, clique ativa, roda navega listas,
segurar 650 ms favorita. **Nada depende de hover.**

## 6. Login (mesma cara do web)

- `css/login.css` = `@import "../web/css/login.css"` + camada desktop; o card, campos,
  estados e tipografia continuam os da web (nada duplicado de tokens/fontes).
- Medido em 1366×768: card **500×479**, centralizado (x=433 em 1366), rodapé **500 px**,
  sem rolagem horizontal/vertical. Em 1024×640: card 500×465, sem rolagem.
- Alvos reais (a página não é escalada): olho **44×44**, Entrar **48**, links e
  "Política de privacidade" **44** (antes ~30/32), foco azul, placeholder 7,16:1.
- Aviso de servidor fora (`#login-conn-warning`, criado por `js/login-desktop.js`) é
  estilizado em amarelo de atenção (11,49:1) e não altera o formulário.
- Rodapé com versão em pt-BR (`js/login-desktop.js`), largura igual à do card,
  quebra de linha permitida.

## 7. Escala do palco, legibilidade e decisão de compensação

`web/js/shell.js` aplica `scale = min(vw/1920, vh/1080)` no `#stage`. Tamanho efetivo
de um texto de design em cada janela (medido pelo script de contraste):

| janela | escala | 11 px | 12 px | 13 px | 14 px | 16 px | 18 px |
|---|---|---|---|---|---|---|---|
| 1920×1080 | 1,000 | 11,0 | 12,0 | 13,0 | 14,0 | 16,0 | 18,0 |
| 1600×900 | 0,833 | 9,2 | 10,0 | 10,8 | 11,7 | 13,3 | 15,0 |
| **1366×768 (DoD)** | 0,711 | 7,8 | 8,5 | 9,2 | 10,0 | 11,4 | 12,8 |
| **1280×720 (padrão)** | 0,667 | 7,3 | 8,0 | 8,7 | 9,3 | 10,7 | 12,0 |
| 1024×640 (mínimo) | 0,533 | 5,9 | 6,4 | 6,9 | 7,5 | 8,5 | 9,6 |

**Decisão (registrada):** não mexer no palco/escala (é contrato do shell) e **compensar
só o texto micro** no `desktop.css`, em janelas < 1500 px e < 1366 px:

- 1366×768: `hud-caption/hints` 12→**15**, `badge` 12→**14**, `tag` 11→13,
  `psub/sb/s` 13→**16**, `ep .du` 14→16, `pl-keys` 14→16
  → efetivo 10,0–11,4 px (antes 7,8–9,2 px);
- 1280×720: mesmos valores → efetivo 9,3–10,7 px.
- **Não** foram alterados `.poster .ptitle`, `.chan .nm`, `.list-row .t` e afins:
  essas alturas são fixas e o `VList` usa `rowH` em px (`tv/js/components/vlist.js:8`);
  aumentar fonte ali quebraria a grade virtualizada. Medido no harness: `.skeleton`
  e cards mantêm a caixa; sem CLS.
- `#stage-warn` passa a aparecer em **qualquer janela < 1280×720** (o shell só mostrava
  abaixo de 1024×576, mas a escala já cai a 0,533 em 1024×640). Medido: visível em
  1200×700, oculto em 1280×720 e 1366×768.

**Risco residual:** em 1280×720 o texto de corpo (16 px de design) fica com ~10,7 px de
janela — legível, mas abaixo do ideal de 12 px. Alternativas estruturais para o lead:
(a) janela padrão 1600×900 (escala 0,833 → corpo 13,3 px) em vez de 1280×720 do
`config`; (b) reflow real no lugar do palco fixo (mudaria `web/js/shell.js`, fora do
meu escopo). Registrado em §9.5.

## 8. Problemas encontrados e o que foi corrigido no desktop

| # | Onde (arquivo:linha de origem) | Problema medido | Correção (arquivo) |
|---|---|---|---|
| 1 | `web/css/login.css:100` | placeholder 38% = **3,39:1** | `login.css`: placeholder 62% = 7,16:1 |
| 2 | `tv/css/app.css:51` | iniciais do pôster 35% = **2,90:1** | `desktop.css`: 62% = 6,01:1 |
| 3 | `tv/css/app.css:62` | iniciais do canal 35% = **3,01:1** | `desktop.css`: 62% = 7,27:1 |
| 4 | `tv/css/app.css:192` | ponto do PIN desligado 25% = **2,19:1** (WCAG 1.4.11) | `desktop.css`: 50% = 5,29:1 |
| 5 | `web/css/web.css:129` | `html.hide-cursor … cursor:none !important` esconde o cursor (comportamento de TV) | `desktop.css` §1: cursor sempre visível + `pointer` nos alvos + `text` em campos (medido) |
| 6 | `web/css/web.css:55-61` | `#hud-fs:focus-visible` com offset 3 px | `desktop.css`: offset 2 px (contrato) — medido |
| 7 | `web/css/web.css:85-94` | botão nativo de arquivo ~34 px | `desktop.css`: `min-height: 44px` |
| 8 | `web/css/login.css:183-201` | `.login-link` ~30 px | `login.css`: 44 px |
| 9 | `web/css/login.css:238-249` | resumo de privacidade 32 px | `login.css`: 44 px |
| 10 | HUD com badges novos: `#hud-downloads`/`#hud-offline`/`#hud-user`/`#hud-list` | risco de estourar os 1824 px | `desktop.css` §2: `.hud-info` com `min-width:0`, truncamento e larguras máximas; **medido: cabe em 1366 e 1280** |
| 11 | `tv/css/app.css:11` (`#hud` gap 20) + `web/css/web.css:169` | `#hud-user` 260 px + badges podiam empurrar o relógio | `desktop.css`: `#hud-user` 200 px (continua com `title`/`aria-label` completos) |
| 12 | Configurações: base 8 + upload + conta + 2 toggles + 7 ações desktop (~19 itens) | coluna de 856 px não comporta (estimativa pelas alturas do CSS: ~1328 px) | `desktop.css`: `.settings .actions-pane` rolável + `.btn` aceita 2 linhas para e-mail longo; **foco auto-rolar é pendência do dono do painel** (§9.3) |
| 13 | `js/upload-desktop.js` marca `.drop-target` durante arraste | classe sem estilo | `desktop.css`: borda/glow de foco no modal |
| 14 | `js/login-desktop.js` cria `#login-conn-warning` | aviso com cor de texto secundário | `login.css`: amarelo de atenção (11,49:1) |
| 15 | palco 1080p escalado | micro texto a ~8 px em 1280×720 | `desktop.css` §6: compensação + `#stage-warn` < 1280×720 (§7) |

## 8.1 Auditoria do `css/epg.css` (agente epg; arquivo lido, não editado)

`epg.css` (182 linhas) foi entregue durante a auditoria e conferido contra os mesmos
critérios. Medi **23 pares de contraste** nas superfícies reais do guia (painel
rgba(5,7,17,.92) sobre o overlay; bloco normal/focado; banner; logo; pill de aviso).

| Achado | Evidência | Ação |
|---|---|---|
| `.epg-live-status.warn` (`--danger` solto sobre o palco) | **4,25:1** no pior caso (sobre o planeta decorativo) — abaixo de 4,5:1 | corrigido na minha camada (`desktop.css` §6.1: pill `rgba(5,7,17,.72)` atrás do texto → **6,22:1**) e **repassado ao lead** para o dono do arquivo |
| Texto micro do guia | `.epg-line` 12 px, `.guide-now-flag` 11 px, `.guide-prog-time` 11 px, `.guide-chanhead`/`.guide-row-empty` 13 px, `.guide-sub` 14 px → em 1366×768 renderizam 7,8–9,2 px | rede de segurança em `desktop.css` §6.1 (14/13/13/14/14/15 px de design, seletor `#stage …` porque `epg.css` carrega **depois** do desktop.css); recomendei ao epg subir no próprio arquivo |
| Alvos | `.epg-live-bar button` 44×44 ✅, `.guide-panel button.btn` 48 ✅, `.guide-banner button` 44 ✅, bloco de programa ~64 ✅, linha de canal 72 ✅ | ok |
| Foco | `:focus-visible` 2 px `--electricBlue` em botões e `.guide-scroll` (offset −2 dentro do scroller) ✅; `.guide-prog.focused` com gradiente+glow ✅ | ok |
| Reduced motion | `@media (prefers-reduced-motion: reduce)` desliga transições/animações de `.guide-overlay`, `.guide-detail`, `.epg-live-bar`, `.epg-line` ✅ | ok |
| Contraste do restante | pior par **5,15:1** (`.guide-empty-badge` azul sobre fundo azulado); `.epg-lbl` 12,83:1; `.guide-prog-time` 8,89:1 normal e 6,58:1 focado; `.guide-now-flag` 6,76:1; descrição do detalhe 14,43:1; banner 15,98:1 | ok |
| Observações | `.guide-overlay` define variáveis **locais** de layout (`--guide-chan/head/row/line`) — não são tokens de marca (escopo de classe, aceitável); `.guide-empty.kind-loading` não foi verificado em execução real (depende do `guide-screen.js`) | reauditar no app (§9.1/§9.6) |

Nada foi editado em `epg.css`: as correções de legibilidade/contraste ficam na minha
camada (que carrega antes) com seletor de maior especificidade, e o dono do módulo pode
incorporá-las ao arquivo dele quando quiser.

## 9. Pendências repassadas (com dono)

> Todas foram enviadas ao `lead` no painel/report. Nenhum arquivo de outro agente foi
> editado; quando a correção é em arquivo alheio, está marcada com o dono.

**9.1 [P1] Capturas/console no Electron real (lead/qa-release).** O CSS foi validado em
Chromium headless com o DOM/escala do shell, mas o app Electron (servidor interno +
`index.html` servido de `dist/`) ainda não rodou nesta auditoria. Pedido: rodar
`npm run build:renderer` + app, confirmar console limpo e capturar 1366×768 e 1280×720
(HUD, Configurações, Baixados, Guia, login). Sem isso o DoD de "palco no app real" fica
em aberto — não vou marcar como "ok" sem a captura.

**9.2 [P2] Menu/cards não recebem `Tab` (lead, `web/js/shell.js:75-79`).** Os
`.nav-item` são criados com `tabindex="-1"` e `role="link"`; funciona por setas (padrão
TV/web), mas `Tab` não alcança o menu. Opções: (a) `tabindex="0"` + ativação por
Enter/Espaço no shell; (b) aceitar como padrão de produto e documentar. Nenhuma ação do
desktop.css resolve isso.

**9.3 [P1] Configurações: rolar o botão focado (auth-desktop/settings-desktop.js).** O
painel agora rola (`desktop.css`), mas o foco por setas (`App.ui.group`) não faz
`scrollIntoView`; botões fora da área visível ficam focados sem aparecer. Correção no
módulo: ao pintar o foco, `focused.scrollIntoView({ block: 'nearest' })`; alternativa:
o lead agrupar as ações desktop em submenus (menos itens na coluna).

**9.4 [P2] Nome acessível do campo de busca (lead — arquivo da TV).**
`tv/js/screens/results.js:52` cria o input só com `placeholder` (sem `<label>` nem
`aria-label`). O placeholder tem 7,17:1, mas não é nome acessível. Como `tv/**` é
congelado, a alternativa é um patch de runtime no bootstrap (auth-desktop) ao montar a
tela de Pesquisa/Favoritos (`input.setAttribute('aria-label','Buscar')`), ou aceitar a
dívida herdada da web.

**9.5 [P3] Janela padrão 1280×720 (lead/`config.js`).** Escala 0,667 deixa o corpo em
~10,7 px de janela. Recomendo `1600×900` como padrão (0,833 → 13,3 px) mantendo
redimensionamento livre; o `config` atual nasce em 1280×720. Não alterei nada no main.

**9.6 [P2] Auditoria de `downloads.css` (ui-ux, aguardando entrega) e ajustes do EPG
(epg).** `downloads.css` ainda não existia no fim desta auditoria (o `index.html` já
aponta para ele: até ser entregue, o Chromium registra 404 no `<link>` — o E2E de console
limpo só passa depois da entrega). Quando chegar, vou medir contraste/alvos/foco/
reduced-motion e mandar correções ao lead sem editar o arquivo. Do EPG, os dois ajustes
recomendados ao dono são: (a) fundo/pill no `.epg-live-status.warn`; (b) subir os
tamanhos micro (`epg-line`, `guide-prog-time`, `guide-now-flag`, `guide-chanhead`,
`guide-row-empty`, `guide-sub`) — hoje cobertos pela minha rede de segurança.

**9.7 [P3] Detalhes que o dono pode ajustar (sem bloquear):**
- painel bloqueante de conexão usa `<div class="btn">` (`js/bootstrap.js:181-197`):
  Enter funciona (listener global), mas **Espaço** não; trocar por `<button class="btn">`
  nativo resolve Tab/Enter/Espaço de graça;
- `#hud-downloads` não é clicável (`js/bootstrap.js:302-331`); se quiserem atalho para
  Baixados, basta `classList.add('action')` + `click` — o CSS já garante 44 px e cursor;
- `#hud-version` é referenciado (`js/bootstrap.js:439`) mas não existe no HTML (código
  morto, inofensivo);
- fallback "Baixados" usa classe `.empty` sem estilo (`js/desktop-config.js:42`): só
  aparece se o módulo de downloads faltar;
- CSP: `frame-ancestors` em `<meta>` é ignorado pelo Chromium (mensagem informativa no
  console) — só afeta o "console limpo" do E2E, não a segurança real.

## 10. Evidências (anexos)

Tudo em `desktop/test/tmp/` (gitignored — temporário, não faz parte do pacote):

- `shots/ui-visual.txt` — saída completa do harness (**43/43 PASS**)
- `shots/contraste.txt` — tabela de contraste com as superfícies compostas
- `shots/css-check.txt` — checagem estática dos CSS
- `shots/medicoes-1366x768.json`, `shots/medicoes-1280x720.json` — fontes efetivas,
  alvos, HUD, overflow, estados
- `shots/medicoes-login-1366x768.json`, `shots/medicoes-login-1024x640.json`
- `shots/1366x768-palco.png`, `1366x768-modal-confirm.png`, `1366x768-modal-pin.png`,
  `1280x720-palco.png`, `1200x700-aviso.png`, `login-1366x768.png`, `login-1024x640.png`
- scripts: `ui-contrast.js`, `ui-visual.js`, `ui-css-check.js`

## 11. Conclusão

A camada desktop está entregue e **medida**: 4 folhas carregadas sem erro de parse
(`desktop.css` = 92+ regras no Chromium, `epg.css` auditado com 23 pares), 0 falhas de
contraste nos pares em uso (incluindo a correção do aviso do EPG), foco visível de 2 px
azul (verificado com Tab real e com foco em campo), alvos de 44 px no palco (login de
44 px reais), HUD cabendo com os badges novos, sem rolagem horizontal/vertical nos dois
tamanhos do DoD, reduced-motion desligando as animações, estados
vazio/skeleton/erro/indisponível/dica estilizados e login idêntico ao web.
O que **não** está ok/fechado é o que depende de execução no Electron real (§9.1), o
auto-scroll do foco em Configurações (§9.3), a auditoria de `downloads.css` (§9.6) e a
dívida herdada de `Tab` no menu / nome acessível da busca (§9.2/§9.4). Nenhum item
crítico de acessibilidade ficou em aberto nos arquivos sob minha responsabilidade.
