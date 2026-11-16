# Space IPTV Desktop — auditoria Playwright (visual, usabilidade e acessibilidade)

Gerado por `node scripts/audit-playwright.js` em 2026-11-16T19:25:11.776Z.

Ambiente: Windows 11 x64 · Electron 40.6.0 · Playwright (playwright-core) via `_electron` · backend de teste `http://127.0.0.1:8789`.

Resumo: **22/22 verificações PASS**.

| Área | PASS | FAIL |
|---|---|---|
| login | 1 | 0 |
| usabilidade | 6 | 0 |
| visual | 5 | 0 |
| acessibilidade | 10 | 0 |

## Verificações

| Resultado | Área | Verificação | Detalhe |
|---|---|---|---|
| PASS | login | login real e shell carregado | `` |
| PASS | usabilidade | lista importada e grade rolável | `{"live":2,"movie":60}` |
| PASS | visual | palco preenche a janela (fill) | `{"scale":0.7114583333333333,"width":1366,"height":768,"designHeight":1079.4729136163983,"fill":true}` |
| PASS | visual | layout compacto (margem ~8px de projeto) | `{"left":5.691666603088379,"top":5.691666603088379,"right":1360.3083658218384,"bottom":51.22499942779541}` |
| PASS | visual | conteúdo vai até o fim da janela | `hints bottom=762 / 768` |
| PASS | visual | sem rolagem horizontal da página | `1366 <= 1366` |
| PASS | acessibilidade | alvos de clique do HUD/menu com >= 44px | `9 medidos` |
| PASS | acessibilidade | contraste de texto >= 4.5:1 nas amostras | `[{"key":"hints","ratio":7.32,"fontSize":"15px","color":"rgba(245, 247, 255, 0.62)"},{"key":"caption","ratio":7.32,"fontSize":"15px","color":"rgba(245, 247, 255, 0.62)"},{"key":"badge","ratio":18.79,"fontSize":"14px","color":"rgb(245, 247, 2` |
| PASS | usabilidade | barra de rolagem visível na grade | `{"scrollHeight":5040,"clientHeight":963}` |
| PASS | usabilidade | polegar da barra tem tamanho utilizável (>=12x40 renderizados) | `{"left":1344.65625,"top":56.916664123535156,"width":17.074951171875,"height":130.9083251953125,"bg":"rgba(245, 247, 255, 0.62)","outline":"0px","tabIndex":0,"ariaHidden":"false"}` |
| PASS | visual | barra acima dos cards (z-index >= 40) | `45` |
| PASS | acessibilidade | barra focável por teclado quando visível | `{"tabIndex":0,"ariaHidden":"false"}` |
| PASS | acessibilidade | contraste do polegar >= 3:1 (componente de UI) | `ratio=7.32 bg=rgba(245, 247, 255, 0.62)` |
| PASS | usabilidade | barra acessível mesmo com o mouse sobre o último card | `hit=vl-scrollthumb` |
| PASS | usabilidade | clique na trilha rola a grade | `0 -> 3776` |
| PASS | usabilidade | arrastar o polegar rola a grade | `3776 -> 2936 armed={"armed":true,"cls":"vl-scroll on drag"}` |
| PASS | acessibilidade | barra expõe aria-valuenow/valuetext | `{"top":2936,"value":"2936","text":"72% da lista"}` |
| PASS | acessibilidade | barra navegável por teclado (PageDown/Home reais) | `{"focused":true,"before":2936,"afterPage":3356,"afterHome":0}` |
| PASS | acessibilidade | árvore de acessibilidade tem scrollbar nomeado | `name=Rolar a lista props=focusable=true,focused=true,settable=true,orientation=vertical,valuemin=0,valuemax=4077,valuetext=0% da lista,controls=vl-list-3` |
| PASS | acessibilidade | foco visível ao navegar por teclado (setas) | `{"cls":"card poster focused","border":"rgba(81, 142, 255, 0.91)","glow":true,"w":154.65293884277344,"h":255.1774139404297}` |
| PASS | acessibilidade | prefers-reduced-motion desliga animações decorativas | `{"duration":"0s","iteration":"1"}` |
| PASS | acessibilidade | botões do Guia com >= 44px renderizados | `[{"w":83.5518798828125,"h":45.53333282470703},{"w":103.8394775390625,"h":45.53333282470703}]` |

## Capturas

- `dist/desktop-shots/pw-00-login.png`
- `dist/desktop-shots/pw-01-inicio.png`
- `dist/desktop-shots/pw-02-grade-barra-rolagem.png`
- `dist/desktop-shots/pw-03-live.png`
- `dist/desktop-shots/pw-03-movies.png`
- `dist/desktop-shots/pw-03-series.png`
- `dist/desktop-shots/pw-03-search.png`
- `dist/desktop-shots/pw-03-favs.png`
- `dist/desktop-shots/pw-03-settings.png`
- `dist/desktop-shots/pw-04-guia.png`

## Observações

- A barra de rolagem é um controle próprio do jogo/app (não nativo); a área útil do polegar é ~14px de projeto, com trilha clicável de 24px — abaixo dos 44px do checklist de toque (exceção aceita para scrollbars, que continuam acessíveis por arrasto, clique, roda e teclado).
- O palco é escalado (~0,70 em 1366×768), por isso os tamanhos de projeto foram compensados para os controles principais renderizarem >= 44px.
- EPG/lista usam mock provider local; o login é real contra o backend de teste isolado.
