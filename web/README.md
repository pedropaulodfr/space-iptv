# Space IPTV — versão web

Versão de navegador do Space IPTV: reproduz listas **M3U por URL** e **Xtream Codes** do
próprio usuário, com a mesma identidade visual e a mesma camada de negócio do app da TV
(`tv/js`). O app **não traz lista, canal nem credencial**: só reproduz o que o usuário cadastra.

O alvo é **desktop recente** (Chrome/Edge), com **teclado como entrada principal** e mouse
funcional. O app da TV (Tizen) e o APK Android continuam sendo projetos separados.

- Servidor local: `node web/server.js` → <http://127.0.0.1:8095/>
- Build estático: `node web/build.js` → `dist/web/`
- Documentação geral do projeto: [`../README.md`](../README.md) e [`../HANDOFF.md`](../HANDOFF.md)
- Reconhecimento técnico da versão web (mapa de contratos e riscos): [`NOTES.md`](NOTES.md)

## Requisitos

| Item | Versão / observação |
|---|---|
| Node.js | **18+** para o proxy (`fetch` global); o servidor sem proxy e o build usam apenas APIs antigas (`fs.rmSync` exige 14.14+) |
| Navegador | Chrome/Edge e Firefox 159 recentes (testados em headless); Safari **não testado** |
| Dependências | **nenhuma** — não há `npm install` obrigatório; `hls.js`/`mpegts.js` já estão em `web/vendor/` |
| Rede | o app precisa alcançar os servidores das listas; mídia/API dependem de **CORS** (veja abaixo) |

## Como rodar

```powershell
# na raiz do repositório
node web/server.js
# Space IPTV web em http://127.0.0.1:8095/
```

Opções (todas opcionais):

```powershell
node web/server.js --port 8099        # outra porta (env PORT também vale)
node web/server.js --host 0.0.0.0     # expõe na LAN (veja o aviso abaixo)
node web/server.js --proxy            # liga o proxy local opt-in (env PROXY=1)
node web/server.js --help
```

- O bind padrão é **`127.0.0.1`** (só esta máquina). A porta padrão é **8095** — as portas
  `8080` e `8090` são dos mocks e a `8096` é do painel de agentes.
- `--host 0.0.0.0` abre o servidor **e o proxy** para qualquer máquina da rede. O proxy
  `/__proxy` **não tem autenticação**: em rede não confiável, qualquer um poderia usá-lo para
  acessar URLs. Use apenas em rede local confiável e nunca exponha na internet.
- O servidor serve a raiz do repositório com este mapa:

  ```
  GET /                 -> web/index.html
  GET /web/...          -> web/...
  GET /tv/...           -> tv/...
  GET /web/index.html   -> 302 para /
  ```

  Não há listagem de diretório; a resposta usa `Cache-Control: no-store` (desenvolvimento).

### Mocks de desenvolvimento

As listas e streams de teste são opcionais e ficam em processos separados:

```powershell
# terminal 1 — Xtream falso (usuário/senha test/test) e /list.m3u na porta 8080
node tools/mock-server.js

# terminal 2 — streams de verdade (HLS/TS/MP4) na porta 8090
$env:HOST_IP='127.0.0.1'; node tools/mock-streams.js
```

- `http://127.0.0.1:8080/list.m3u` — 200 canais, 20 filmes e séries para **catálogo e
  navegação**; os streams desse mock apontam para `localhost:9` e **não tocam**.
- `http://127.0.0.1:8090/lista.m3u` — HLS, TS contínuo, MP4, 404/403 e adulto para **testar o
  player**. `HOST_IP=127.0.0.1` é necessário para as URLs saírem no endereço da sua máquina.
- Xtream de teste: servidor `http://127.0.0.1:8080`, usuário `test`, senha `test`.

## Build estático

```powershell
node web/build.js
```

O build **não usa bundler nem minificação**: só valida as fontes, limpa o destino e copia os
arquivos com a mesma estrutura relativa do `index.html`.

```
dist/web/
  index.html
  web/
    js/      keys.js, pointers.js, net.js, player.js, shell.js
    css/     web.css
    vendor/  hls.min.js (v1.5.18), mpegts.min.js (v1.8.0)
  tv/
    js/      camada de negócio compartilhada (inclui os arquivos da TV que a web não carrega)
    css/     design-system.css, app.css
    fonts/   Orbitron e Inter (woff2)
    icon.png
```

- `--out <pasta>` (ou env `BUILD_OUT`) muda o destino; o padrão é `dist/web`. O destino precisa
  ficar **dentro do repositório** e fora de `web/`, `tv/`, `tools/`, `celular/` e `projetor/`
  (o build limpa o destino antes de copiar — não deixamos apontar para as fontes).
- O build é **idempotente**: rodar de novo limpa e recopia. Se faltar arquivo essencial, falha
  com a lista do que falta **antes** de tocar no destino.
- Ao final ele valida as referências relativas do `index.html` e os `url()` dos CSS, recusa
  arquivos de desenvolvimento no destino e imprime a contagem de arquivos/bytes e o caminho
  final. Medido nesta entrega: **42 arquivos, ~1,3 MB**.
- O `web/` do destino é a pasta `web/` real, mas só com `js`, `css` e `vendor`: `server.js`,
  `build.js`, `README.md`, `NOTES.md` e `dist/` **não** entram.

### Publicar como site estático

Copie **o conteúdo** de `dist/web/` para a raiz da hospedagem. Como todos os caminhos do
`index.html` são relativos (`tv/css/...`, `web/js/...`), o mesmo build funciona:

- em `https://host/` (raiz do domínio);
- em `https://host/repo/` (GitHub Pages, subpasta).

Não há rotas de SPA: não é preciso configurar rewrite. O servidor da hospedagem precisa servir
`index.html` na raiz e os tipos usuais (`.js`, `.css`, `.woff2`, `.png`).

Em build estático **não existe proxy local**: o ping `/__proxy/ping` responde 404 no host
estático, o badge “proxy local” fica escondido e o app segue sem proxy (as limitações de CORS
continuam valendo). O `server.js` local responde 200 `{ok:false}` nessa rota para não encher o
console de 404.

## Estrutura de `web/` e o que é reutilizado

```
web/
  index.html        palco 1920x1080 com #stage, #shell, #overlays, #toast e a ordem dos scripts
  css/web.css       só o que é de navegador: palco escalado, cursor, tela cheia, foco, reduced-motion
  js/keys.js        App.nav (pilha de camadas) + teclado do navegador
  js/pointers.js    ponte de mouse/roda/toque (foco por índice -> ação)
  js/net.js         mensagens de CORS + proxy local opcional (App.net)
  js/player.js      App.player HTML5/HLS/TS com o mesmo contrato da TV
  js/shell.js       menu, HUD, troca de telas, startup, palco, tela cheia
  vendor/           hls.js e mpegts.js com versão fixa (sem CDN em runtime)
  server.js         servidor estático zero-dep (+ /__proxy opt-in)
  build.js          monta dist/web (cópia, sem minificar)
  NOTES.md          reconhecimento técnico (contratos, riscos); não é carregado pelo app
  README.md         este arquivo
```

`tv/js` é a **fonte única de verdade** (parser M3U, Xtream, catálogo, listas, favoritos,
histórico, parental, retomada, saúde, TMDb, telas, componentes). A web **não copia** essa
camada: o `index.html` carrega os mesmos arquivos de `../tv/js`. Corrigiu uma regra de negócio?
Corrija em `tv/js` e a TV, o Android e a web ficam certos.

O que a web **substitui** (os arquivos da TV equivalentes **não** são carregados):

| Arquivo da web | Substitui | Motivo |
|---|---|---|
| `web/js/keys.js` | `tv/js/navigation/keys.js` | teclado/mouse do navegador; `App.registerKeys` vira no-op |
| `web/js/player.js` | `tv/js/player/player.js` | HTML5 + hls.js/mpegts.js em vez de AVPlay |
| `web/js/shell.js` | `tv/js/main.js` | sem modal de saída, sem zapping do Tizen, `exit` vira toast |

Os demais arquivos de `tv/js` são carregados na mesma ordem do app da TV, **menos**
`navigation/keys.js`, `player/player.js` e `main.js`. O build copia `tv/js` inteiro (inclusive
esses três) por ser a fonte única; o `web/index.html` é que decide o que carregar.

`web/css/web.css` só **sobrescreve** o que é específico de navegador. Tokens, fontes, cards,
modais, player e animações continuam vindo de `tv/css/design-system.css` e `tv/css/app.css`.
Nada de redesign.

## Teclado e mouse

Teclas físicas → ações do controle:

| Tecla | Ação |
|---|---|
| ◀ ▶ ▲ ▼ | navegar |
| Enter | OK (segurar 650 ms = favoritar) |
| Esc / Backspace | voltar |
| Espaço | play/pausa no player |
| PageUp / PageDown | canal anterior / próximo |
| F | favoritar (equivalente ao amarelo) |
| X | troca rápida (equivalente ao azul) |
| I | informações/saúde do canal |
| 0–9 | abre o 1º…9º favorito (funciona de qualquer tela) |
| Home | ir para a tela inicial |
| M | mudo (no player) |
| ? | ajuda de controles |
| ⛶ (HUD) | tela cheia (Esc sai da tela cheia antes de fechar o player) |

- Dentro de `input`/`textarea`/`contenteditable`, letras, números, setas horizontais, Backspace
  e Tab ficam com o campo; Esc sai do campo, ↑/↓ saem e continuam a navegação, Enter aciona
  “Salvar” quando o modal visível tem botão primário.
- Mouse: passar o mouse move o foco; clicar ativa; a roda navega em vez de rolar; segurar o
  botão ~650 ms favorita; o cursor desaparece após ~2,5 s.
- `Ctrl`/`Meta`/`Alt` não são interceptados (atalhos do navegador continuam funcionando), e
  eventos repetidos só repetem navegação.

## Player

- Mesmo contrato da TV: `App.player.play({item, list, ep, urls, live, startAt, chans, onClose,
  title, sub})`, `App.player.close()` e `App.player.isOpen()`.
- Escolha de motor por URL: `.m3u8` → HLS (nativo no Safari; `hls.js` nos demais); `.ts` →
  `mpegts.js`; demais → `<video>` nativo. As URLs são tentadas **na ordem** recebida.
- `hls.js`/`mpegts.js` são carregados **sob demanda** de `web/vendor/` (caminho relativo), uma
  única vez; sem CDN em runtime.
- Overlay “Enter para iniciar” quando o navegador bloqueia autoplay (`NotAllowedError`); o
  áudio não começa mudo por padrão.
- Controles web-only na barra: mudo, tela cheia e Picture-in-Picture (quando
  `document.pictureInPictureEnabled`). O vídeo usa `object-fit: contain` e fundo preto.
- Live: painel de canais, zap por ▲▼/PageUp/PageDown, troca rápida (X), atalhos 1–9 e favoritar
  (F/segurar Enter); reconexão de até **3 tentativas** (1,5 s × tentativa) antes da mensagem de
  erro. Em VOD: pausa, seek de ±10 s (◀/▶), ±30 s (FF/RW), clique na barra e retomada por
  `startAt` (>5 s). Histórico é gravado periodicamente e ao fechar.
- **Live não pausa** no HTML5 (mesma regra do código da TV): o OK abre o painel de canais e o
  Espaço/Enter não congelam o canal.
- Ao fechar, o player pausa, remove `src`, destrói `hls`/`mpegts`, limpa timers, sai da tela
  cheia/PiP e retoma a saúde dos canais.

## Rede: CORS, mixed content e segredos

O navegador é mais restrito que o AVPlay/ExoPlayer da TV. O que depende de CORS:

| Operação | Precisa de CORS? | Por quê |
|---|---|---|
| Baixar M3U / listas Xtream (`App.http`) | **sim** | leitura da resposta por script |
| Saúde dos canais (`App.http.probe`) | **sim** | XHR de leitura |
| HLS via `hls.js` | **sim** | manifesto e segmentos por XHR |
| MPEG-TS via `mpegts.js` | **sim** | XHR |
| `<video src="...mp4">` direto | **não** | mídia direta (sem `crossorigin`) |
| HLS nativo do Safari | **não** | o próprio `<video>` busca |
| Logos e pôsteres (`<img>`) | **não** | imagem |

- Erro de CORS chega como `{ code: 'network' }`; a web **estende** `App.friendly` para dizer
  que pode ser CORS (sem alterar `tv/js`). O `probe` também pode devolver `opaque` (bloqueio de
  leitura): a saúde fica **cinza**, não “offline”.
- **Mixed content**: em uma página `https://`, o navegador bloqueia requisições `http://`
  feitas por script (lista, Xtream, probe, HLS via XHR) e trata mídia `http://` como
  incompatível. Para listas `http://`, sirva o app por `http://` na LAN ou use o proxy local;
  para publicar em `https://`, as fontes precisam ser `https://`.
- Provedores que bloqueiam User-Agent de navegador vão falhar. Isso é **limitação do alvo**,
  não bug do app: a mensagem aparece e o app segue.
- **WebCrypto**: `crypto.subtle` só existe em **contexto seguro** — `localhost`/`127.0.0.1` ou
  `https://`. Servido por `http://192.168.x.x` (LAN), o `store.js` cai no formato `p0:`
  (**Base64, não é criptografia**). Nesse cenário, senha Xtream e URL M3U ficam apenas
  ofuscadas. Para AES-GCM de verdade na LAN: use `https://` ou acesse por `localhost`.
- **IndexedDB** pode falhar em modo privado; o `store.js` já tem fallback em memória (o
  catálogo deixa de persistir, mas o app não quebra). Isso **não foi testado** nesta entrega
  em todos os navegadores.
- `localStorage` tem ~5 MB: guarda listas/credenciais/estado pequeno; o catálogo vai para o
  IndexedDB.

## Proxy local (opt-in)

```powershell
node web/server.js --proxy
```

- Endpoint `GET /__proxy?url=<encodeURIComponent(url)>`, **na mesma origem** do app — por isso
  não há CORS entre a página e o proxy.
- Repassa `Range` (essencial para MP4), `Content-Type`, status e faz **streaming** (não carrega
  o arquivo inteiro na memória).
- **Reescreve playlists HLS** (`.m3u8`/`mpegurl`/texto iniciado por `#EXTM3U`): resolve URIs
  relativos e reescreve linhas de segmento, `#EXT-X-KEY:URI=` e `#EXT-X-MAP:URI=` para passarem
  pelo proxy. O rewrite usa URLs absolutas porque o parser M3U do app exige esquema.
- Só aceita `http:`/`https:`; recusa recursão em `/__proxy`.
- **Não repassa cookies** do navegador (nem `Referer`/`Authorization`), **não registra a URL
  completa** (só protocolo+host+`/...`), **não tem autenticação**.
- Limites: playlist reescrita até 32 MiB; timeout de cabeçalhos 15 s; timeout ocioso 30 s; URL
  de até 8 KB. Ajustáveis por `PROXY_PLAYLIST_MAX`, `PROXY_HEADERS_TIMEOUT`,
  `PROXY_IDLE_TIMEOUT`.
- No cliente (`web/js/net.js`), o proxy é detectado por `GET /__proxy/ping`. Se existir, passa a
  valer para `App.http.get/stream/probe` e para URLs de mídia `.m3u8`/`.ts` (MP4 direto fica
  intacto). O HUD mostra o badge **“proxy local”**. O ping responde **200 com `{ok:false}`**
  quando o proxy está desligado — assim o console não fica cheio de 404.
- **Nunca é ativado por padrão** e **não existe em build estático**.

## Limitações conhecidas

- **Navegadores testados**: Chromium/Edge e Firefox 159 nesta máquina, via headless (boot,
  catálogo, teclado e reprodução HLS). **Safari não foi testado**; o código tem caminhos
  específicos (HLS nativo, `webkit` de tela cheia) que não foram exercitados aqui.
- **Formatos**: HLS depende de `hls.js` (Chrome/Edge/Firefox) ou do suporte nativo (Safari);
  MPEG-TS depende de `mpegts.js`/MSE; **MKV/AVI dependem do navegador** (muitas vezes não
  tocam); codecs H.265/AC3 também dependem do navegador. Não há transcodificação.
- **CORS** e **mixed content** (acima) são as causas mais comuns de lista/stream que não abre.
- **Autoplay** pode ser bloqueado até um Enter/clique; o app mostra o overlay e retoma.
- **IndexedDB em modo privado**, cota de `localStorage` e persistência em navegadores com
  limpeza automática não são garantidos.
- **Sem PWA/service worker**, sem Chromecast/AirPlay, sem EPG, sem DRM, sem gravação, sem
  legendas externas e sem sincronização entre dispositivos — fora do escopo desta versão.
- **Celular/tablet**: o alvo é desktop. Toque funciona como “melhor esforço”; não há layout
  mobile dedicado nem suporte garantido.
- **Saúde dos canais** sofre o limite de CORS: sem permissão de leitura, o canal fica cinza em
  vez de ser acusado como offline.
- A janela é um palco fixo de **1920×1080 escalado**; abaixo de 1024×576 aparece um aviso
  discreto e o conteúdo continua utilizável, mas não é um layout responsivo redigido para
  telas pequenas.

## Decisões tomadas

1. **Palco 1920×1080 escalado** (`transform: scale()` com `translate` para centralizar e
   letterbox preto). O layout do design system é fixo em px; escalar mantém a TV e a web com a
   mesma geometria. `web.css` força `position: absolute` nos elementos que a TV posiciona como
   `fixed`, porque o `#stage` com `transform` vira o bloco de contenção.
2. **Player dentro do `#stage`** (a TV usa `document.body`), para herdar a escala e o cursor.
   As classes `open/ui/busy/err/panel/blocked` e o DOM (`#player`, `.pl-top`, `.pl-bottom`,
   `.pl-msg`, `.pl-panel`, `.pl-spin`, `.pl-prog`) seguem os da TV.
3. **Teclado = controle**: `web/js/keys.js` recria `App.nav` e traduz as teclas; as dicas do
   rodapé são normalizadas no shell (AMARELO→F, AZUL→X, INFO→I, VOLTAR→Esc, segurar OK→segurar
   Enter), sem editar as telas.
4. **`exit` vira toast** (“Feche a aba para sair”); não existe modal de saída na web.
5. **HUD ganhou** o botão de tela cheia (⛶, 44×44) e o badge “proxy local”; o resto do HUD é o
   da TV.
6. **`_press` aditivo no `pinPad`** de `tv/js/components/ui.js`: uma linha publica o gancho de
   clique das teclas do PIN. Na TV não há mouse, então o comportamento dela não muda.
7. **Live não pausa** e o bloqueio parental no player continua sendo “toast + não abre” (igual
   ao código real da TV), não um pedido de PIN no meio da reprodução.
8. **HLS via `hls.js` e TS via `mpegts.js` vendorizados**, carregados sob demanda; MP4/WebM no
   `<video>` sem `crossorigin`.
9. **Build sem bundler**: cópia + validação de referências; publicado em subpasta sem mudança
   de código.
10. **A web não copia `tv/js`**: carrega os mesmos arquivos, exceto os três substituídos
    (`keys`, `player`, `main`).
11. **Sem PWA/service worker e sem layout mobile dedicado** nesta versão — o escopo é desktop.

## Como testar

```powershell
# 1. Build estático e conferência da árvore
node web/build.js
Get-ChildItem dist/web -Recurse -File | Measure-Object -Property Length -Sum

# 2. Servir o build (qualquer servidor estático; exemplo com Python)
python -m http.server 8123 --directory dist/web
# abra http://127.0.0.1:8123/ e confira a aba Network sem 404
# para simular subpasta, sirva a pasta que contém dist/web e abra /web/index.html

# 3. App em desenvolvimento
node web/server.js
# abra http://127.0.0.1:8095/

# 4. Mocks (em outros terminais)
node tools/mock-server.js
$env:HOST_IP='127.0.0.1'; node tools/mock-streams.js

# 5. Testes Node da camada compartilhada
node tools/test-m3u.js
node tools/test-resume.js
node tools/test-health.js
```

Checklist mínimo no navegador:

- [ ] página carrega sem erro no console e sem 404 de assets;
- [ ] navegação só com teclado (menu → telas → categorias → cards → detalhes → voltar);
- [ ] adicionar lista M3U do mock (`http://127.0.0.1:8080/list.m3u`) e ver o catálogo;
- [ ] abrir um canal HLS (`/hls/index.m3u8`), um TS (`/live/2.ts`) e um MP4 (`/movie/1.mp4`)
      do `mock-streams`; trocar canal, abrir o painel (OK), favoritar (F) e sair (Esc);
- [ ] mouse: hover move o foco, clique ativa, roda navega, clicar no campo permite digitar;
- [ ] tela cheia pelo HUD e por F11; Esc sai da tela cheia sem fechar o player;
- [ ] com `--proxy`, o badge “proxy local” aparece e os streams passam por `/__proxy`;
- [ ] no build estático o badge não aparece e o app funciona sem proxy.

### Testes executados nesta entrega (13/11/2026)

- `node web/build.js`: **42 arquivos, ~1,3 MB** em `dist/web/`; árvore conferida; nenhum
  `server.js`/`build.js`/`.md`/`state` no destino; segunda execução idempotente.
- `node web/build.js --out ...` / `BUILD_OUT=...`: destino alternativo criado e limpo; destinos
  dentro de `web/`, na raiz do repo e fora do repo recusados com exit 2.
- Falha de fonte essencial simulada em pasta temporária: exit 1 com a lista do que falta, sem
  tocar no destino.
- Build servido em porta livre (`8123`) por um servidor estático temporário **sem proxy**, com
  duas montagens (`/` e `/repo/`): **84/84 requisições HTTP 200** (42 arquivos × 2 montagens).
  No navegador, **Edge headless `Edg/157.0.4341.57`** (Chromium), 1920×1080:
  - `http://127.0.0.1:8123/` e `http://127.0.0.1:8123/repo/` montaram o app completo
    (`#stars`, 7 itens de menu, HUD com relógio, toast “Adicione uma lista para começar”);
  - **nenhuma exceção de JavaScript**, nenhum `requestfailed` e nenhum 404 além de
    `/__proxy/ping` (1 por página), que é o comportamento esperado em hospedagem estática —
    o `server.js` local responde 200 `{ok:false}` nessa rota;
  - a única mensagem de erro no console é o registro de rede desse 404 do ping; o app segue
    sem proxy (`App.net.active() === false`);
  - navegação por teclado exercitada: Esc → menu, seta muda o foco, Enter entra na tela,
    Esc volta ao menu.
- `node tools/test-m3u.js`: **passou** (100 mil itens em 1945 ms).
- `node tools/test-resume.js`: **27/27 testes passaram**.
- `node tools/test-health.js`: **57/57 testes passaram**.

O que **não** foi verificado nesta entrega: Safari, celular/tablet, modo privado do navegador,
toque físico/long-press e listas reais do usuário. Na integração foram verificados HLS/TS/MP4,
PIN, fullscreen e retomada em Edge e Firefox headless.

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Lista não carrega; mensagem de rede | CORS ou mixed content | confira o console/Network; use `--proxy` ou uma fonte `https`/`http` compatível |
| Lista carrega, mas o stream não toca | CORS no manifesto/segmento, codec ou URL quebrada | teste o mesmo canal no navegador; veja a Saúde (I); use HLS/MP4 compatível |
| Bolinha cinza em todos os canais | provedor bloqueia `probe` (CORS) | é limitação do provedor; a reprodução real ainda pode funcionar |
| Player pede “Enter para iniciar” | autoplay bloqueado | pressione Enter ou clique |
| `crypto.subtle` indisponível; senha em `p0:` | acesso por `http://` fora de localhost | acesse por `localhost`, use `https` ou ciente de que não está cifrado |
| Proxy não aparece no HUD | servidor sem `--proxy` ou build estático | rode `node web/server.js --proxy` em `127.0.0.1` |
| `EADDRINUSE` | porta 8095 ocupada | `node web/server.js --port 8097` |
| 404 de assets no build | publicação copiou só o `index.html` | publique **todo** o conteúdo de `dist/web/` (com `web/` e `tv/`) |
| Canvas/estrelas não aparece | erro anterior de script | veja o console; a ordem dos `<script>` do `index.html` importa |
