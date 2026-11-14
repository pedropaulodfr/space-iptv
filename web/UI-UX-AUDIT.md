# UI/UX Audit — Space IPTV web (F5)

**Escopo:** versão web (`web/`), telas de Início, TV ao vivo, Filmes, Séries, detalhes de
filme/série, player, Configurações, formulários e PIN; painel `tools/agents-live` também foi
revisado (tema, status textual, legenda e reduced-motion).
**Base:** skill `ui-ux-pro-max` carregada nesta execução; checklist das 10 categorias.
**Método:** Edge/Chromium headless (Playwright 1.65.1 via cache do `npx`, sem dependência no
repo), navegação só por teclado, mouse real, viewports de 1920×1080 a 960×540, `prefers-reduced-motion`,
inspeção de DOM/estilos e capturas. Firefox 159 também foi testado (boot, catálogo e HLS).
Safari **não testado** (não instalado).
**Honestidade:** o agente `qa` produziu `web/smoke.js`, as capturas e as medições de contraste;
ele travou antes de escrever este arquivo e o orquestrador consolidou a auditoria com as
evidências dele + testes de integração. Onde não houve execução, o item está marcado
**não testado** ou **dívida**, não "ok".

## Resultado por categoria (10 prioridades)

| # | Categoria | Status | Evidência | Correção/ação |
|---|---|---|---|---|
| 1 | Acessibilidade | **ok** | Contraste medido **6,76:1 a 17,7:1** nos textos principais (mínimo `--muted` = 6,76:1; `--softWhite` sobre `--spaceBlack` = 17,7:1). Foco visível em `.focused` (borda/scale) e `:focus-visible` nos controles nativos. Navegação completa por teclado nas 7 telas; `aria-label` em mudo/tela cheia/PiP; `#hud-status`, `#hints` e `#toast` com `aria-live`; modais com label e foco inicial; `lang="pt-BR"`. | Nenhuma pendência crítica. Safari/VoiceOver não testados. |
| 2 | Toque e interação | **ok** | Alvos: botão de tela cheia **44×44 px**, botões do player **44×44 px**, teclas do PIN **96×72 px**, botões de tela ≥53 px. Espaçamento 4/8; feedback `:active`/`.focused`; hover não é obrigatório (clique e teclado funcionam); ponte de toque com foco+ativação única e long-press 650 ms. | Long-press por toque real não testado em hardware; mouse validado. |
| 3 | Performance | **ok** | hls.js/mpegts.js carregados sob demanda; `VList`/`HRow` virtualizam listas; imagens lazy; sem `layout thrashing` identificado; palco recalcula em rAF; SSE/painel com fallback. | Sem ação crítica. |
| 4 | Estilo | **ok** | Tokens, fontes Orbitron/Inter, cards, modais e player vêm do design system; SVG próprio nos ícones novos (tela cheia, mudo, PiP); nenhum emoji novo como ícone. | Sem ação. |
| 5 | Layout/responsivo | **ok** | Palco 1920×1080 escalado e centralizado: 1920×1080 (1), 1366×768 (0,711), 2560×1080 (1 com barras laterais), 1280×800 (0,667), 1024×600 (0,533); sem overflow (`scrollWidth/Height` = viewport); aviso em 980×560. Zoom 200% aproximado por viewport 960×540 (mesmo layout escalado). | Zoom real do navegador não medido; não é bloqueante. |
| 6 | Tipografia/cor | **ok** | Base 16 px, `line-height` 1.5; nenhum texto <12 px (menor = 12 px em HUD/hints/chips); tokens semânticos; contraste mínimo 6,76:1; cores de status acompanhadas de texto (pills, timeline, legenda). | Sem ação crítica. |
| 7 | Animação | **ok** | Transições com significado (foco, toast, progresso); `prefers-reduced-motion` desliga pulso do planeta, `card.focused::after`, skeleton, spinner e transições; player mantém spinner sem `pointer-events` (correção aplicada). | Sem ação. |
| 8 | Formulários/feedback | **ok** | Labels visíveis em todos os campos; erro do formulário em `.err-line` junto aos botões; foco do campo com anel; PIN mostra erro "Senha incorreta" no próprio modal; toasts de salvar/atualizar; campos de busca não interceptam digitação. CRUD completo M3U/Xtream (adicionar, editar, atualizar, excluir), validação de URL inválida e toggle de saúde exercitados na integração. | Erro de campo específico não é exibido ao lado do input individual (limitação do `ui.form` compartilhado da TV) — registrado como dívida, não crítico. |
| 9 | Navegação | **ok** | Menu → telas → categorias → cards → detalhes → player → voltar; Esc/Backspace = voltar; setas preservam foco; menu/sidebar com `aria-current`; fullscreen entra por botão e sai com Esc sem fechar o player; `exit` não abre modal. Navegação e player também exercitados no Firefox 159. | Safari não testado. |
| 10 | Dados/gráficos | **ok** | Saúde dos canais com legenda em Configurações, tooltip/aria com estado + motivo e cores verde/amarelo/laranja/vermelho/cinza; o texto do estado não depende só de cor. Painel dos agentes tem legenda do grafo, status em texto nos cards/timeline e aviso "sem sinal" textual. | Dots de saúde na grade usam cor + tooltip (não há rótulo visível permanente) — dívida de baixa severidade. |

## Correções aplicadas durante a auditoria/integração

| Correção | Arquivo |
|---|---|
| `.pl-spin { pointer-events: none; }` para o spinner não interceptar o clique central do player | `web/js/player.js` (CSS escopado) |
| Gancho aditivo `b._press` nas teclas do PIN, permitindo clique/ponteiro sem quebrar a TV | `tv/js/components/ui.js` |
| `App.net.init()` no boot mesmo sem lista, com atualização do badge "proxy local" | `web/js/shell.js` |
| `/__proxy/ping` sempre 200 (`ok:false` desligado), eliminando 404 no console | `web/server.js` |
| Foco visível nativo e anel de foco no campo de busca | `web/css/web.css` |
| Texto de Configurações passa a avisar que, em HTTP fora de localhost, o armazenamento de senhas é `p0:`/Base64 (não criptografia); em localhost/https continua AES-GCM | `web/js/shell.js` |

Nenhuma correção alterou a identidade visual, tokens, fontes ou layout; todas foram
web-only ou aditivas no código compartilhado (com testes Node da TV passando).

## Evidências (capturas)

Todas em `dist/web-shots/`:

- `inicio.png` (1920×1080), `configuracoes.png`, `pin.png`
- `live-saude.png` — TV ao vivo com bolinhas verde/laranja
- `series-detalhes.png` — detalhes com temporadas e episódios
- `player.png` — player HLS com UI, barra e controles web-only
- `firefox-player.png` — o mesmo player HLS no Firefox 159
- `agents-live.png` e `agents-timeline.png` — painel final
- `agents-live-stale.png` — validação do estado "sem sinal" >30 s
- `painel-fallback.png` — painel com SSE desabilitado usando polling 1 s

## Dívidas e itens não testados (não críticos)

1. **Safari** não instalado: HLS nativo, fullscreen/PiP reais e `prefers-reduced-motion` nesse
   motor não foram executados. Firefox 159 foi testado em boot, catálogo e HLS.
2. **Zoom real de 200%** foi aproximado por viewport 960×540; o layout escala igual, mas o
   teste de zoom do navegador não foi feito.
3. **Toque físico/long-press** não testado em aparelho; a ponte foi validada com mouse e
   toque sintético do Playwright.
4. **PiP** teve o wiring/ARIA/44 px validados, mas a janela PiP real não abre no headless.
5. **Leitor de tela real** não testado; labels/aria foram inspecionados no DOM.
6. **Erro por campo** em formulários compartilhados: o `ui.form` da TV mostra erro único no
   rodapé do formulário; corrigir por campo exigiria mudar o componente compartilhado (dívida
   registrada, não crítica).
7. **Dots de saúde**: informação principal está no tooltip/legenda; um rótulo visível
   permanente exigiria redesenhar o card da TV (dívida de baixa severidade).

## Conclusão

**Nenhum item crítico em aberto** (acessibilidade, foco, contraste, alvos, reduced-motion,
navegação e layout). As pendências são de cobertura de navegador/hardware e duas dívidas
visuais de baixa severidade, todas documentadas. A auditoria usou a skill
`ui-ux-pro-max` (checklist das 10 categorias) e não autorizou redesign.
