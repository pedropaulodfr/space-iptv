# web/NOTES.md — reconhecimento F0 (agente `recon`)

Escopo: leitura de `tv/**`, `tools/**`, `README.md`, `HANDOFF.md` (§13) e `PROMPT-VERSAO-WEB.md` (§0–15).
`tv/js` é ES5/IIFE pendurado em `window.App`; **ordem de `<script>` importa**. Nada foi alterado.
Referências `arquivo:linha`; o que não foi executado está marcado **não confirmado**.

## 1. Boot real da TV e DOM exigido

- `tv/index.html:7-8` carrega CSS; `:9` `$WEBAPIS` (não usar na web); `:12-31` DOM estático; `:33-57` scripts.
- Ordem real: util, store, http, m3u, xtream, lists, catalog, userdata, parental, resume, health, tmdb,
  **navigation/keys.js (:45)**, vlist, cards, hrow, ui, **player/player.js (:50)**, screens, starfield (:56), main (:57).
  O prompt (§5) põe `web/js/keys.js` depois dos componentes; é seguro porque `App.nav` só é usado em runtime
  (ui.js:13,54; details.js:211; player.js:340). Mas `starfield.js:4` faz `getElementById('stars')` no load ⇒ DOM antes dos scripts.
- `main.js:128-150` (`start`): `App.registerKeys()` (:129; definido em keys.js:61 → a web precisa de um no-op),
  HUD+relógio (:130), `App.nav.push(shellLayer)` (:131), `App.starfield.start()` (:132), `show(0)`+`intoScreen()` (:135),
  sem lista → `goto('settings')`+toast (:136); senão `App.catalog.init(l)` (:137) → `App.resume.startup()` e
  `App.actions.playLive(canal, itens)` (:140-144) → refresh se `needsRefresh()` (:145).
- `App.shell` (main.js:55-67): `area` menu/screen; `toMenu` (:57), `goto(id)` (:58-62), `intoScreen` exige `cur.enter()` truthy (:64).
  `shellLayer` (main.js:69-89) trata n1–n9 com `App.actions.playFavNumber` (:74-77), saída por menu (:80-86) e `exit` por modal (:71).
- IDs exigidos: `#stars`, `#planet`, `#shell`, `#hud` (`.hud-brand/.hud-logo/.display`, `#hud-list`, `#hud-status`, `#hud-clock`),
  `#sidebar`, `#screen`, `#hints`, `#overlays`, `#toast`; `#player` nasce em runtime (player.js:12-33).
  `#toast` é obrigatório: `App.toast` (util.js:75-80) lança se não existir.
- `web/index.html` mínimo: `#stage` → `#stars`, `#planet`, `#shell` (header/nav/main/footer), `#overlays`, `#toast`.
  Sem `<object id="av-object">` e sem `$WEBAPIS`. Carregar `tv/css` (index.html:7-8), os módulos da ordem acima **exceto**
  `navigation/keys.js`, `player/player.js`, `main.js`; por fim `web/js/*` (prompt §5). O player web deve anexar `#player` ao
  `#stage` (a TV usa `document.body` — player.js:31).
- `html.playing`/`body.playing`: player.js:339/357; escondem shell/overlays/estrelas (app.css:7,10; design-system.css:23).
  Manter as classes no player web.

## 2. Contratos reais (prevalece o código)

| API | Contrato observado | Ref |
|---|---|---|
| `App.screens` | fábricas `home(shell)`, `browse(type)`, `results(mode)`, `settings()`; objeto `{hints, mount(root), unmount(), enter()->bool, key(action)->bool}`; `App.screens.setCat(type,id)` | home.js:7,76-99; browse.js:14,114-161,163; results.js:8,45-89; settings.js:110,171-257 |
| `App.shell` | `inScreen()`, `toMenu()`, `goto('home'|'live'|'movies'|'series'|'search'|'favs'|'settings')`, `intoScreen()` | main.js:55-67 |
| `App.actions` | `toggleFav`, `open(it,ctx)`, `playFavNumber(n)->bool`, `playLive(it,items,onClose)`, `playMovie(it,onClose)`, `playEpisode(it,ep,sn,onClose)`, `resume(h)`, `details(it,resumeEp)`; definido em details.js e **não recriar** | details.js:9-231 |
| `App.ui` | `open(el,layer)->close`, `confirm(o)->bool`, `alert(title,msg)`, `form(o)->bool`, `loading(text)`, `btn`, `group(nodes,h)` (só `_act`), `pinAsk(o)->bool`, `pinNew(o)->str|null`, `menu(o)->índice|null` | ui.js:10,24,44,59,70,119,127,193,200,214 |
| `App.VList` | `new VList({root,cols,rowH,empty,render,onSelect,onFocus,onHold})`; `setItems(items,keep)`, `setIdx`, `focus`, `blur`, `key`, `scrollTo`, `render`, `refreshItem/refreshAll`, `current`, `destroy`; DOM `.vlist>.vl-inner` + `.vl-empty`; foco = classe `.focused` no `cell.firstChild` | vlist.js:7-14,17,40,79,88,97,112 |
| `App.HRow` | `new HRow({title,items,cardW,cardH,render,onSelect,onHold})`; `focus(i)`, `blur`, `setIdx(i,true)`, `key`, `refresh`; DOM `section.hrow>h2+.hr-view>.hr-track>.hr-card`; `viewW` fixo 1560 | hrow.js:6-19,27-54 |
| `App.cards` | `poster(it,{lazy,tag,sub,progress})`, `channel(it,{sub})`, `any(it,o)`, `loadImgs(root)` | cards.js:31,34,62,87 |
| `App.lists` | `all/get/active/activeId/setActive/save(f,id)/patch/remove/creds(l)/hostOf(l)`; edição com URL/senha vazia mantém a anterior; `hostOf` só lê `l.server` (M3U não tem host) | lists.js:9-65 (save:20-40; hostOf:61-64) |
| `App.catalog` | `data` (live/movie/series, cats, by, map), `listId`, `updated`, `init(l)->bool(cache)`, `refresh(l)`, `needsRefresh`, `hasData`, `isLoading`, `items(t,cat)`, `find`, `search(q,types,limit=200)`, `seriesInfo`, `vodInfo`, `urls(it,list,ep)`, `dropCache` | catalog.js:58-168 |
| `App.favs` | `has/toggle(it)->bool` (emite `favs`), `list(type)`, `liveList`, `nums`, `num`, `byNumber(n)`; chaves `listId|t|id` | userdata.js:11-52 |
| `App.hist` | `record(it,ep,pos,dur)`, `get(it)`, `remove`, `continueList` (>10 s e ≤95%), `lastLive`, máx. 60 | userdata.js:58-88 |
| `App.parental` | `hasPin/enabled/locked/unlocked`, `isAdult(it)`, `filter/filterHist/filterCats`, `setPin/check/enable/clear`, `unlock/lock`, `guard(it)->bool` (usa `ui.pinAsk`), `LEN=4` | parental.js:48-122 |
| `App.resume` | `set(it)` só live, `get`, `clear`, `enabled` (default false), `setEnabled`, `candidate`, `decide()->{ok,reason}`, `startup()` uma vez/sessão | resume.js:14-66 |
| `App.health` | `enabled/setEnabled`, `observe(list,items)`, `cancel/pause/resume`, `playback(it,ok,slow)`, `state/paint/paintKey`, `detail/legend`, `stats/idle/reset/configure`, `cfg`, `keyOf` | health.js:390-395 |
| `App.tmdb` | `lookup(it)` (nunca rejeita; null), `preload(items,limite)`, `setKey/setToken`, `clearCache`; cache `sl.tmdb.*` 30 d | tmdb.js:197-246 |
| `App.http` | `get(url,{json,timeout=30000,headers})` XHR → `{code,status}`; `stream(url,{onChunk,onProgress,idle=60000})` fetch→XHR binário; `probe(url,{timeout=8000,maxBytes,range})` → promessa com `.abort` | http.js:64-86,10-62,91-195 |
| `App.store/idb/secrets` | `sl.*`; IDB `spaceiptv` store `kv` (`cat.*`,`eps.*`) com fallback memória; `seal`→`v1:` AES-GCM ou `p0:` base64; `open` | store.js:6-14,43-47,66-89 |
| `App.bus` | `on/off/emit`; eventos reais: `catalog`, `catalog:loading`, `catalog:done`, `catalog:error`, `favs`, `parental`, `resume`, `health`, `health:config` | util.js:65-71; catalog.js:90,105,113; userdata.js:19; parental.js:46; resume.js:21; health.js:121,293 |
| `App.friendly` | traduz `offline/timeout/auth/invalid/http/network/parse`; não trata `opaque`/`abort` | util.js:83-93 |

**Divergências prompt × código:** (a) `App.catalog` também expõe `isLoading/hasData/dropCache/data` (usados por shell/telas);
(b) eventos `health`/`health:config` existem e não estão na §6.4; (c) `App.http` emite `opaque`/`abort` (probe) além da lista da §6.4,
e `auth` nasce no `xtream.js:23-31`, não no http; (d) `App.parental.unlocked()` não está no prompt; `enabled()` exige PIN (:53);
(e) `App.lists.hostOf` não serve M3U; (f) `VList` expõe `current/refreshItem/refreshAll`; `HRow` `setIdx` é `(i,force)`;
(g) `App.actions.playFavNumber` retorna bool; (h) `App.screens.setCat` é global (browse.js:163) e a Home chama `shell.goto` (home.js:60).

## 3. Player real (`tv/js/player/player.js`)

- Contrato público: `App.player.play(o)`, `close(silent)`, `isOpen()` (:363). `o` = `{item,list,ep,urls,live,startAt,chans:{items,index},title(item),sub(item),onClose}` (:312-320).
- `play()`: se já aberto chama `close(true)` (:315, não dispara `onClose`); `resume.set(item)` só live (:321); cria o `VList` do painel (rowH 72, render `.pl-chan`, logo, `.favnum sm`) (:323-336); adiciona `html/body.playing` (:339); `App.nav.push(layer)` (:340); `App.health.pause()` (:342); `setHeader/showUI/saveHist`; timer de histórico 15 s (:344); `startEngine()` (:345).
- DOM/classes: `#player` + `#player.open`; `.pl-top` (dica “◀ VOLTAR / OK: controles”, `.badge`, `.pl-title`, `.pl-sub`), `.pl-spin>.spinner`, `.pl-msg.glass-panel` (h2/.msg/.hud-caption), `.pl-bottom>.pl-prog>i + .pl-time + .pl-keys`, `.pl-panel.glass-panel` com VList; `#player.ui/.busy/.err/.panel` (build:12-33; app.css:153-181).
- Timers/estado: `UI_MS=4000`, `SAVE_MS=15000`, `PREP_MS=25000` (:8); `showUI` esconde UI após 4 s se não pausado/painel (:38-42); `busy` = `.busy` (:36-37); spinner visível por CSS (:167).
- Engines: AVPlay se `webapis.avplay` (:70-95, irrelevante na web); senão `<video>` com `autoplay` e `v.play()` (:96-111). Web troca só essa parte (hls.js/mpegts.js), mantendo o contrato.
- `onFail` (:122-141): tenta próxima URL (:127); live reconecta até 3× com `1500*retries` (:128-133); mensagens “Formato não suportado”/“Não foi possível reproduzir” (:136-138); `notePlayback(false)` (:139).
- `onEnded` (:143-147): live reinicia a partir da URL 0; VOD salva histórico e `close()`.
- Pause/seek: `pauseToggle` bloqueia pause em live quando engine não é AVPlay (:151) — **na web, live não pausa**; seek ±10 s com debounce 400 ms e clamp em `dur-1500` (:162-176); FF/RW ±30 s.
- Zap/troca: `zap(delta)` circular na categoria (:178-182); `zapTo(i)` bloqueia adulto só com toast “Conteúdo adulto bloqueado” (sem PIN) (:186; idem 208,224), guarda `prevItem` (:187), atualiza `resume.set` (:190) e refaz `catalog.urls` (:192); `jumpFav(n)` (1–9) troca `chans` para a categoria do favorito (:204-216); `swapPrev` (AZUL) alterna com o anterior (:219-231).
- Painel: `togglePanel` (:233-238) só com `chans`; abre com setItems/setIdx/scrollTo/render/focus.
- Header/hints (:240-246): live `['OK: lista de canais','▲▼: trocar canal','AMARELO / segurar OK: favoritar','AZUL: troca rápida']`; VOD `['◀▶: -10s / +10s','OK: pausar','FF/RW: ±30s']`.
- Saúde: `notePlayback` uma vez por canal, usa `App.health.cfg.playbackSlow` (:249-260); `health.pause()` no play, `resume()` no close (:342,358).
- Histórico: live grava `record(item,null,0,0)` ao trocar/fechar (:262-268); VOD não grava pos <10 s nem `done` sem duração; fecha em `close` (:348-361) salvando.
- Teclado (`onKey`, :270-303): n1–n9 antes de tudo (:272-276); erro + `ok/play` retenta (:277); painel (:278-283); `back/stop/exit` fecham (:285); `ok` live abre painel, VOD pausa (:286); `left/right` seek no VOD e no live `right` **abre o painel** (:290-291); `up/chdown` e `down/chup` zap quando live (:294-296); `blue` troca rápida (:295); `yellow/hold` favorita só live (:298-300).
- Fechamento: limpa timers, para engine, remove classes, `health.resume()`, `nav.pop`, chama `onClose` só se `!silent` (:348-361).
- **O player web precisa replicar**: DOM/classes acima, ordem de tentativas de URL, reconexão 3× (live), favoritar 1–9/AZUL, painel com VList, histórico/retomada (`startAt` >5 s), saúde, parental por bloqueio, mensagens; acrescentar: mudo/fullscreen/PiP, `object-fit:contain`, sem `crossorigin`, autoplay com fallback “Enter para iniciar”, anexar ao `#stage` e limpar `src/hls/mpegts` no close.

## 4. Teclado (`keys.js`) e ponteiro

- `App.nav` (keys.js:18-23): pilha; `dispatch` entrega só ao topo (:16). Mapa TV (:5-11): setas, 10009/27/8→back, 10182→exit, mídia, 427/428, 457/73, 403/404/405/406, `Y`=yellow; números 48-57/96-105→`n0..n9` (:43-47).
- Enter: `keydown` dispara `ok` no `keyup`; hold de 650 ms emite `hold` (:12,35-40,53-58); capture `true` (:51,58).
- `editing()` só testa `INPUT` (:25); dentro de input: Enter/Esc/Back/10009/65376/65385 fazem blur (:31), ↑/↓ fazem blur+dispatch (:32).
- A web **substitui** este arquivo por `web/js/keys.js`: mesmo `App.nav`, teclas F/X/I/Espaço, ignorar Ctrl/Meta/Alt e `e.repeat` (exceto navegação), exceções de input do §7.3, `fullscreenchange` antes de `back`.
- Ponte de mouse: o app navega por **índice**, não por hit-test. VList: `row.style.top/height`, `row.style.gridTemplateColumns` (cols), índice da `.vl-cell` (makeRow:40-53); HRow: índice de `.hr-card` (hrow.js:13-15), `setIdx(i,true)` e `focus(i)` se sem foco (`has`: hrow.js:7,27-33); menu lateral: shell controla `menuIdx`/`area`.
- Instâncias não são expostas por `tv/js`. Recomendação **aditiva na web** (sem editar `tv/js`): em `web/js/pointers.js`, embrulhar `App.VList`/`App.HRow` logo após o load para registrar `root.__vl`/`el.__hrow`, e usar esses ganchos na delegação.
- `ui.js`: botões e grupos usam `_act` (ui.js:21,37); modais são `.overlay` dentro de `#overlays` (root:5; open:10-19); `confirm` (44), `form` (save/cancel `_act`:103; foco do input:111), `menu` (222), `alert` **sem `_act`** no OK (63-66 — clique deve `App.nav.dispatch('ok')`).
- **PIN**: `pinPad` cria teclas em ui.js:140-147 sem gancho; `press` é declaração de função içada (:169). Linha aditiva segura: em 144, `b._press = function () { press(v); };` (v em escopo do forEach; compatível com a TV). Sem isso, clicar em dígito erraria a tecla focada. Teclas do PIN também têm `.focused` e navegação por `idx` (:175-187).
- Camadas: modais/painel/details/player empilham em `App.nav`; a ponte deve agir só em `#overlays` quando houver filhos e só em `#player` quando `.open` (MutationObserver).
- Roda/toque: throttle ~90 ms; toque = foco e depois ativação; hold 650 ms; cursor esconde após ~2,5 s; clique em `.field` foca o `input`; `_act` > dispatch `ok` > ação da VList.

## 5. Rede, CORS e mocks

- Erros do `App.http`: `get` rejeita `{code:'offline'|'timeout'|'http'|'network'|'parse', status}` (http.js:67-84); `stream` idem (:15) e cai para XHR se fetch/stream não existir (:42); `probe` resolve (nunca rejeita) `{ok,status,code,ttfb,ms,bytes,kind,contentType,text,inconclusive}` e expõe `.abort` (:126-145,193).
- CORS: falha de XHR vira `status=0` → `opaque()` com `fetch(no-cors)` (:147-158,173). `opaque` → cinza na saúde (health.js:72); `network` → laranja + falha (health.js:77). Em página `https://` com stream `http://` o `fetch no-cors` também é bloqueado (mixed content) ⇒ tende a `network` (laranja/vermelho), **não** cinza — inferência, não testada em navegador.
- `App.friendly` é função (util.js:83); a web pode estendê-la sem editar `tv/js`: guardar a original e substituir `App.friendly` em `web/js/net.js`, acrescentando dica de CORS ao `network` e tratando `opaque`/`abort`.
- `App.http.get` usa XHR (sem `fetch`) — herda CORS e mixed content do navegador; `probe` preserva `.abort` e `health.cancel()` depende disso (health.js:270-280,276).
- Segredos: `store.js:56` só usa AES-GCM com `crypto.subtle` (secure context). Em `http://192.168.x.x` cai em `p0:` base64 (`:70`) — **não é criptografia**; documentar.
- **mock-server.js** (porta 8080, `listen` na :88): CORS `*` (:31); Xtream em `/player_api.php` com `test/test` (:32-47); `/list.m3u` com 200 canais/20 filmes/séries (:49-55) apontando para `http://localhost:9/...` (não toca — serve para catálogo/navegação); `/live|movie|series/*` sintéticos com atraso/404 e TS de 3 pacotes (:59-75). O comentário da :1 cita 8081, mas o servidor escuta só 8080 (divergência real).
- **mock-streams.js** (porta 8090, `PORT` sobrescreve, `HOST_IP` default `10.0.2.2` — usar `HOST_IP=127.0.0.1`, :15-16): CORS `*` nas respostas (:61,79,127,195,202,213,225); `/lista.m3u` com HLS, TS contínuo, 404/403, adulto, 2 filmes MP4 e 2 episódios (:25-48); HLS real em `/hls/index.m3u8` (:236, sendFile:75-104 com Range); TS contínuo `/live/N.ts` e `/livets` (:51-73,223-234); MP4 direto `/movie|series/N.mp4` (:231-232); Xtream completo (`/player_api.php`, `/live/<u>/<p>/<id>.m3u8` → 302 para HLS, `.ts` contínuo) (:111-153,189,210-220).
- Matriz: M3U/Xtream/probe/HLS via hls.js/TS via mpegts.js **exigem CORS**; `<video src="mp4">` sem `crossorigin` não; HLS nativo do Safari não; imagens não. Em `https://`, só fonte `https://` (ou proxy same-origin).

## 6. CSS e palco

- `position:fixed` no CSS da TV: `#stars` (app.css:2), `#planet` (:3), `#shell` (:9), `#overlays` (:110), `#player` (:153), `#toast` (:183). Com `transform` no `#stage`, todos passam a se posicionar dentro dele; `web/css/web.css` deve forçar `position:absolute` nesses seletores (incl. `#player`) — a recomendação do prompt §7.1 vale e deve ser verificada nos 3 motores.
- `html,body{width:1920px;height:1080px;overflow:hidden}` (design-system.css:21): a web precisa sobrescrever para `100%` e manter `--spaceBlack`; `html.playing body` fica transparente (:23) — com `#stage` preto o letterbox continua preto.
- Geometria fixa: `#shell` 1920×1080 (app.css:9); `#hud` 48/48 1824×72 (:11); `#sidebar` 48/136 240×856 (:17); `#screen` 312/136 1560×856 (:23); `#hints` y=1004 (:24); `#stage` escala por `transform` (prompt §7.1). O `HRow` também assume largura 1560 (hrow.js:36; app.css:73).
- Player: `#player` 1920×1080 z60 (:153), `.open` display (:154), `video` absoluto 1920×1080 com fundo preto (:155), `.pl-top/.pl-bottom` 200 px e `opacity` só com `#player.ui` (:156-159), `.pl-panel` 520 px à direita (:173), `.pl-msg` 760×240 (:170), `.pl-spin` (:166), `.spinner` (:168), `--safe:48px` (design-system.css:15).
- Shell/screens: `.glass-panel`, `.card.focused`/`::before`/`::after` (design-system.css:33-38), `.badge` (:40-43), `.vlist/.vl-row/.vl-cell` (app.css:28-32), `.split/.cats/.content` (:35-43), `.card/.poster/.chan` (:46-66), `.field` (:83-87), `.btn` (:92-95), `.settings` (:98-106), `.overlay/.modal` (:115-116), `.details` (:133-150), `.pin-*` (:190-202).
- `web/css/web.css` pode sobrescrever: escala/posição do palco, `html/body` e fundo, `fixed→absolute`, `cursor`, botão de tela cheia/HUD, foco visível adicional, `prefers-reduced-motion`, aviso de janela pequena. Não tocar em tokens, fontes, cards, modais, player e animações (prompt §6.5).
- Sem `inset` e sem `gap` no motor antigo da TV (app.css:111-130; HANDOFF §8 itens 11-12); na web moderno pode usar, mas evitar `inset` no que for compartilhado com a TV.

## 7. Riscos concretos e decisões recomendadas

1. **Duplicar boot**: carregar `tv/js/navigation/keys.js`, `player/player.js` ou `main.js` na web cria dois `App.nav`/`App.player`/shell. Excluir os três; `web/js/keys.js` define `App.registerKeys = function(){}` para `main` não existir.
2. **Player no `body`**: player.js:31; a versão web deve anexar em `#stage`/`#player` e manter `#player` no stacking do palco; `#toast`/`#overlays` também dentro do palco.
3. **`#stars` antes dos scripts**: starfield.js:4 quebra se o canvas não existir.
4. **fixed sob `transform`**: comportamento varia por motor; forçar `absolute` no `web.css` e verificar Chrome/Firefox/Safari. **Confirmado em Edge e Firefox 159 na integração; Safari não testado.**
5. **Ponte sem instâncias**: embrulhar `App.VList`/`App.HRow` na web; não reimplementar listas.
6. **PIN sem gancho**: usar a linha aditiva `_press` (ui.js:144); documentar e testar a TV depois (bateria §13).
7. **Parental no player**: o código real **bloqueia com toast**, não pede PIN (player.js:186,208,224). Paridade recomendada; pedir PIN ali seria divergência de comportamento da TV.
8. **Live pausa**: o código real não pausa live no HTML5 (player.js:151). Reproduzir.
9. **Autoplay/CORS/mixed content**: `<video>` pode rejeitar `play()` (NotAllowedError) → overlay “Enter para iniciar”; `hls.js`/`mpegts.js` precisam de CORS; em LAN `http://` o WebCrypto cai em `p0:`.
10. **`App.shell` incompleto**: telas chamam `shell.goto` (home.js:60) e `App.shell.inScreen()` (home.js:85; browse.js:121) — recriar os 4 métodos antes de montar telas.
11. **HUD/dicas**: traduzir teclas no shell (AMARELO→F, AZUL→X, INFO→I, VOLTAR→Esc, segurar OK→segurar Enter); a `exit` deve virar toast, não modal (main.js:92-100).
12. **CORS do mock**: `mock-server.list.m3u` aponta para `localhost:9`; para tocar use `mock-streams` com `HOST_IP=127.0.0.1`. Não mascarar erro de CORS como “lista inválida” (catalog.js:110 usa `App.friendly`).
13. **IndexedDB privado/`localStorage` 5 MB**: `store.js` já cai em memória (store.js:25-46); não prometer persistência sem testar.
14. **Não confirmado nesta F0**: Safari (HLS nativo/fullscreen), mixed content em `https` e provedor real. Os itens testados depois (Edge/Firefox, autoplay, HLS no palco) estão em §10/§11.

## 8. Checklist de integração/testes (comandos)

- `node tools/test-m3u.js` — parser (aspas, EXTGRP, BOM, CRLF, séries, inválida, 100k). **Executado nesta sessão: passou** (100k em ~2,8 s).
- `node tools/test-resume.js` — 27 casos de retomada/PIN adulto/sessão. **Executado: 27/27 ok**.
- `node tools/test-health.js` — 57 casos de fila, cache, cancelamento, CORS, 403/404, HLS, playback, interruptor. **Executado: 57/57 ok**.
- `node tools/test-tmdb.js` — API real do TMDb (precisa de rede). **Não executado**.
- Terminal 1: `node tools/mock-server.js` → `http://localhost:8080` (Xtream `test/test`, `/list.m3u`, `/artimg/*`). **Não executado agora**.
- Terminal 2: `$env:HOST_IP='127.0.0.1'; node tools/mock-streams.js` → `http://127.0.0.1:8090/lista.m3u` (HLS/TS/MP4/404/403/adulto). **Não executado agora**.
- Terminal 3: `node web/server.js` → `http://localhost:8095/` (a implementar; porta `PORT`).
- Terminal 4: `node tools/agents-live/server.js` → `http://127.0.0.1:8096/` (painel; `report.js` funcionou nesta sessão).
- Navegador/headless: abrir 8095 e checar console limpo; matriz 1920×1080, 1366×768, 2560×1080, 1280×800, zoom 125%; teclado 100% e mouse; `prefers-reduced-motion`; capturas em `dist/web-shots/` via Chrome `--headless=new --screenshot=... --window-size=1920,1080` ou Playwright por `npx` (sem adicionar dependência). **Não executado**.
- Teste mínimo do player web: canal HLS (`/hls/index.m3u8`), TS (`/live/2.ts`), MP4 (`/movie/1.mp4`), 404/403 (mensagem), adulto (bloqueio), 1–9/F/X, painel, zap, close e retorno à tela anterior.

## 9. Contrato sugerido de `web/js/net.js` (proxy opcional, sem editar `tv/js`)

| Função | Semântica |
|---|---|
| `App.net.init()` → `Promise<bool>` | ping `GET /__proxy/ping` same-origin (timeout curto); define `active`; nunca rejeita |
| `App.net.active()` → bool | proxy disponível e habilitado; usado só no HUD (“proxy local”) |
| `App.net.proxy(url)` → string | mesma origem `/__proxy?url=...`; só `http:`/`https:` |
| `App.net.mediaUrl(url)` → string | reescreve `.m3u8`/`.ts` para o proxy; MP4 direto intacto |
| `App.net.http` (opcional) | envolver `App.http.get/stream/probe` preservando `probe.abort` (health.cancel) e repassando `{code,status}` |
| `App.net.friendly(err)` | estende `App.friendly` para `network` (dica CORS) e `opaque`/`abort` |
| `App.net.ready()` / `App.net.reason()` | estado e motivo para a UI (sem logar URL/query) |

Regras: `init()` antes do `App.catalog.init` no shell; se o ping falhar, `net` fica inerte e o app segue sem proxy; nunca ativar por padrão; não logar URL completa (usar `App.redact`); não alterar `tv/js`.

## 10. Decisões de integração (orquestrador, F1–F4)

- **Gancho do PIN aplicado**: `tv/js/components/ui.js` recebeu a linha aditiva
  `b._press = function () { press(v); };` no `pinPad` (linha 145). A TV não tem mouse, então o
  comportamento dela não muda; `test-m3u`, `test-resume` e `test-health` passaram depois da mudança.
- **`App.net` congelado** para shell/player: `init/active/proxy/mediaUrl`, patch de
  `App.http.get/stream/probe` preservando `probe.abort`, extensão de `App.friendly`. O shell chama
  `App.net.init()` antes de `App.catalog.init()`; o player usa `App.net.mediaUrl()` só em `.m3u8`/`.ts`.
- **Player web** anexa `#player` ao `#stage`, mantém as classes/DOM da TV e pode criar um `<style>`
  escopado dentro de `web/js/player.js` para os controles web-only (mudo/fullscreen/PiP/barra clicável).
- **Portas de teste paralelas**: shell 8097, player 8098, net 8099; mocks 8080/8090; painel 8096.
  A validação final usa 8095. Nenhum agente deve deixar processo rodando.
- **Recon**: o subagente ficou sem reportar progresso por vários minutos e foi interrompido; ao ser
  retomado com escopo reduzido, entregou este NOTES. O orquestrador manteve o painel atualizado e
  assumiu a integração.
- **Fechamento (F5)**: `/__proxy/ping` passou a responder 200 com `{ok:false}` quando o proxy está
  desligado (sem 404 no console); o shell inicializa `App.net` mesmo sem lista; o spinner do player
  recebeu `pointer-events:none`; e o texto de Configurações é corrigido na web para não afirmar
  criptografia em HTTP na LAN (WebCrypto indisponível → `p0:` Base64). O QA entregou `web/smoke.js`
  (49 PASS) e as capturas, mas travou antes de escrever a auditoria; o orquestrador consolidou
  `web/UI-UX-AUDIT.md` com as medições/capturas dele e os testes de integração.
- **Build/docs (F4)**: `web/build.js` gera 42 arquivos em `dist/web/` (1,4 MB), testado na raiz e em
  subpasta; `web/README.md`, `README.md` e `HANDOFF.md` §16 documentam rodar, publicar, proxy e
  limitações.
- **Testes finais**: `test-m3u` OK, `test-resume` 27/27, `test-health` 57/57, `test-tmdb` OK,
  `test-compat` OK, `web/smoke.js` 49 PASS; CRUD M3U/Xtream, validação de URL, PIN, adulto oculto
  (5→4), cache/retomada, HLS/TS/MP4 e fullscreen verificados no Edge; HLS, catálogo e navegação
  também verificados no Firefox 159. Safari não testado.
