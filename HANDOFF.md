# HANDOFF — Space IPTV (Samsung Tizen TV)

Documento para quem for continuar o projeto (pessoa ou outra IA) em outro computador.
Leia inteiro antes de mexer. Complementa o `README.md` (resumo curto).

---

## 0. Repositório e layout

- **GitHub:** <https://github.com/pedropaulodfr/space-iptv> (branch `main`, público).
- **Um projeto por dispositivo:** `tv/` (app Tizen), `celular/` (projeto Android, gera o
  APK que roda no celular **e** no projetor), `projetor/` (modo projetor: documentação e
  capturas) e `web/` (versão navegador desktop, descrita na §16). `tools/` tem os scripts de
  desenvolvimento; `dist/` é artefato de build e **não é versionado**.
- A camada de negócio é **uma só**: `tv/js` é copiado para os assets do APK no build
  (`syncTizenSources`) e carregado diretamente pela versão web. Corrija regra de negócio ali,
  nunca em dois lugares.
- Antes de commitar, confira que `celular/keystore.properties`, `dist/`, `tools/_streams`
  e os `.log` continuam fora do índice (`git status --ignored`).

---

## 1. O que é o app

Player de listas IPTV para Samsung Smart TV (Tizen), feito pelo usuário Pedro para uso próprio.

Desde **13/11/2026** o projeto também tem uma **versão web** para navegador de desktop, que
reaproveita a mesma camada `tv/js` — ver §16.

- Cadastra listas **M3U por URL** e **Xtream Codes** (servidor + usuário + senha), várias listas, uma ativa por vez.
- Seções: **Início, TV ao vivo, Filmes, Séries (temporadas/episódios), Pesquisa global, Favoritos, Configurações**.
- Player próprio (AVPlay da Samsung), histórico ("Continuar assistindo"), favoritos por lista.
- Visual obrigatório: **Space Launcher Design System** (arquivo original: `K:\Downloads\space_launcher_design_system.md` no PC antigo; os tokens já estão em `tv/css/design-system.css`). Não inventar outra identidade visual.
- O app **não traz nenhuma lista, canal ou credencial**. Só reproduz o que o usuário cadastra. Manter assim.
- Idioma da interface e das mensagens: **português do Brasil**.

## 2. Ambiente e TV de teste

| Item | Valor |
|---|---|
| TV | Samsung 5 Series 43" `UN43T5300AGXZD`, Tizen 5.5 (linha 2020), perfil `tv` |
| Navegador da TV | Chromium 69 (`Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) ... 69.0.3497.106/5.5 TV Safari`) |
| IP da TV | `192.168.0.13` (o prompt original citava `.10` por engano) |
| Tela | 1920×1080 (layout fixo em px, base Full HD) |
| CPU/arquitetura | armv7 |
| PC anterior | Windows 11, IP `192.168.0.9`, Tizen Studio em `C:\tizen-studio` |
| App ID | `SpcIptv001.SpaceIPTV` (package `SpcIptv001`) |
| Widget ID (`config.xml`) | `http://spaceiptv.app/SpaceIPTV` � n�o usar nome de empresa de terceiros neste campo |

### Estado desta máquina (verificado em 04/11/2026)
- **Tizen Studio está em `D:\tizen-studio`** (não em `C:`): `D:\tizen-studio\tools\sdb.exe`, `D:\tizen-studio\tools\ide\bin\tizen.bat` (Tizen CLI 2.5.25, JDK em `D:\tizen-studio\jdk`), dados em `D:\tizen-studio-data`.
- `sdb connect 192.168.0.13` funciona; TV identificada como `UN43T5300AGXZD`. Este PC está em `192.168.0.6`.
- **Perfil de assinatura: `AltLauncherProfile`** (criado em 04/11/2026, é o ativo em `D:\tizen-studio-data\profile\profiles.xml`):
  - autor: `D:\tizen-studio-data\profile\keystore\AltLauncherProfile\author.p12`, alias `Alt Launcher Dev`, CN=`Alt Launcher Dev`, emitido por `Tizen Developers CA`, **válido até 31/12/2026** (mesma data do CA do SDK), thumb `A070D4D6...BD3416` — **certificado de desenvolvimento herdado de outro projeto; não é a identidade deste app** (o pacote de loja usa o autor Samsung `CN=Pedro Paulo`);
  - distribuidor: `tizen-distributor-signer.p12` do SDK;
  - **senha do p12: `SpcIptv#2026`**; senha do distribuidor (interna do CLI): `tizenpkcs12passfordsigner`;
  - **backup do perfil**: `D:\Documentos\projects\_iptv-backup\tizen-cert\` (`author.p12`, `profiles.xml` e `LEIA-ME.txt` com a senha e o comando de recriação). **Guardar bem: sem ele não dá para atualizar o app sem desinstalar.**
- **Empacotar/instalar:** `pwsh tools\package.ps1` (só empacota) ou `pwsh tools\package.ps1 -Install` / `-Install -Run`. O script usa `-s AltLauncherProfile` e gera `dist\SpaceIPTV.wgt`.
- Chave de autor antiga (`CN=AltLauncher Dev`, thumb `83DD...EABF`, do PC anterior) **não existe mais** — foi esse o motivo do erro "Author certificate not match" (§8 item 13).

### Pontos que travaram a conexão e como resolver
- O Modo Desenvolvedor da TV **só aceita `sdb` do IP cadastrado em "Host PC IP"**. Em outro computador: na TV, Apps → digitar `12345` → Developer mode **On** → Host PC IP = IP do novo PC → **reiniciar a TV**.
- Conferir o IP aceito: `http://192.168.0.13:8001/api/v2/` → campos `developerMode` e `developerIP`.
- A TV aceitou o pacote com o perfil `AltLauncherProfile` (certificado de autor + distribuidor público do SDK). Em modo desenvolvedor isso bastou. **Para publicar/distribuir seria preciso um certificado Samsung** (Certificate Manager, login Samsung, DUID da TV). Nunca peça a senha Samsung do usuário; ele mesmo gera o certificado.

## 3. Restrições técnicas (importantes)

- **JavaScript ES5 + Promise**. Sem `let/const/arrow/template literals`, sem módulos ES, sem bundler, sem frameworks. Motivo: compatibilidade e simplicidade na TV. Cada arquivo é um IIFE que se pendura em `window.App`.
- Ordem de carga dos scripts importa: ver `tv/index.html`.
- `config.xml`: privilégios `tv.inputdevice`, `avplay`, `internet`; `<access origin="*">` (XHR/fetch entre origens liberado pela política de acesso do widget).
- Performance: poucas dependências, listas **virtualizadas**, `backdrop-filter` só em painéis grandes (nunca em cada card), animações leves.
- Nunca usar `innerHTML` com dado externo (listas são dados não confiáveis). Sempre `textContent`. (Só os ícones SVG estáticos do menu usam `innerHTML`.)
- Nunca logar credenciais: usar `App.log` (aplica `App.redact`).
- **MultiView (duas janelas ao vivo) NÃO funciona nesta TV.** O Tizen 5.5 tem **um único decodificador** de vídeo; `webapis.avplaystore` até existe, mas `IN_APP_MULTIVIEW` só vale a partir do Tizen 7.0. Testado em 04/11/2026: o probe retornou `{ok:false, version:5.5, store:true}` e duas janelas AVPlay não abrem. A funcionalidade foi **removida** do app (não há `js/player/multiview.js`). A alternativa é a **TROCA RÁPIDA** na tecla AZUL. Não reintroduzir MultiView sem trocar de TV.

## 4. Estrutura do projeto

```
K:\projetos\IPTV-Tizen\
├─ app\                      <- pacote Tizen (tudo aqui vai para a TV)
│  ├─ config.xml
│  ├─ index.html
│  ├─ icon.png               <- 512x512, imagem fornecida pelo usuário (planeta/TV "Space IPTV")
│  ├─ fonts\                 <- Orbitron 600/700/800 e Inter 400/500 (woff2, subset latin)
│  ├─ css\design-system.css  <- tokens, tipografia, .glass-panel, .card, foco, glow
│  ├─ css\app.css            <- layout e componentes
│  └─ js\
│     ├─ core\util.js        <- App.el/clear/norm/hash/uid/fmtTime/redact/log/bus/toast/friendly
│     ├─ core\starfield.js   <- estrelas em canvas (~90, ~20fps, pausa no player)
│     ├─ storage\store.js    <- App.store (localStorage "sl.*"), App.idb, App.secrets (AES-GCM)
│     ├─ api\http.js         <- App.http.get (XHR) e App.http.stream (fetch em fluxo, reserva XHR binário)
│     ├─ api\xtream.js       <- App.xtream (auth, fetchAll, seriesInfo, vodInfo, URLs de stream)
│     ├─ parser\m3u.js       <- App.m3u (Parser em fluxo, unpack de episódios, classify)
│     ├─ services\lists.js   <- App.lists (CRUD das listas, credenciais seladas)
│     ├─ services\catalog.js <- App.catalog (cache IDB, refresh, índices, busca, urls de reprodução)
│     ├─ services\userdata.js<- App.favs, App.hist
│     ├─ navigation\keys.js  <- teclas do controle, OK longo, App.nav (pilha de camadas)
│     ├─ components\vlist.js <- App.VList (lista/grade virtualizada)
│     ├─ components\cards.js <- App.cards (poster, channel) + carga de imagem com fallback
│     ├─ components\hrow.js  <- App.HRow (faixa horizontal da Home)
│     ├─ components\ui.js    <- App.ui (open/overlay, btn, group, confirm, alert, form, loading)
│     ├─ player\player.js    <- App.player (AVPlay + HTML5)
│     ├─ screens\details.js  <- App.actions (open/play/fav/resume) + tela de detalhes
│     ├─ screens\home.js, browse.js, results.js, settings.js
│     └─ main.js             <- shell (menu lateral, HUD, troca de telas, saída, init)
├─ dist\                     <- .wgt gerado (SpaceIPTV.wgt, "Space IPTV.wgt")
├─ tools\                    <- só desenvolvimento, NÃO vai no pacote
│  ├─ tv.js                  <- controle remoto via DevTools Protocol (ver §9)
│  ├─ mock-server.js         <- serve app/ e imita Xtream (usuário/senha "test") na porta 8080
│  ├─ test-m3u.js            <- testes do parser
│  ├─ probe-list.js          <- resume uma lista M3U local
│  ├─ probe-stream.js        <- mede memória do parser em fluxo
│  ├─ serve-file.js          <- serve um arquivo na LAN (porta 8099) p/ testar listas grandes na TV
│  ├─ _fonts\                <- node_modules só para copiar as fontes (@fontsource)
│  └─ _sample\               <- amostras locais (pode apagar)
├─ README.md
└─ HANDOFF.md                <- este arquivo
```

## 5. Arquitetura em uma página

**Navegação (D-Pad).** `keys.js` converte `keydown` em ações (`up/down/left/right/ok/hold/back/exit/play/pause/playpause/stop/ff/rw/chup/chdown/info/red/green/yellow/blue`). `App.nav` é uma **pilha de camadas**: só a do topo recebe as ações (shell → modais/detalhes → player). Cada camada tem `key(acao) → true/false`.
- **OK** dispara no `keyup`; segurar **650 ms** dispara `hold` (favoritar). **Amarelo** (ou a tecla `Y` no teclado do PC) faz o mesmo.
- Dentro de `<input>` (teclado virtual da TV): Enter/Voltar/Done saem do campo; Cima/Baixo saem e navegam.
- O foco é sempre por **índice** (VList/HRow/ui.group), não por geometria; o foco nunca some porque cada tela decide para onde vai ao sair de uma zona.
- Shell (`main.js`): `area` = `menu` ou `screen`. Tela devolve `false` em `left`/`back` para voltar ao menu. Cada tela expõe `{hints, mount(el), unmount(), enter(), key(acao)}`.

**Dados.** `App.catalog.data = {live[], movie[], series[], cats{live,movie,series}, by{tipo:{catId:[]}}, map{tipo:{id:item}}, warns}`.
Item normalizado: `{id, t:'live'|'movie'|'series', n, ns(nome sem acento minúsculo), c(catId), l(logo), u(url direta, só M3U), x(ext), y, g, p, d, r, a, ek/ei(M3U série)}`.
- M3U: id = `'m'+hash(url)`; categoria = `group-title`; classificação por heurística (`classify` em `m3u.js`: `/movie/`, `/series/`, SxxExx, grupo com filme/série, extensão de vídeo, duração).
- Xtream: ids vêm do servidor; URLs montadas na hora (`App.xtream.liveUrls/movieUrls/episodeUrls`), nunca guardadas.

**Cache e memória (decisão central).**
- `cat.<listId>` no IndexedDB: `{ver:2, updated, epc, data}`.
- Episódios de séries M3U **não ficam em memória**: parser os "empacota" por série (`s\te\ttitulo\turl` por linha) e o catálogo grava em blocos de 400 séries: `eps.<listId>.<n>`. A série guarda `ek` (bloco) e `ei` (posição). `catalog.seriesInfo` lê o bloco só ao abrir a série e usa `App.m3u.unpack`.
- Cache antigo (`ver:1`, com `eps` embutido) ainda é aceito em `seriesInfo`.
- `App.catalog.dropCache(id)` apaga catálogo + blocos (usado ao excluir lista).
- Parser em fluxo: `Parser.feed(texto)` guarda a última linha incompleta; `own()` copia strings para **não reter o texto original** (substrings do V8 mantêm o pai vivo).
- Download: `http.stream` usa `fetch` + `ReadableStream`; se falhar antes do primeiro pedaço, cai para XHR binário. `TextDecoder` com `stream:true`.
- Atualização automática se o cache tem mais de 6 h (`needsRefresh`) e há internet. Offline: abre o cache e mostra "Sem internet • dados salvos".

**Segredos.** Senha Xtream e URL M3U são seladas com AES-GCM (`App.secrets`). A chave aleatória fica em `localStorage` (`sl.k`). A Tizen Web não expõe keystore; isso protege contra leitura casual, não contra root. Na UI só aparece o host.

**Persistência (localStorage, prefixo `sl.`):** `lists`, `active`, `favs` (`{ "listId|tipo|id": {...} }`), `hist` (máx. 60), `k`. IndexedDB: `cat.*` e `eps.*`.

**Favoritos/histórico** são sempre ligados à lista de origem (`listId` na chave).

### Controle parental (PIN) — desde 04/11/2026

- Módulo novo: `js/services/parental.js` (`App.parental`). Estado: `sl.pinS` (PIN **selado** com AES-GCM, igual às credenciais) e `sl.pinOn` (ligado/desligado). O desbloqueio **não persiste**: a cada início do app volta bloqueado.
- **O que é considerado adulto:** nome da **categoria**, nome do **item** ou nome da **lista** casando com o regex `ADULT` (xxx, adulto, porn\*, erótic\*, hentai, onlyfans, putaria, sexo/sexual, +18, 🔞). Se o nome da lista casa, **a lista inteira** fica oculta (é o caso de "iPTV Free List XXX"). Cuidado com falso positivo: `\bsex(o|ual)\b` não pega "Sexta-Feira" (testado).
- **Onde filtra:** `catalog.items` e `catalog.search` (logo, cobre telas e o painel de canais do player), `favs.list`, `filterCats` (categorias) e as faixas da Home. Telas vazias por bloqueio mostram "Conteúdo adulto oculto pelo controle parental…".
- **Onde pede senha:** `App.parental.guard(item)` → usado em `actions.open/playLive/playMovie/playEpisode/resume` e no `zapTo` do player. Acertando o PIN, libera a **sessão** toda (não pergunta de novo até reiniciar).
- **UI:** `App.ui.pinAsk` (confere), `App.ui.pinNew` (define, duas vezes) e `App.ui.menu`; teclado numérico `.pin` (modal 560px, 12 teclas, 4 bolinhas) navegável por D-Pad **e** pelas teclas numéricas do controle — `keys.js` agora converte keyCode 48–57/96–105 em ações `n0`…`n9`.
- **Configurações → "🔒 Controle parental"**: definir/alterar senha, ativar/desativar (desativar e alterar **exigem** a senha atual), "Liberar conteúdo adulto agora" e "Bloquear agora".
- Cache de contexto: o "lista é adulta?" é calculado uma vez por lista (`refreshCtx`, invalidado no evento `catalog`) — sem isso, filtrar 30 mil filmes lia o localStorage por item.
- **Testado na TV (DevTools)**: lista XXX ativa e bloqueada → 0 itens e 0 categorias; "Lista Brasil" bloqueada → 520 itens e 24 categorias (nada bloqueado a mais); PIN errado → "Senha incorreta" e limpa as bolinhas; PIN correto → libera a sessão; reabrir o app → volta bloqueado; menu e teclado medidos (560×528 dentro da tela, centro 960).

### Atalho numérico dos favoritos (teclas 1..9) — desde 04/11/2026

- **Numeração** em `App.favs` (`userdata.js`), derivada da ordem de `App.favs.list('live')` — a mesma do filtro **Canais** da tela de Favoritos (mais recente primeiro). Só os **9 primeiros**; itens ausentes do catálogo (`missing`) e conteúdo adulto bloqueado ficam de fora, então a sequência é sempre 1..9 sem buracos.
  - `App.favs.liveList()` → canais favoritos da lista ativa, já sem os `missing`;
  - `App.favs.nums()` → mapa `"tipo|id" → número` (cache; invalidado nos eventos `favs` e `catalog` e no `toggle`);
  - `App.favs.num(it)` → número do item (0 = não tem atalho);
  - `App.favs.byNumber(n)` → item do canal favorito `n` (1..9) ou `null`.
- **No player** (`player.js`): `onKey` intercepta `n1`…`n9` **antes** do painel de canais e só quando `S.live` (ao vivo). `jumpFav(n)` acha o favorito, troca `S.chans` pela lista de canais da **categoria do favorito** (para ▲▼/CH+− continuarem coerentes), fecha o painel se estiver aberto e chama o `zapTo` existente — nenhuma outra tecla muda de comportamento. Tecla sem favorito: não faz nada. Favorito adulto com bloqueio ativo: só um toast "Conteúdo adulto bloqueado".
- **Fora do player** (`main.js`, `shellLayer`): desde 04/11/2026 as mesmas teclas também abrem o favorito **de qualquer tela** (Home, grades, Favoritos, Configurações) via `App.actions.playFavNumber(n)` — que reusa `playLive`. Motivo: o usuário reclamou que "nada acontecia" porque estava na lista de canais, e a versão inicial só valia durante a reprodução. Continua sem efeito quando há camada por cima (modal, detalhes, player), porque só o topo da pilha recebe a tecla.
- **Teclas**: `keys.js` já converte keyCode 48–57 (`n0`…`n9`) e 96–105 do teclado numérico; `App.registerKeys` agora também registra `'0'`–`'9'` no `tizen.tvinputdevice`. O mesmo `n1`…`n9` alimenta o teclado da senha — não há conflito porque `App.nav` só entrega a tecla para a **camada do topo**.
- **Indicador**: `.favnum` (bolinha com o número) em `cards.poster` (canto inferior esquerdo do pôster), `cards.channel` (à direita, ao lado da estrela) e no painel de canais do player. Só aparece para quem tem número.
- **Testado na TV**: com 12 favoritos → 9 numerados e o 10º sem número; remover um favorito do meio renumerou sem buracos; teclas 1/2/5/9 trocaram de canal durante a reprodução; tecla sem favorito não fez nada; **controle físico confirmado** — as teclas chegam como `keyCode 49`/`50` (capturado no app com um listener de `keydown`) e trocaram de canal; com a mudança no shell, a tecla 1 abriu o canal favorito estando na Home e na grade de canais.

### Iniciar no último canal assistido — desde 04/11/2026

- Módulo novo: `js/services/resume.js` (`App.resume`), tudo no `localStorage` do app:
  - `sl.lastCh = { list, t:'live', id, ts }` — **id estável do canal + id da lista** (nunca nome nem posição);
  - `sl.resumeLast` — preferência booleana, **desligada por padrão** (`enabled()` só é true com `=== true`).
- API: `set(item)` (só `live`; não regrava se for o mesmo canal/lista), `get()`, `clear()`, `enabled()/setEnabled()`, `candidate()` (resolve o id no catálogo carregado e exige a mesma lista), `decide()` → `{ok, reason}` com `off | no-record | missing | adult | ok`, e `startup()` que devolve o canal no **máximo uma vez por sessão** (flag `tentou`) — é isso que impede abrir o player duas vezes.
- **Gravação**: `player.play()` quando `S.live` e `zapTo()` (troca de canal, CH+−, atalho 1..9). VOD não grava.
- **Inicialização**: em `main.js`, dentro do `.then()` do `App.catalog.init(l)` — ou seja, **depois** de o catálogo estar carregado (sem corrida com a leitura da lista) → `App.resume.startup()` → `App.actions.playLive(canal, itens da categoria)`. O refresh da lista continua acontecendo normalmente depois.
- **Regra de segurança (adulta)**: `decide()` consulta `App.parental.isAdult(item)` (categoria do item + lista + nome, não só nome). Se for adulto: não toca, motivo `adult`, **registro preservado**. Acesso manual continua passando pelo PIN do controle parental.
- **Configurações**: linha com interruptor entre "Limpar histórico" e "Controle parental" (`settings.js` + CSS `.btn.toggle`/`.switch`), com nome e descrição dentro do botão; o estado é lido de `App.resume.enabled()` a cada montagem da tela.
- **Testes**: `node tools\test-resume.js` cobre 27 casos (padrão desligado, gravação, não regravar, VOD não sobrescreve, persistência entre sessões, troca de canal, canal ausente, lista diferente, adulto bloqueado com registro preservado, `startup()` uma vez só). Na TV (DevTools): padrão off; interruptor liga/desliga e persiste; canal comum volta a tocar após `location.reload()`; desligada não toca; canal inexistente não gera erro; canal adulto (lista XXX) **não** tocou e o registro ficou; acesso manual ao adulto abriu o teclado de senha e não tocou.

### Saúde dos canais (monitoramento) — desde 04/11/2026

- Serviço: `js/services/health.js` (`App.health`) + `App.http.probe` em `js/api/http.js` (XHR com `Range`, TTFB, `content-type`, detecção de formato e reserva `fetch(no-cors)` para diagnosticar bloqueio).
- Registros em memória, chave `listId|live|id` (nunca por nome/posição). Nada é persistido: o cache é de sessão (60 s).
- **Fila**: `concurrency` 3, `timeout` 8 s, `retry` 1, `maxQueue` 80, `maxRecords` 6000, `cancel()` por geração (aborta XHR em voo). `pause()`/`resume()`/`idle()`/`stats()` para controle fino.
- **Classificação** (tudo em `DEFAULTS`, ajustável com `App.health.configure({...})`):
  - verde ≤ `green` (1500 ms), amarelo ≤ `yellow` (4000 ms), laranja acima disso ou com erro/formatos suspeitos;
  - **vermelho** só depois de **2 falhas seguidas** (uma falha isolada fica laranja);
  - **cinza** = não verificado, CORS/bloqueio (`code: 'opaque'`) ou `abort` — nunca vira offline por limitação técnica;
  - reprodução real confirmada nos últimos `playbackWindow` (10 min) força verde (ou amarelo se `playbackSlow`);
  - HLS: valida `#EXTM3U`, resolve variante e checa o primeiro segmento.
- **UI**: `.hdot` (bolinha 15 px) no logo do card de canal e no pôster de canais já verificados; INFO mostra detalhes do canal focado (`detail`) ou a legenda (`legend`) na coluna de categorias. Atualização é por `paintKey` (troca de classe, sem re-render) → sem mudança de layout e sem mexer no foco.
- **Integração**: `browse.js` observa primeiro os canais **visíveis** (grade virtualizada) e completa a categoria; cancela ao trocar de categoria/desmontar. `player.js` registra o resultado real (`playback(item, ok, slow)`) uma vez por canal e **pausa a fila durante a reprodução** para não roubar banda do stream.
- **Correções feitas nesta etapa** (o código herdado tinha 3 problemas):
  1. `probe` olhava o corpo antes do `content-type`, então stream TS virava `empty`/`html` e era rotulado "não parece ser um stream";
  2. `probe` marcava **404 como ok** quando o primeiro `progress` chegava antes do `readyState 4` (faltava checar `status >= 400`);
  3. limites de latência estavam baixos para live TS (mediana real 3,2 s) → 1500/4000.
- **Medido na TV**: 30 indicadores na grade de 3 colunas; navegação e INFO funcionando com 77 verificações na fila; troca de categoria cancelou o lote (77 → 12) e verificou a nova (15 canais); ao abrir um canal o monitor pausou e o registro virou `source: 'player'`; ao fechar, retomou. Na lista gratuita do usuário, **46 de 69 canais verificados retornam erro HTTP** (404/5xx) — a lista tem mesmo muitos canais mortos.
- **Testes**: `node tools\test-health.js` (57 casos: fila/concorrência, cache, cancelamento, falha isolada vs. repetida, CORS, timeout, HTTP 403/404, HLS com/sem segmento, `paint`, `playback`, pausa/retomada, regressão do TS reconhecido e o interruptor).

#### Interruptor do monitoramento (04/11/2026)

- Preferência em `sl.healthOn` — **chave ausente vale `true`** (instalação nova já vem ligada). O valor é lido uma vez no load do módulo e guardado em `off` (cache), para não tocar no `localStorage` a cada card.
- API: `App.health.enabled()` e `App.health.setEnabled(on)`. **Todas** as entradas passam pelo mesmo estado: `observe()` devolve 0 e sai antes de enfileirar, e `pump()` também não inicia nada com o monitor desligado — não existe caminho que fure a preferência.
- Desligar tem efeito imediato: `setEnabled(false)` chama `cancel()` (incrementa a geração, esvazia a fila e aborta os XHR em voo) e emite `health:config`. Religar chama `pump()` e emite o mesmo evento; `browse.js` responde com `syncHealth(true)`, que respeita o **cache** existente (nada de fila duplicada nem reverificação em série).
- UI: interruptor "Monitoramento da saúde dos canais" em Configurações (mesmo componente `toggleRow` do "iniciar no último canal"), com descrição e switch. `cards.js` só cria o `.hdot` com `App.health.enabled()` — desligado, os indicadores somem do grid e dos pôsteres (nada velho é exibido como atual). A tela ao vivo escuta `health:config`: ao desligar faz `cancel()` + `refreshAll()` (tira os pontos na hora); ao ligar refaz `syncHealth`.
- INFO com o monitor desligado mostra "Monitoramento desligado — ligue em Configurações…", em vez de dados antigos.
- **Não afeta a reprodução**: o player continua registrando `playback()` em memória (é só fato local, sem rede) e o tratamento de erros segue igual; `stats()` expõe `enabled` e `checking` para diagnóstico.
- Medido na TV: desligar → `queued 0`, `inflight 0`, **0 indicadores** na tela e aviso no INFO; religar → 30 indicadores e fila voltando a 3 em paralelo; recarregar o app com a opção desligada → continua desligada e sem indicadores. Os 10 botões do painel de Configurações continuam cabendo sem rolagem (último termina em 836 px de 856).




## 6. Player (`js/player/player.js`)

- **AVPlay primeiro** (`webapis.avplay`), `<video>` HTML5 só se não existir AVPlay (ex.: navegador do PC).
- **LIÇÃO CRÍTICA:** o AVPlay desenha o vídeo numa camada **atrás da página**. Durante a reprodução `html` e `body` precisam estar **transparentes** (`html.playing, html.playing body {background:transparent!important}`), e o shell/overlays ficam `visibility:hidden`. O bug original (áudio sem vídeo) foi um seletor errado (`body.playing html`). Não reintroduza fundo opaco no player.
- Fluxo: `open(url)` → `setDisplayRect(0,0,1920,1080)` → `setListener` → `prepareAsync` → `play`. Timeout de preparo 25 s.
- URLs em ordem de tentativa: live Xtream tenta `.m3u8` e depois `.ts`; ao falhar passa à próxima. Live reconecta até 3 vezes (1,5 s × tentativa) antes do erro.
- Erros: `NOT_SUPPORTED_FILE`/`CODEC` → "Formato não suportado"; demais → "Não foi possível reproduzir". Código do HTML5 `4` **não** é tratado como formato (também ocorre em URL inexistente).
- Controles: Live — OK abre painel de canais, ▲/▼ troca de canal, Amarelo/OK longo favorita, CH+/CH−. VOD — OK pausa/retoma, ◀/▶ ±10 s (acumula e aplica após 400 ms), FF/RW ±30 s. Voltar/Exit sai. UI some após 4 s.
- **Não existe MultiView neste app/TV** (§3): a tecla VERDE não tem ação no player. A troca entre os dois últimos canais é a **TROCA RÁPIDA** (tecla AZUL).
- Histórico gravado a cada 15 s e ao sair (VOD só se >10 s). Retomada: `startAt` se pos>10 s e <95 %.
- `visibilitychange` → `suspend()`/`restore()`.
- Resultado medido: stream `.ts` HTTP H.264 960×540 + áudio MPEG tocou; MP4 de 1h43 tocou com seek/pausa; episódio MKV/MP4 tocou.

## 7. Tecla Exit e a tela inicial da Samsung

- O botão **Exit** (código `10182`) **chega ao app** (descoberto por log). Foi registrado com `tizen.tvinputdevice.registerKey('Exit')` e mapeado para a ação `exit`: mostra "Deseja fechar o Space IPTV?" (Ficar/Sair); no player fecha o player. Com "Ficar" a TV **não** abre o Samsung TV Plus.
- O que a TV abre **ao ligar** não é controlável pelo app. Sugestão ao usuário: ajuste da TV "Executar último app automaticamente" (Configurações → Geral → Funções inteligentes; nome varia).

## 8. Coisas que deram errado e a causa (não repetir)

1. `sdb connect` recusado → IP do PC diferente do "Host PC IP" da TV (§2).
2. `tizen install -n "Space IPTV.wgt"` falha por causa do espaço → copiar para `SpaceIPTV.wgt`.
3. `npm` falhou em pasta temporária de caminho muito longo → usar caminho curto.
4. Vídeo preto com áudio → `html` opaco (§6).
5. **Google Drive responde HTTP 500 ao User-Agent da TV Samsung** (`SMART-TV; Tizen`); com UA de Chrome responde 206. O app não pode trocar o UA. **Hospedar listas fora do Drive** (GitHub raw funcionou, inclusive para 88 MB). Provado por `curl -A "<UA da TV>"`.
6. Lista de 88 MB / 317 mil entradas: o parser antigo usava ~272 MB de heap no PC → reescrito em fluxo (§5). Agora ~24 MB residentes no PC.
7. `Page.captureScreenshot` **não funciona** na TV (comando trava). Para ver a tela, só o usuário; o resto se verifica pelo DOM/estado.
8. `performance.memory` retorna 0 na TV: **uso real de memória ainda não foi medido** na TV.
9. `sdb shell 0 debug <appid>` falha (`port ''`) se o app já estiver rodando. Reinstalar (`tizen install`) reinicia o app; depois rodar o `debug`.
10. `sdb shell 0 kill` deu erro na TV; não depender dele.
11. **Popup de formulário (adicionar lista) aparecendo cortado no canto superior esquerdo** — causa: `.overlay{inset:0}`. O Chromium 69 da TV **não tem o atalho `inset`** (existe só a partir do Chromium 87): a camada fica 0x0 e o `.modal` (`left/top:50%` + `translate(-50%,-50%)`) é empurrado para fora da tela, sobrando só o quadrante inferior direito no canto. Corrigido em `css/app.css` trocando `inset:0` por `left/top/right/bottom:0` (7 ocorrências: `.overlay`, `.details`, `.det-bg`, `.det-shade`, `.chan .logo .ph`, `.pl-chan .logo img`, `.loading-box`). **Nunca usar `inset` neste projeto.**
12. Pelo mesmo motivo (motor antigo), **`gap` em flexbox não existe** na TV (só a partir do Chromium 84). Onde o espaçamento é essencial (formulário do modal) há um bloco `@supports not (inset:0)` em `app.css` refazendo os mesmos espaçamentos com margem. Nas outras telas o espaçamento pode sair mais apertado que no PC — se o usuário reclamar, repetir a técnica.
    *Confirmado na TV (DevTools):* `CSS.supports('inset','0') = false`, `CSS.supports('backdrop-filter',...) = false`, Chromium `69.0.3497.128`.
13. **A TV recusa atualizar o app com outro certificado de autor**: `install failed[118, -11], reason: Author certificate not match`. A chave antiga do PC anterior (`CN=AltLauncher Dev`, thumb `83DD...EABF`) se perdeu, então foi preciso desinstalar e instalar de novo (04/11/2026). **Resolvido**: existe agora o perfil `AltLauncherProfile` (§2) com o p12 **backupeado** em `_iptv-backup\tizen-cert\`, e o update por cima já foi testado e funciona.
    - **Regra:** sempre empacote com `-s AltLauncherProfile` (use `tools\package.ps1`). Se o app for reinstalado com outro certificado, os updates seguintes exigirão aquele outro.
    - Se um dia o p12 se perder: só resta desinstalar (`tizen uninstall -p SpcIptv001.SpaceIPTV -s <target>` — **`sdb uninstall` não funciona nesta TV**), instalar e restaurar o `localStorage`.
    - Backup do `localStorage` do app na TV (chaves `sl.lists`, `sl.active`, `sl.favs`, `sl.hist`, `sl.k`) em `D:\Documentos\projects\_iptv-backup\localstorage-SpcIptv001-2026-11-04.json`. **Contém a chave AES das credenciais: não versionar nem compartilhar.** Restauração: `sdb shell 0 debug SpcIptv001.SpaceIPTV` → `sdb forward tcp:9336 tcp:<porta>` → gravar cada chave com `localStorage.setItem` via DevTools e recarregar.
    - O cache do catálogo (`cat.*`/`eps.*` no IndexedDB) não vale a pena copiar: o app baixa de novo (~85 s na primeira carga).
    - Detalhe do CLI: a senha do distribuidor público do SDK (`tizen-distributor-signer.p12`) é `tizenpkcs12passfordsigner` (está em `org.tizen.common.sign` → `SigningPathUtil.getDeveloperKeyPassword()`); a do autor padrão (`tempMobile.p12`) é `tempMobile`.
14. `sdb shell` nesta TV **não devolve saída** para comandos comuns (`ls`, `id`, `pwd`) — só os comandos nativos dela (`vd_applist`, `debug`) respondem. `sdb pull` só funciona em caminhos liberados (recusa `/opt/usr/...`). Para inspecionar o app, use o DevTools (`tools/tv.js`), que funciona normalmente.

## 9. Comandos úteis (PowerShell, Windows)

Variáveis (esta máquina): `$sdb='D:\tizen-studio\tools\sdb.exe'; $d='192.168.0.13:26101'; $tz='D:\tizen-studio\tools\ide\bin\tizen.bat'`

```powershell
& $sdb connect <IP-DA-TV>                 # deve dizer "connected"
& $sdb devices

# caminho curto: o script faz tudo (perfil AltLauncherProfile, nome sem espaço)
pwsh tools\package.ps1              # so empacota -> dist\SpaceIPTV.wgt
pwsh tools\package.ps1 -Install     # empacota e instala (atualiza por cima)
pwsh tools\package.ps1 -Install -Run

# equivalente manual (rode da raiz do projeto)
& $tz package -t wgt -s AltLauncherProfile -o .\dist -- .\app
Copy-Item '.\dist\Space IPTV.wgt' .\dist\SpaceIPTV.wgt -Force   # nome sem espaço
& $tz install -n SpaceIPTV.wgt -s $d -- .\dist
& $tz run -p SpcIptv001.SpaceIPTV -s $d

# desinstalar (so em ultimo caso: apaga listas/favoritos/historico)
& $tz uninstall -p SpcIptv001.SpaceIPTV -s $d

# abrir em modo depuração e obter a porta
& $sdb -s $d shell 0 debug SpcIptv001.SpaceIPTV     # "... port: NNNNN"
& $sdb -s $d forward tcp:9333 tcp:NNNNN
```
Observação: `tizen.bat` é lento e pode "pendurar"; rode com `Start-Process ... -PassThru` e timeout.
`sdb shell 0 debug` **trava** se o app já estiver rodando — instale (o install reinicia o app) e chame o `debug` em seguida.

### Controle remoto de desenvolvimento (`tools/tv.js`)
Precisa de `npm i ws@7` em `tools/` e do túnel `9333` acima.
```
node tv.js eval "<js>"          # executa JS na página da TV (ex.: App.shell.goto('live'))
node tv.js key 39,13 600        # envia keyCodes (direita, OK) com pausa em ms
node tv.js logs 10              # console da TV por 10 s
```
Exemplos úteis: `App.shell.goto('movies')`, `App.catalog.data.movie.length`, `webapis.avplay.getState()/getCurrentTime()/getCurrentStreamInfo()`.
Códigos: ←37 ↑38 →39 ↓40, OK 13, Voltar 10009, Exit 10182, Play 415, Pause 19, Play/Pause 10252, FF 417, RW 412, CH+ 427, CH− 428, Info 457, vermelho 403, verde 404, amarelo 405, azul 406.

### Testes no PC
```
node tools\test-m3u.js                 # parser (aspas, EXTGRP, BOM, CRLF, séries, inválida, 100 mil itens)
node tools\mock-server.js              # http://localhost:8080 — app + Xtream falso (test/test); abrir no navegador em 1920x1080
node --expose-gc tools\probe-stream.js <arquivo.m3u>   # memória do parser em fluxo
```

## 10. Estado atual na TV do usuário

- **04/11/2026:** a tentativa de **MultiView** foi descartada e **removida do app** porque esta TV (Tizen 5.5) tem um só decodificador e não suporta `IN_APP_MULTIVIEW` (§3). O pacote sem `multiview.js` foi empacotado, instalado por cima e aberto na TV; a tecla VERDE ficou sem ação e a TROCA RÁPIDA (AZUL) segue disponível.

- **Reinstalado em 04/11/2026 ~01:07** a partir de `dist\SpaceIPTV.wgt`, agora assinado com o perfil **`AltLauncherProfile`** (`CN=Alt Launcher Dev`). Antes disso houve uma reinstalação intermediária (~00:50) com o perfil padrão do CLI, só para validar a correção; depois foi refeito com o perfil definitivo, porque a TV exige o mesmo certificado para os próximos updates (§8 item 13).
- **Update por cima testado** logo em seguida (~01:09): `tools\package.ps1 -Install` instalou sem desinstalar e **os dados permaneceram** (2 listas, 2 favoritos, 9 itens de histórico, 520 canais da lista ativa).
- Dados preservados nos dois ciclos: o `localStorage` do app antigo foi exportado pelo DevTools antes de desinstalar e regravado depois (restauração conferida chave por chave). O cache do catálogo foi perdido e é baixado de novo sozinho.
- Backup do `localStorage` antigo: `D:\Documentos\projects\_iptv-backup\localstorage-SpcIptv001-2026-11-04.json` (contém a chave AES — não versionar). Backup do certificado: `_iptv-backup\tizen-cert\`.
- App de teste usado para validar a correção (`SpcIptv002.SpaceIPTVTest`) foi instalado e **removido**.
- Três listas M3U (URLs de listas públicas de GitHub fornecidas pelo usuário; não estão neste repositório):
  - **"Lista Brasil"** (ativa no momento): 520 canais ao vivo, 24 categorias (links `.ts` via HTTP).
  - **"Filmes e Séries"**: 30.203 filmes (25 cat., todos `.mp4`) e 8.426 séries (25 cat.), ~88 MB, posters TMDB (https).
  - **"iPTV Free List XXX"** (adicionada em 04/11/2026, **não ativa**; conteúdo adulto): `dzh0ni/iPTV-FREE-LIST` no GitHub raw, 8 KB — 37 canais ao vivo + 1 filme, 2 categorias, streams `http://live.redtraffic.xyz`. Download e parse conferidos **na TV**.
- Medidas na TV (88 MB): carga ~82–85 s (só na 1ª vez), abrir série ~123 ms, pesquisa ~123 ms, início a frio: tela em ~1,1 s, catálogo completo em ~4–6 s.
- Confirmado pelo usuário: **vídeo e áudio dos canais aparecem**.
- Para alternar: Configurações → lista → "Usar esta lista" (uma ativa por vez).

## 11. O que NÃO foi testado (fazer em seguida)

- **Streams HLS `.m3u8`** reais (as listas de teste só têm `.ts` e `.mp4`).
- **Xtream Codes real** (só testado contra `mock-server.js`): autenticação, categorias, `get_series_info`, URLs `/live`, `/movie`, `/series`.
- **Imagem** de filmes/séries na tela pelo usuário (o estado do AVPlay estava correto) e aparência dos **pôsteres TMDB** nas grades.
- **Teclado virtual da Samsung** na pesquisa e nos formulários (testado só com teclado do PC).
- Teclas físicas **CH+/CH−, Play/Pause, FF/RW, amarelo/OK longo** no controle real.
- **Uso de memória real na TV** e estabilidade em sessões longas (trocar muitos canais, abrir/fechar muitas séries).
- Recuperação de erro de rede durante a reprodução ao vivo (queda de Wi-Fi), `online/offline`.
- Edição de lista pela UI na TV (o cadastro foi feito por código na maioria dos testes; a UI de formulário foi testada no navegador do PC).
- Filmes em outros formatos (mkv/avi) e codecs H.265/AC3 em VOD.
- **Controle parental:** as teclas numéricas no **controle físico** chegam como `keyCode` 48–57 (confirmado no atalho 1..9), então o teclado da senha também pode ser usado com elas — mas o fluxo de PIN **apertando o controle** ainda não foi testado de ponta a ponta (os testes usaram `App.nav.dispatch`).
- **Atalho 1..9 dos favoritos:** confirmado no controle físico (teclas 1 e 2 → `keyCode` 49/50 e troca de canal). Falta ver em **outros modelos** de TV, onde o fabricante pode entregar `keypress` em vez de `keydown` ou bloquear as numéricas.

## 12. Ideias e melhorias combinadas ou naturais

1. **Juntar listas numa visão única** (hoje só uma ativa por vez); o usuário tem uma lista de canais e outra de filmes/séries. Proposta: "lista composta" ou abas por lista.
2. Próximo episódio automático ao terminar; marcar episódios assistidos.
3. Subtítulo do player de série mostra "T1 • E1 — Channel Zero S01E01" (título redundante quando o episódio não tem título próprio) — limpar.
4. EPG (guia de programação) — hoje inexistente; `tvg-id` já é guardado nos canais M3U (`tvg`) e `epg_channel_id` no Xtream.
5. Mostrar progresso de carga com MB/estimativa na tela (hoje só `%` no HUD).
6. Limite de 200 resultados por tipo na pesquisa; paginar se necessário.
7. Controle parental, ordenação por "adicionados recentemente" nas grades, favoritos por categoria.
8. Fallback de imagem de pôster mais bonito; cache de imagens (hoje só o cache do navegador).
9. Distribuição oficial: certificado Samsung + verificação de conformidade da loja (não é necessário para uso pessoal em Modo Desenvolvedor).

## 13. Regras do projeto (vieram do pedido original do usuário)

- Fiel ao Space Launcher Design System; sem identidade visual nova, sem paleta nova.
- Desempenho e estabilidade acima de efeito visual; sem dependências pesadas.
- Tudo navegável pelo controle remoto; foco sempre visível.
- Não inventar dados nem resultados de teste. Se algo não foi testado, dizer.
- Não incluir listas, canais ou credenciais no código; não logar credenciais.
- Validar na TV real, não só no navegador do PC.
- Explicar ao usuário em português claro e direto; separar o que foi **verificado** do que é suposição.

## 14. Primeiros passos em um novo computador

1. Instalar Tizen Studio (CLI `tizen`, `sdb`) e Node (qualquer versão ≥ 14) .
2. Na TV, cadastrar o IP do novo PC em "Host PC IP" e reiniciar a TV (§2).
3. Criar/ter um perfil de certificado no Tizen Studio (ou gerar o perfil Samsung) e usar o nome dele no `-s`.
4. `sdb connect <IP-DA-TV>` → empacotar → instalar → abrir (§9).
5. `cd tools; npm i ws@7` e abrir em depuração para usar `tv.js`.
6. Rodar `node tools\test-m3u.js` para garantir que o parser está íntegro antes de qualquer mudança.

## 15. Vers�o Android (celular e projetor)

- Projeto novo em `celular/` (Java 17 + AGP 9.5 + Media3/ExoPlayer), APK em `dist/celular/`.
- **A camada de neg�cio � a mesma**: o build copia `tv/js` para os assets (tarefa `syncTizenSources`).
  Corrigiu um bug de parser, cat�logo, favoritos, parental, retomada ou sa�de? Corrija em `tv/js` e
  as duas plataformas ficam certas.
- Interface Android � pr�pria (`celular/app/src/main/assets/mobile`): abas inferiores e toque no
  celular; **trilha lateral + controle remoto** no projetor (classe `html.tv`, ver `projetor/README.md`).
- V�deo: ExoPlayer numa **TextureView** atr�s da WebView, com p�gina transparente � mesmo modelo
  do AVPlay. TextureView (e n�o SurfaceView) � o que garante a p�gina por cima do v�deo; a janela
  continua **opaca** de prop�sito (`setWebTransparent` s� limpa o fundo do WebView).
- Segredos: chave AES no AndroidKeyStore (`SecretsStore`); se o aparelho recusar criar chave
  (Keystore quebrado, caso do HY300) cai para chave local `l1:`, e s� em �ltimo caso `p0:`.
- Testes: `node tools\mock-streams.js` (streams ffmpeg) + `node tools\e2e.js` (114 verifica��es via CDP,
  rodando no Galaxy J4 Core e no projetor HY300) + `node tools\test-compat.js` (WebView antiga).
  Detalhes de arquitetura, resultados e limita��es em `ANDROID.md`.
- **Projetor HY300**: `projetor/README.md` � o que muda, teclas do controle, "Colar" da �rea de transfer�ncia,
  limites da WebView Chrome 71 e como tirar foto da tela quando o `screencap` devolve arquivo vazio.
- Sa�de dos canais (indicador colorido, sondagem, estados): `SAUDE-CANAIS.md`.
- Assinatura: `D:\Documentos\projects\_iptv-backup\android-keystore\spaceiptv-release.jks`
  (senha no `LEIA-ME.txt` da mesma pasta). Sem ela n�o h� atualiza��o do app instalado.

### 15.1 Scripts de teste por aparelho

Com o celular no USB e o projetor na rede, os dois aparecem no `adb`. Escolha o alvo por
`ADB_SERIAL` (sen�o o `adb` recusa com "more than one device"):

```powershell
$env:ADB_SERIAL = "82a9a8e1"          # Galaxy J4 Core (USB)
$env:ADB_SERIAL = "192.168.0.6:5555"  # projetor HY300 (rede)
.\tools\cdp.ps1                       # abre o t�nel do DevTools no aparelho escolhido

# celular no USB precisa de adb reverse para alcan�ar o servidor de testes
adb -s 82a9a8e1 reverse tcp:8090 tcp:8090
$env:MOCK = "127.0.0.1:8090"          # projetor: "192.168.0.5:8090" (IP da m�quina)
node tools\e2e.js
```

**Sem aparelho nenhum** (quando projetor/celular est�o em uso por outra sess�o):

```powershell
node tools\mock-streams.js            # tamb�m serve /navegacao.m3u (12 categorias, 60 filmes)
.\tools\harness.ps1                   # abre a interface no Edge, 1024x600, como o HY300
$env:CDP_PORT = "9333"; node tools\cdp.js "App.m.tv"
```

O harness usa um `SpaceNative` falso (low-ram, sem toque) para o app entrar no modo
projetor. Serve para layout e setas; **n�o** toca v�deo nem l� a �rea de transfer�ncia
de verdade.

### 15.2 Cuidados que j� custaram tempo

- **Nunca editar `.md` com `Get-Content -Raw` + `Set-Content`**: os acentos viram
  mojibake (Windows-1252 ? UTF-8). Use a ferramenta de edi��o de texto.
- `adb` com dois aparelhos ligados exige `-s`/`ADB_SERIAL` em **todo** comando.
- No HY300 o `screencap` devolve arquivo vazio: use `screenrecord` + `ffmpeg`.

---

## 16. Versão web (navegador) — desde 13/11/2026

### 16.1 O que foi entregue

- `web/` novo: `index.html`, `css/web.css`, `js/{keys,pointers,net,player,shell}.js`,
  `vendor/{hls.min.js v1.5.18, mpegts.min.js v1.8.0}`, `server.js`, `build.js`, `README.md`
  e `NOTES.md` (reconhecimento técnico).
- A web **carrega** `tv/js` (parser, Xtream, catálogo, listas, favoritos, histórico, parental,
  retomada, saúde, TMDb, telas e componentes) e substitui apenas `tv/js/navigation/keys.js`
  (teclado), `tv/js/player/player.js` (AVPlay → HTML5/HLS/TS) e `tv/js/main.js` (shell).
- A única alteração em `tv/js` foi a linha aditiva `_press` no `pinPad`
  (`tv/js/components/ui.js`), já registrada em `web/NOTES.md §10`, feita na integração desta
  versão; a TV não tem mouse, então o comportamento dela não muda.
- Servidor local `node web/server.js` (8095, `PORT`/`--port`, bind `127.0.0.1`, `--proxy`
  opt-in) e build estático `node web/build.js` → `dist/web/`.
- Documentação: `web/README.md` (rodar, publicar, limitações, decisões e testes), `README.md`
  raiz e esta seção.
- O app da TV e o APK Android **não** foram alterados nem reempacotados nesta entrega.

### 16.2 Como rodar

```powershell
node web/server.js                  # http://127.0.0.1:8095/ (padrão)
node web/server.js --port 8097      # outra porta (env PORT também vale)
node web/server.js --proxy          # proxy local opt-in, na mesma origem
node tools/mock-server.js           # 8080 — Xtream test/test e /list.m3u
$env:HOST_IP='127.0.0.1'; node tools/mock-streams.js   # 8090 — HLS/TS/MP4/404/403
```

O servidor serve `/` → `web/index.html`, `/web/...` e `/tv/...`, sem listagem e com
`Cache-Control: no-store`; mapeia `/web/index.html` para `/`. O bind padrão é `127.0.0.1`.
`--host 0.0.0.0` expõe o servidor **e** o proxy à rede; o proxy **não tem autenticação**.
Em build estático o proxy não existe.

### 16.3 Build estático

```powershell
node web/build.js                   # dist/web (padrão)
node web/build.js --out dist/web2   # ou BUILD_OUT=dist/web2
```

- Copia `web/index.html`, `web/{js,css,vendor}` e `tv/{js,css,fonts,icon.png}`. **Não** copia
  `server.js`, `build.js`, README/docs, `dist/`, `state/` nem capturas. Sem bundler ou
  minificação.
- Estrutura relativa preservada: o mesmo build funciona em `http://host/` e em
  `http://host/repo/` (GitHub Pages), sem rewrite de SPA.
- Valida as fontes e as referências relativas do HTML/CSS e falha **antes** de limpar o
  destino; recusa destino dentro de `web/`, `tv/`, `tools/`, `celular/` e `projetor/`.
  É idempotente. Medido: **42 arquivos, ~1,3 MB**.
- Para publicar, copie **o conteúdo** de `dist/web/` para a raiz da hospedagem.

### 16.4 Testes feitos (evidência)

- `node web/build.js`: 42 arquivos, árvore conferida, nenhum `server.js`/`build.js`/`.md`/
  `state` no destino, segunda execução idempotente.
- `--out`/`BUILD_OUT` e destinos inválidos: exit 2 com mensagem; falha de fonte essencial
  simulada em pasta temporária: exit 1 listando o que falta, sem tocar no destino.
- Build servido por servidor estático temporário **sem proxy**, porta **8123** (diferente de
  8095/8096/8080/8090), com montagem na raiz **e** em `/repo/`: **84/84 requisições HTTP 200**
  (42 arquivos × 2 montagens).
- **Edge headless `Edg/157.0.4341.57`**, 1920×1080: as duas URLs montaram o app (canvas,
  7 itens de menu, HUD, toast “Adicione uma lista para começar”); **0 exceções de JavaScript**,
  **0 `requestfailed`**; o único 404 foi `/__proxy/ping`, esperado em host estático (o
  `server.js` local responde 200 `{ok:false}` nessa rota). Navegação por teclado exercitada:
  Esc → menu, seta move o foco, Enter entra na tela, Esc volta ao menu.
- `node tools/test-m3u.js`: passou (100 mil itens em 1945 ms).
- `node tools/test-resume.js`: **27/27**. `node tools/test-health.js`: **57/57**.
- Nenhum processo de teste ficou rodando (servidor temporário e Edge encerrados).

### 16.5 Limitações e o que não foi testado

- **Não testado** nesta entrega: Safari, reprodução real de HLS/TS/MP4 no Safari
  (a validação de reprodução é da integração/QA), celular/tablet, modo privado do navegador e
  listas reais do usuário.
- CORS: M3U, Xtream, `probe` e HLS/TS via XHR exigem CORS; `<video>` MP4 direto não; HLS nativo
  do Safari não. Mixed content: página `https` bloqueia fonte `http` por script.
- WebCrypto só em contexto seguro (`localhost`/`127.0.0.1`/`https`); em `http://192.168.x.x` o
  `store.js` cai no formato `p0:` (Base64) — **não é criptografia**.
- MKV/AVI e codecs H.265/AC3 dependem do navegador; não há transcodificação. Sem PWA, EPG,
  DRM, gravação ou layout mobile dedicado.
- A saúde dos canais fica cinza quando o provedor bloqueia o `probe` (CORS): limitação do alvo,
  não bug do app.
- O build copia `tv/js` inteiro, inclusive `main.js`, `navigation/keys.js` e
  `player/player.js` da TV, que a web **não** carrega; é cópia barata e mantém a fonte única.
- Em build estático não há proxy; o badge “proxy local” não aparece.

### 16.6 Pendências

- Fase de QA (F5): matriz de navegadores, capturas oficiais em `dist/web-shots/`, auditoria
  `ui-ux-pro-max` em `web/UI-UX-AUDIT.md` e validação de reprodução dos três formatos no
  navegador.
- O `README.md` raiz e o `web/README.md` já documentam as limitações; qualquer mudança em
  `web/server.js`/`web/js/net.js` deve atualizar a seção de proxy do `web/README.md`.
## 17. Login e administrador na versão web (desde 14/11/2026)

Esta seção complementa a 16: a web deixou de ser um site estático. Agora existe
autenticação no edge, administração de contas e sincronização por usuário.

### 17.1 Arquitetura (o mínimo para não se perder)

> **Atualização (14/11/2026):** a plataforma passou de Supabase para **Neon**.
> Não há serviço de auth de terceiros: `app_users` + `app_sessions` no Postgres,
> senha em bcrypt (`pgcrypto`), token de acesso HMAC assinado no edge.

```
navegador ──cookie HttpOnly──► Cloudflare Pages
                                  functions/_middleware.js
                                    ├─ token HMAC válido? (AUTH_SECRET, sem banco)
                                    ├─ expirou? tenta refresh 1x (app_sessions) e regrava cookies
                                    ├─ sem sessão: /  -> 302 /login.html?next=...
                                    │              /api/* -> 401 JSON
                                    └─ com sessão: segue e anexa context.data.auth
                                  functions/api/auth/*   -> SQL no Neon (bcrypt + sessões)
                                  functions/api/sync/*   -> SQL no Neon em 1 transação (RLS)
                                  functions/api/admin/*  -> SQL no Neon (app.role = admin)
```

- `functions/` fica na **raiz** do repositório (o wrangler compila de lá).
- `dist/web` é o build estático (`node web/build.js`); `_headers` e `_routes.json`
  entram nele.
- `db/001_init.sql` + `db/002_last_sign_in.sql` criam tabelas, RLS, papel `space_app`
  e as RPCs; `tools/neon-migrate.js` aplica pelo endpoint `/sql` da Neon.

### 17.2 Como publicar

```powershell
node web/build.js
npx wrangler pages deploy            # da raiz do repositório
```

Cadastre em **Cloudflare Pages → Settings → Variables and Secrets**
(Production **e** Preview): `NEON_APP_URL` (secret, papel `space_app`),
`AUTH_SECRET` (secret, ≥ 32 caracteres) e `AUTH_RECOVERY_ENABLED=false`.
O passo a passo completo está em `SETUP-NEON.md`.

### 17.3 Como rodar local

```powershell
node web/build.js
node tools/pages-runner.js     # http://127.0.0.1:8788 com as Functions reais

node tools/test-auth.js        # 96 casos de aceite contra o banco do .dev.vars
node web/smoke.js              # contrato com login
node web/smoke.js --static     # MIME/traversal/proxy do servidor estático puro
node tools/e2e-login.js        # Edge headless (login, admin e sync)
```

As contas de teste são criadas e apagadas no domínio `@e2e.local`. `node web/server.js`
continua servindo **só assets** e avisa no console que não tem login.

### 17.4 Como recuperar o acesso se o único admin se perder

Detalhado em `SETUP-NEON.md` §7. Resumo (conexão owner em `NEON_DATABASE_URL`):

```powershell
node tools/neon-sql.js "update app_users set role = 'admin', disabled = false where lower(email) = 'voce@exemplo.com'"
node tools/neon-sql.js "update app_users set password_hash = public.hash_password('senha-nova-forte-123') where lower(email) = 'voce@exemplo.com'"
node tools/neon-sql.js "update app_sessions set revoked_at = now() where user_id = (select id from app_users where lower(email) = 'voce@exemplo.com')"
```

### 17.5 O que NÃO foi validado nesta entrega

- **Navegador real com print**: login feliz/triste, admin criando/resetando/
  desativando/excluindo, dois perfis sincronizando e o player sob a CSP. A validação
  automatizada cobre os contratos HTTP (96 casos) + 21 verificações no Edge headless,
  mas não substitui o teste visual do player com listas reais.
- **Deploy de verdade** no Cloudflare Pages (`wrangler pages deploy` precisa da conta
  do Pedro). O banco testado é o de verdade (Neon `space-iptv`), não um mock.
- **SMTP**: não existe. A recuperação de senha é o reset pelo administrador e o link
  "Esqueci minha senha" fica escondido (`/api/auth/capabilities` → `recovery:false`).
