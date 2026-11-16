# UI/UX do Space IPTV Desktop — convenções para os outros agentes

> Dono: agente **ui-ux**. Este arquivo é o contrato visual/UX da camada desktop
> (complementa `desktop/CONTRACTS.md` §0). Se precisar de algo diferente, fale com o
> **lead** — não edite `desktop/src/renderer/css/desktop.css` nem `css/login.css`.
>
> Fonte da verdade dos tokens: `tv/css/design-system.css`. O desktop **não** tem
> paleta, fonte, raio ou sombra próprios: ele herda `tv/css` + `web/css` e só
> acrescenta o que é específico de janela Windows.

## 1. Camada de CSS e ordem de carregamento

`index.html` (fixo, do lead) — ordem conferida por `ui-css-check.js`:

```
tv/css/design-system.css  →  tv/css/app.css  →  web/css/web.css
→  css/desktop.css  →  css/downloads.css  →  css/epg.css
```

`login.html` (fixo, do lead):

```
tv/css/design-system.css  →  css/login.css   (que faz @import de ../web/css/login.css)
```

Regras:

- **Nunca** carregue CSS novo sem falar com o lead; a ordem é contrato.
- **Módulos (`downloads.css`, `epg.css`) carregam DEPOIS do `desktop.css`.** Eles podem
  estilizar as próprias classes, mas **não devem redefinir componentes compartilhados**
  (`.btn`, `.card`, `.badge`, `.field`, `.nav-item`, `:focus-visible`, `html/body`):
  como vêm depois, venceriam a camada desktop e quebrariam foco/alvos/cursor de todo o
  app. Se precisar de ajuste em componente compartilhado, peça ao ui-ux/lead.
- O `desktop.css` usa seletores com `#stage`/`#hud` quando precisa vencer um módulo que
  carrega depois (caso da legibilidade do EPG, §6.1 do desktop.css).
- Não redefina variáveis (`--softWhite`, etc.), `@font-face` nem cores de marca.

## 2. Utilitários disponíveis (`css/desktop.css` §8)

Use estas classes em vez de valores soltos — elas garantem o ritmo de 4/8 px e os
alvos mínimos do contrato:

| Classe | Efeito |
|---|---|
| `.visually-hidden` | texto só para leitor de tela (labels que não devem aparecer) |
| `.desktop-target` | `inline-flex` com `min-width/min-height: 44px` (botão-ícone, botão pequeno) |
| `.u-row` / `.u-col` / `.u-wrap` | flex com `gap: 8px` (linha, coluna, quebra) |
| `.u-grow` | `flex: 1 1 auto; min-width: 0` (para truncar dentro de flex) |
| `.u-truncate` | uma linha com reticências (precisa de `min-width: 0` no pai flex) |
| `.u-gap-4/8/12/16` | `gap` no ritmo 4/8 |
| `.u-mt-4/8/12/16/24`, `.u-mb-4/8/16` | margens no ritmo 4/8 |
| `.desktop-scroll` | `overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain` |

Componentes existentes que devem ser reutilizados: `glass-panel`, `card`/`poster`/
`chan`, `badge` (+ `.warn`/`.ok`), `field`, `btn` (+ `.primary`/`.danger`/`.toggle`/
`.menu-item`), `overlay` + `modal`, `VList`, `HRow`, `App.ui.*` (modal, form, menu,
confirm, alert, pin). **Não** crie botão/card/lista novos.

## 3. Estados obrigatórios (classes `desktop-*`)

Qualquer tela nova (Baixados, Guia, Settings) precisa dos quatro estados quando
aplicável. Sem isso a tela fica "muda" em rede lenta/offline/erro.

### 3.1 Vazio — `.desktop-empty`

```html
<div class="desktop-empty">
  <div class="de-ico"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">…</svg></div>
  <h2 class="de-title">Nenhum download ainda</h2>
  <p class="de-text">Baixe um filme ou episódio para assistir sem internet.</p>
  <div class="de-actions"><button class="btn primary" type="button">Ver catálogo</button></div>
</div>
```

- Ícone = **SVG inline**, nunca emoji (contrato §0).
- `.compact` deixa mais baixo (para caber dentro de painel/coluna).
- A ação é um `<button class="btn">` nativo sempre que possível (Enter/Espaço/Tab
  funcionam de graça); se usar o `App.ui.btn` (div), o clique funciona pela ponte,
  mas o nativo é melhor para acessibilidade.

### 3.2 Carregando — `.desktop-skeleton`

- Reserve **a mesma área** do conteúdo final (sem layout shift): use `.poster`
  (proporção 2:3), `.row` (72 px), `.line` (+ `.w30/.w60/.w80`), `.block` (220 px)
  ou defina `height`/`aspect-ratio` inline.
- A animação `skel` já é desligada em `prefers-reduced-motion`.
- Nunca use spinner em lista/grade; spinner (`App.ui.loading`) é para bloqueio curto.

### 3.3 Erro — `.desktop-error` (junto do campo)

```html
<div class="field invalid" aria-invalid="true">
  <label for="pasta">Pasta de downloads</label>
  <input id="pasta" type="text" aria-invalid="true" aria-describedby="pasta-erro">
</div>
<p id="pasta-erro" class="desktop-error" role="alert">Não foi possível escrever nesta pasta.</p>
```

- Mensagem **abaixo do campo**, com `role="alert"` (ou `aria-live="assertive"`).
- Use `aria-invalid="true"` no input e `.invalid`/`aria-invalid` no `.field` para
  a borda vermelha; `aria-describedby` apontando para o erro.
- `.desktop-error` tem `min-height: 22px` (não "pula" o layout ao aparecer).
- Nos formulários do `App.ui.form` o erro é único no rodapé (limitação do
  componente da TV). Para formulários novos (desktop), prefira erro por campo.

### 3.4 Indisponível — `.desktop-unavailable` (sem rede / API fora)

```html
<div class="desktop-unavailable" role="status">
  <h2 class="du-title">Sem conexão com o servidor</h2>
  <p class="du-text">Você continua podendo assistir aos downloads.</p>
  <div class="du-actions"><button class="btn" type="button">Tentar de novo</button></div>
</div>
```

- Use quando a tela depende da API e `App.desktop.offline` está ligado.
- Nunca invente login offline (contrato §3.2 do `CONTRACTS.md`).
- Sempre ofereça **Tentar de novo** (≥44 px) — não deixe o usuário sem saída.

### 3.5 Dica de teclado — `.desktop-kbd`

```html
<span class="desktop-kbd">Enter</span> ou <kbd>Esc</kbd>
```

- `kbd` e`.desktop-kbd` já são estilizados (fundo, borda, fonte) e o texto é
  `--softWhite` (contraste 14,65:1). Não use emoji no lugar da tecla.
- Use nas dicas (`#hints`), no player e no Guia; sempre com o texto do que a tecla
  faz ao lado (`Enter selecionar`).

## 4. Alvos, foco e teclado

- **Alvo mínimo 44 px** no espaço de design 1920×1080 (é o mesmo contrato da TV/web;
  o palco escala, então em 1280×720 um alvo de 44 px de design tem ~29 px de janela
  — acima do mínimo WCAG 2.2 de 24 px). Botão-ícone/linha clicável: `.desktop-target`
  ou garanta `min-height: 44px`/`min-width: 44px`.
- Foco visível:
  - itens navegados por índice (`VList`, `HRow`, menu, ações): a classe **`.focused`**
    (já desenhada pelo design system) é o foco visível;
  - foco real de teclado (`Tab` em `<button>`, `<a>`, `<input>`): `:focus-visible`
    global = `2px solid var(--electricBlue)` offset 2; **não use `outline:none`**
    sem um substituto visível (o `.field` usa borda+glow e é exceção documentada).
- Botões nativos (`<button class="btn">`) já ganham Tab/Enter/Espaço. Divs com
  `role="button"` + `tabindex="0"` **não** ativam sozinhas: precisam de handler de
  `keydown` para Enter/Espaço (ou use `App.ui.btn` + navegação por setas).
- Toda interação precisa funcionar **por teclado e por mouse**; hover é só reforço.
  Não crie nada que só abra no hover.

## 5. Cursor, scroll e janela

- O desktop **não esconde o cursor** (a ponte da web esconde aos 2,5 s; o
  `desktop.css` desfaz). Para elemento clicável novo, use `role="button"`/`<button>`
  ou avise o ui-ux para incluir a classe na lista de `cursor:pointer`.
- Rolagem: use `.desktop-scroll` (ou role nativo) em painéis internos; a **página**
  não rola (o palco é escalado). Nunca crie barra horizontal.
- Em janelas < 1280×720 o app mostra `#stage-warn` e a tipografia micro é
  compensada pelo desktop.css — não duplique essa compensação no seu CSS.

## 6. Tipografia e escala do palco (importante para listas)

O palco é 1920×1080 fixo e o `web/js/shell.js` aplica `scale = min(vw/1920, vh/1080)`.
Em 1280×720 a escala é **0,667**; um texto de 12 px de design renderiza ~8 px na
janela. O `desktop.css` compensa **só os textos micro** (`hud-caption`, `badge`,
`tag`, `psub`, `sub` de canal/lista) em janelas < 1500 px / < 1366 px.

- **Não** altere `font-size` de `.poster .ptitle`, `.chan .nm`, `.list-row .t` etc.:
  essas alturas são fixas (`VList` usa `rowH` em px e o card tem `height` fixo) e a
  mudança quebra a grade virtualizada.
- Texto ≤ 11 px: evite em telas novas. Mínimo absoluto do produto: 12 px de design.
- Datas/horas sempre pt-BR (`toLocaleDateString('pt-BR')` / `toLocaleTimeString('pt-BR')`),
  tamanho/duração com vírgula decimal e separador de milhar pt-BR.
- Números de progresso, %, Mbps, GB: tabular quando alinhados (`font-variant-numeric`).

## 7. Movimento

- `prefers-reduced-motion: reduce` já desliga as animações existentes. Se o seu
  módulo adicionar animação (pulso, shimmer, slide), adicione a sua regra de
  `prefers-reduced-motion` no CSS do módulo — ou peça ao ui-ux.
- Animação só com significado (progresso, foco, toast). Nada piscando sem parar.

## 8. Convenções por módulo

### Baixados (`downloads`)

- Badge do HUD (`#hud-downloads`): texto **curto** (ex.: `Baixando 2 · 45%`), já
  truncado pelo desktop.css. Se ele for clicável (atalho para Baixados), use
  `el.classList.add('action')` (ou `role="button"`): o CSS já expande a área de
  clique para 44 px e aplica `cursor:pointer`.
- Linha da lista: pôster/thumb 64×96 ou 88×64, título 1 linha + sub 1 linha,
  status como `.badge`, progresso com `.pbar`, ações com `.btn` (ou ícone
  `.desktop-target`). Altura da linha ≥ 72 px (dedo/mouse) e sempre com alvo 44 px.
- Estados: vazio (`.desktop-empty`), carregando (`.desktop-skeleton.row`),
  offline (`.desktop-unavailable` se a lista local não puder ser lida), erro por
  item mostra o motivo curto + ação "Tentar de novo".
- Excluir = confirmação forte (`App.ui.confirm`, botão "Excluir" danger).

### Guia/EPG (`epg`)

- Guia = `overlay` full-screen (camada de navegação própria), timeline com
  navegação por setas **e** mouse; `Esc` fecha.
- Classes existentes do módulo: `epg-live-bar`, `epg-live-status`, `epg-live-refresh`,
  `epg-live-open` (este é `.btn primary` na tela TV), `epg-live-screen`, `epg-empty`,
  `epg-now`/`epg-next`. O CSS `css/epg.css` é do agente epg — o ui-ux audita depois.
- `epg-live-refresh` e qualquer botão-ícone: `.desktop-target`/44 px.
- "Agora"/"A seguir" em pt-BR, horário local pt-BR; linha reservada (sem CLS).
- Vazio: `.desktop-empty` com texto claro (ex.: "Esta lista não fornece guia de
  programação") + ação "Tentar de novo". Offline: `.desktop-unavailable`.
- `aria-live="polite"` no status do guia (já usado no módulo) e label no overlay.

### Login (`auth-desktop` — `js/login-desktop.js`)

- Nunca reimplemente a tela: o CSS é o da web (`css/login.css` faz o import e só
  ajusta foco/alvos/contraste). O JS só troca a versão do rodapé e mostra o aviso
  de conexão.
- Aviso de API indisponível: use a classe `login-note login-conn` (já estilizada em
  `#login-conn-warning`, amarelo de atenção). Nunca mostre credencial de teste.
- Versão no rodapé em pt-BR; botões "Entrar" (48 px), olho 44×44, links 44 px.
- Estados de erro continuam `#login-error` (`role="alert"`), junto do formulário.

### Shell/HUD (`auth-desktop`)

- `#hud-user`: truncado por CSS (200 px) e `title`/`aria-label` com o e-mail
  completo + "usuário" (nunca "administrador").
- `#hud-offline`, `#hud-downloads`, `#hud-sync`, `#hud-status` com `aria-live`
  (já no HTML); não coloque mais badges se não houver espaço — o HUD cabe os que
  existem hoje.
- Painel bloqueante sem conexão: use `overlay` + `modal glass-panel`; os botões
  devem ser `<button class="btn">` nativos (div não ativa com Enter/Espaço fora
  da pilha de navegação).
- Configurações: o painel de ações é rolável (`desktop.css`); **precisa** rolar o
  botão focado para a área visível (hook de `scrollIntoView` no módulo) — pendência
  registrada no `UI-UX-AUDIT.md`.

## 9. Checklist antes de dizer "entregue"

1. `node desktop/test/tmp/ui-css-check.js` — CSS sem erro, tokens preservados.
2. `node desktop/test/tmp/ui-contrast.js` — contraste ≥4,5:1 nos pares novos.
3. `node desktop/test/tmp/ui-visual.js` (Edge headless) — continua 100 %.
4. Tela testada em **1366×768** e **1280×720** (e 1024×640 sem quebrar).
5. Teclado **e** mouse em todas as ações; foco visível; alvos ≥44 px de design.
6. Estados vazio/carregando/erro/offline presentes; `prefers-reduced-motion` ok.
7. pt-BR em todo texto; ícones SVG (sem emoji); sem barra horizontal.
8. Nada de cor/fonte/token novo e nada de dependência nova.

Dúvida ou divergência: **não edite os arquivos do ui-ux**; mande a demanda para o
`lead` (painel `tools/agents-live`).
