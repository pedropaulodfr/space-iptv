# Space IPTV Desktop — contratos congelados (F0)

> Este arquivo é a **fonte da verdade** entre os agentes. Não mude um contrato sem
> avisar o lead no painel (`tools/agents-live/report.js`) e atualizar este documento
> (somente o lead edita este arquivo).

## 0. Regras gerais

- Repo: `D:\Documentos\projects\IPTV-Tizen` · branch **`feat/desktop-app`** · app em **`desktop/`**.
- **Ninguém edita `tv/**` nem `web/**`** — nem para "consertar". Precisa de mudança lá? Peça ao lead.
  Exceções já feitas pelo lead: `web/js/shell.js` (hooks `App.isDesktop`/`App.desktopMenu`) e
  `tv/js/parser/m3u.js` (cabeçalho `#EXTM3U` em `res.head`).
- Textos de UI em **pt-BR**; datas/horas em pt-BR. Ícones = SVG, nunca emoji como ícone.
- Design system: `tv/css/design-system.css` é a única fonte de tokens. Nada de paleta/fonte nova
  (Orbitron/Inter locais; nunca Google Fonts). Componentes: `glass-panel`, `card`, `badge`,
  `field`, `btn`, `overlay/modal`, `VList`, `HRow`.
- Acessibilidade: contraste ≥ 4.5:1, alvo ≥ 44 px, foco visível
  `outline:2px solid var(--electricBlue)`, `prefers-reduced-motion`, teclado **e** mouse,
  label visível, erro junto do campo, sem interação só-hover, reserva de espaço (sem CLS).
- Zero dependência nova além de Electron/electron-builder/electron-updater já instalados.
  Testes com `node --test` (Node 24). Nada de biblioteca de UI.
- Processo: `node tools/agents-live/report.js --agent SEU_SLUG --status working --phase Fx ...`
  no começo, a cada marco, e `--status done|blocked|error` (+ `--note`) no fim. **Nunca invente progresso.**
- Não deixe processo rodando em porta fixa ao terminar. Portas de teste combinadas:
  backend local 8789 · servidor interno do desktop: porta efêmera (nunca fixe no código).
- Nunca logue senha, cookie, token, URL com credenciais. Use `App.redact`/máscara.
- Não há admin no desktop: nada de `web/js/screens/admin.js`, menu Administração ou `/api/admin/*`.

## 1. Build e execução

```powershell
cd desktop
npm run build:renderer     # copia tv/ + web/ (whitelist) + src/renderer -> dist/renderer
npm start                  # builda e abre o Electron (main = src/main/main.js, CJS)
npm test                   # node --test test/
```

- `scripts/build-renderer.js` é do lead. A lista `REQUIRED` dele precisa continuar válida.
- Electron **45.x** já instalado em `desktop/node_modules`. Não rode `npm install` de novo
  sem necessidade e **nunca** adicione dependência (exceção: líder).
- O renderer **não** carrega `tv/js/main.js`, `tv/js/navigation/keys.js`,
  `tv/js/player/player.js` nem `web/js/screens/admin.js` (mesmo motivo da versão web).
  A ordem dos `<script>` em `src/renderer/index.html` é fixa; quem precisar de um arquivo novo
  avisa o lead.

## 2. Processo principal (main)

Layout:

```
src/main/main.js          ciclo de vida, single instance, janela, tray, menu, IPC raiz
src/main/server.js        servidor interno 127.0.0.1 (estático + /api + /media-proxy + /_epg + /offline)
src/main/api-proxy.js     reverse proxy /api/* (Origem/Referer reescritos, cookies, bloqueio admin)
src/main/config.js        config JSON atômica + leitura da pasta do instalador (registry)
src/main/autostart.js     app.setLoginItemSettings
src/main/tray.js          bandeja
src/main/paths.js         sanitização de caminho e containment (downloads)
src/main/media-proxy.js   proxy de mídia (Range, rewrite de playlist)
src/main/downloads.js     fila, MP4, manifestos
src/main/hls.js           empacotamento HLS offline + DRM refusal
src/main/manifest.js      JSON atômico (tmp+rename) + índice da biblioteca
src/preload/preload.js    contextBridge -> window.space
```

### 2.1 Config (`config.js`)

Arquivo `%APPDATA%\Space IPTV\config.json`, escrita atômica (`.tmp` + rename). Schema:

```json
{
  "version": 1,
  "apiOrigin": "https://space-iptv.pages.dev",
  "internalPort": 0,
  "downloadsDir": "C:\\Users\\<user>\\Videos\\Space IPTV",
  "epgTtlHours": 24,
  "startWithWindows": false,
  "startMinimizedToTray": false,
  "minimizeToTrayOnClose": false,
  "window": { "x": null, "y": null, "width": 1280, "height": 720, "maximized": false }
}
```

- `internalPort` começa `0`; no primeiro uso o main sorteia 41000–49000 e grava (origem estável
  para IndexedDB/localStorage). Porta ocupada → tenta a próxima livre e **mantém a original no
  config**; avisa no HUD. `SPACE_API_ORIGIN` (env) tem prioridade sobre `apiOrigin` (testes).
- `downloadsDir`: config vence; se ausente, lê `HKCU\Software\Space IPTV` valor `DownloadsDir`
  (gravado pelo instalador); se ausente, `%USERPROFILE%\Videos\Space IPTV`. Criar e validar escrita.
- Nada de segredo no config. Nunca gravar senha/token/cookie.

### 2.2 Servidor interno (`server.js`)

- Escuta **só** `127.0.0.1`, porta do config (fallback efêmero). `app.on('will-quit')` fecha.
- Rejeita `Host` diferente de `127.0.0.1:<porta>`/`localhost:<porta>` → 400.
- Cabeçalhos: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- Rotas:
  | Rota | Regra |
  |---|---|
  | `GET /` | `dist/renderer/index.html` |
  | `GET /login.html` | `dist/renderer/login.html` |
  | `GET /<tv\|web\|css\|js\|img>/...` | estático **somente** dentro de `dist/renderer` (anti-traversal) |
  | `ALL /api/*` | proxy para `config.apiOrigin`; **403 imediato em `/api/admin/*`** |
  | `GET /media-proxy/ping` | `{ok:true,proxy:'local',version,hosts:[...]}` se sessão autenticada; senão `{ok:false}` |
  | `GET /media-proxy?url=` | módulo `media-proxy.js` (downloads) |
  | `GET /_epg/source?url=` | streaming do XMLTV (gzip repassado), sessão + allowlist |
  | `GET /offline/<itemId>/<rel>` | arquivo do manifesto daquele item (downloads) |
  | outro | 404 |
- **Proxy `/api`**: método/corpo/status/cabeçalhos repassados; reescrever
  `Origin`/`Referer`/`Host` para a origem do backend e `Sec-Fetch-Site: same-origin`; repassar
  `Cookie`; repassar `Set-Cookie` removendo `Domain` e `Secure` (loopback HTTP; `HttpOnly`/`SameSite`
  preservados); sem CORS aberto; timeout 30 s; sem log de URL/credenciais.
- **Estado de sessão** (em memória): vira `true` após 200 em `/api/auth/login` ou
  `/api/auth/session`; vira `false` em 401/403 da API ou `/api/auth/logout` 200.
  `/media-proxy` e `/_epg/source` exigem `true`.
- **Allowlist de hosts de mídia**: começa vazia; `/api` autenticado + `POST /_hosts` (chamado pelo
  renderer via `space.registerMediaHosts`) registra hosts vistos nas listas/EPG. Proxy nega host fora
  da allowlist, nega `file:`, `127.0.0.1`/LAN loopback do próprio app, e nega recursão.
  (O lead pode simplificar: allowlist = hosts registrados **ou** host da API **ou** sufixos de
  `MEDIA_PROXY_HOSTS`.)

### 2.3 Preload `window.space` (sandbox, contextIsolation)

Somente `ipcRenderer.invoke`/`on` em canais fixos. **Nada de `require`, `fs`, `path` ou canal livre.**

```ts
space.app:    version(): string; info(): {version, apiOrigin, downloadsDir, userData};
              quit(): void; minimize(): void; hideToTray(): void;
space.files:  pickM3u({maxBytes}): Promise<{ok, canceled?, name?, size?, text?, error?}>;
space.config: get(): Promise<Config>; set(patch): Promise<Config>;
              pickFolder({title?, defaultPath?}): Promise<string|null>;
              validateDownloadsDir(path): Promise<{ok, path?, error?, freeBytes?}>;
space.session:getCachedUser(): Promise<{email,name,role}|null>;
              setCachedUser({email,name,role}): Promise<void>;
              clearCachedUser(): Promise<void>; clearCookies(): Promise<void>;
space.downloads: probe({urls:string[]}): Promise<{variants:Variant[]}>;
              add(req: DownloadRequest): Promise<{ok, id?, error?}>;
              pause(id); resume(id); cancel(id); retry(id);
              remove(id, {deleteFiles?:boolean}): Promise<{ok, error?}>;
              list(): Promise<{items: DownloadItem[], stats: QueueStats}>;
              reveal(id): Promise<void>; openFolder(): Promise<void>;
              onEvent(cb: (evt) => void): () => void;
space.autostart: get(): Promise<{openAtLogin:boolean, minimized:boolean}>;
              set({openAtLogin?, minimized?}): Promise<{openAtLogin:boolean, minimized:boolean}>;
space.external: open(url): Promise<{ok, error?}>;
space.events: on(channel:'network'|'tray'|'update', cb): () => void;
space.registerMediaHosts(hosts: string[]): Promise<void>;
```

`Variant = {id, url, label, resolution?, codecs?, bandwidth?, estimatedBytes?}`
`DownloadRequest = {kind:'movie'|'episode', title, subtitle?, poster?, listId, itemId, epId?,
  season?, episode?, durationSec?, url, variantId?, totalBytes?, headers?:{}}`
`DownloadItem = {id, kind, title, subtitle, poster, status:'queued'|'downloading'|'paused'|'packaging'|
  'done'|'error'|'canceled', progress, bytes, totalBytes, speedBps, etaSec, error?, dirName,
  createdAt, completedAt?, offlineUrl?, durationSec}`

### 2.4 Modos de execução e variáveis de teste

- Flags do processo principal:
  - `--autostart` (vindo do login item): abre minimizado na bandeja **somente** se a config
    `startMinimizedToTray` estiver ligada; senão abre a janela normal (nunca escondido sem indicação).
  - `--smoke`: modo de teste automatizado — janela `show:false`, imprime no stdout
    `SPACE_SERVER=http://127.0.0.1:<porta>` quando servidor+renderer estiverem prontos e sai com 0 em
    ~2 s (timeout 20 s → exit 1). Sem tray e sem auto-update nesse modo.
  - `--dev`: devtools + menu de desenvolvimento.
- Env (testes/CI, precedem o config): `SPACE_API_ORIGIN`, `SPACE_DOWNLOADS_DIR`,
  `SPACE_CONFIG_FILE` (caminho do JSON de config; permite userData isolado), `SPACE_INTERNAL_PORT`
  (`0` = automático/persistido), `SPACE_NO_AUTOSTART=1` (ignora login item).

## 3. Renderer — contratos de módulos

Ordem dos scripts em `src/renderer/index.html` (não alterar sem o lead):

1. núcleo `tv/js` (igual web) → 2. `js/desktop-config.js` → 3. `web/js/{keys,pointers,net,session,sync,player}.js`
→ 4. `js/upload-desktop.js` → 5. `js/downloads.js` → 6. `js/epg/epg.js` → 7. `js/epg/guide-screen.js`
→ 8. `js/settings-desktop.js` → 9. `js/bootstrap.js` → 10. `web/js/shell.js` (por último).

O `login.html` carrega `web/js/login.js` (reaproveitado) e depois `js/login-desktop.js`
(ajusta versão/estado offline; não reimplementa login).

### 3.1 `js/desktop-config.js` (auth-desktop)

```js
App.isDesktop = true;
App.desktop = { version:'', offline:false, platform:'win32' };
App.desktopMenu = function () {
  return [{ id:'downloads', label:'Baixados', make:function(){ return App.screens.downloads(); } }];
};
App.desktop.api = { registerMediaHosts(hosts) }   // -> space.registerMediaHosts
```

### 3.2 `js/bootstrap.js` (auth-desktop)

- **Gate de sessão**: usa `App.session.init()` do web (`/api/auth/session`). 401 → o web já
  redireciona para `/login.html?next=...`. Falha de rede sem usuário em cache → painel bloqueante
  "Sem conexão com o servidor" com **Tentar de novo** (nunca login offline inventado).
- **Offline**: se `!navigator.onLine` (ou fetch falhar) e `space.session.getCachedUser()` existir:
  `App.desktop.offline = true`; patch de `App.session.init` resolvendo `true` com usuário em cache,
  `App.session.user()` devolvendo o cache, `App.session.isAdmin()` sempre `false`.
  Telas de API mostram indisponibilidade; **Baixados e Configurações funcionam**.
- `App.session.actions()` ganha as ações desktop via `settings-desktop.js` (não duplicar).
- Badge `#hud-offline` (offline), `#hud-downloads` (fila: "Baixando 2 · 45%"), `#hud-user`
  (e-mail; title = e-mail + papel "usuário" — **nunca "administrador"**).
- Ao logar (200 em `/api/auth/session` ou `/api/auth/login`) e no boot: `space.session.setCachedUser`
  e `space.registerMediaHosts(hosts das listas)` (hosts de `App.catalog.data`/`App.lists`).
- Logout: chama `/api/auth/logout`, limpa cache de usuário (`clearCachedUser`) e cookies
  (`space.session.clearCookies`) e vai para `/login.html`.
- Tecla **G** (capture, sem input focado e sem player/modal): `App.desktop.guide.open()`.
  Não existe menu "Guia" na sidebar; a entrada é a tela TV ao vivo + atalho G.
- Versão/plataforma em `App.desktop.version` via `space.app.version()`; rodapé de Configurações.

### 3.3 `js/upload-desktop.js` (auth-desktop)

Substitui `web/js/upload.js` com o **mesmo contrato** (`App.upload.open({record?, onSaved?})`,
`App.upload.MAX`), mesma UI/validação/preview do web, mas:
- botão principal abre `space.files.pickM3u({maxBytes: App.upload.MAX})` (dialog nativo, leitura no main);
- erro amigável para arquivo > limite, vazio, extensão errada, lista inválida;
- salva com `App.lists.saveFile` (id existente = substituir/renomear) e emite `onSaved` igual web;
- **drag&drop** na janela como melhoria (FileReader no renderer; nada de path exposto).
- `MAX` padrão **25 MB** (>= 20 MB do web), configurável.

### 3.4 `js/downloads.js` (downloads)

- `App.screens.downloads()` → `{hints, mount(root), unmount(), enter(), key(a)}` (padrão `App.screens`).
  Tela: pôster, título, tipo, tamanho, duração, data, status; busca/filtro; ações
  Reproduzir/abrir pasta/excluir (confirmação forte) — teclado e mouse, `VList`.
- `App.downloads = { probe(item, list, ep?), download(item, list, ep?), playOffline(rec), refresh() }`.
  `probe` monta as URLs via `App.catalog.urls(item, list, ep)` e chama `space.downloads.probe`.
  Se >1 variante → seletor (`App.ui.menu`) com resolução/codec/tamanho estimado; senão baixa direto.
- Injeção do botão **Baixar** sem editar `tv/js`: embrulhar `App.actions.details` (overlay já aberto
  em `#overlays`) e inserir "Baixar" no topo do card e um botão por episódio nas linhas de episódio
  (MutationObserver no overlay; apenas quando `App.player` e sessão válida).
- Reprodução offline: `App.player.play({item:{t:'movie'|'series', n:title, ...}, list:{id:listId,type:'offline'},
  urls:[offlineUrl], live:false, title:function(){...}, sub:function(){...}, onClose:...})`.
  MP4 serve por Range; HLS local via playlist reescrita. Nenhuma dependência de backend/internet.
- Excluir: só arquivos/pastas **gerenciados** (manifesto) dentro de `downloadsDir`; atualiza índice.

### 3.5 `js/epg/epg.js` + `js/epg/guide-screen.js` (epg)

- `App.epg = { load(list), refresh(list), now(channelName, tvgId), next(...), state(), open() }`.
- Fonte: M3U `res.head['url-tvg']`/`['x-tvg-url']` (parser estendido pelo lead) **ou** Xtream
  `server + /xmltv.php?username=&password=` (credenciais em memória; nunca logar).
- Download pelo próprio servidor: `GET /_epg/source?url=` (mesma origem, sem CORS), streaming;
  gzip tratado pelo Chromium no fetch. Parsing incremental (sem carregar XMLTV inteiro de uma vez).
- Match: `tvg-id` exato → fallback nome normalizado (`App.norm`, sem acento/espaço/pontuação).
  Dedup por (canal, início). Fuso do XMLTV (`+0000` etc.) convertido; exibição pt-BR.
- Cache no **IndexedDB** `spaceiptv` (store `kv`, novas chaves `epg.meta.<listId>`, `epg.ch.<listId>.<chunk>`)
  — não mexer nas chaves existentes. TTL padrão 24 h (`space.config.epgTtlHours`), refresh manual.
- Tela **Guia**: full-screen overlay (camada `App.nav.push`), timeline com navegação por teclado
  (setas, Enter detalhe, Esc fecha) e mouse; botão "Guia" injetado na tela TV ao vivo; detalhe do
  programa; estado vazio claro quando não há EPG.
- Integração nos cards de canal: embrulhar `App.cards.channel` para acrescentar "Agora: …" / "A seguir: …"
  (linhas estáveis, sem CLS) e botão/atalho do Guia na tela de TV ao vivo (sem editar `tv/js`).
- XMLTV de teste/fixtures em `desktop/test/fixtures/xmltv-*.xml(.gz)` (esse agente é dono dessa pasta).

### 3.6 `js/settings-desktop.js` (auth-desktop)

Ações extras anexadas a `App.session.actions()` (o `tv/js/screens/settings.js` já as exibe):
- **Pasta de downloads** (mostrar, alterar via `space.config.pickFolder`/`validateDownloadsDir`;
  trocar não apaga arquivos antigos; inválida = erro junto ao campo).
- **EPG**: cache em horas (12/24/48) + "Atualizar guia agora".
- **Iniciar com o Windows** (switch, padrão **desligado**) e **Iniciar minimizado na bandeja**
  (switch, padrão desligado) via `space.autostart`.
- **Bandeja**: fechar minimiza para a bandeja (switch, padrão desligado).
- **Sobre**: versão do app (`space.app.info()`), aviso de build não assinado quando aplicável.
- Nunca mostrar "Administração"; papel do usuário aparece como "usuário".

## 4. Downloads (main) — manifesto e arquivos

Pasta raiz = `config.downloadsDir` (ex.: `%USERPROFILE%\Videos\Space IPTV`).

```
<downloadsDir>/.space-iptv/index.json          índice atômico (lista de itens + versão)
<downloadsDir>/<slug-sanitizado>/manifest.json manifesto atômico do item
<downloadsDir>/<slug-sanitizado>/video.mp4     (MP4) + video.mp4.part enquanto baixa
<downloadsDir>/<slug-sanitizado>/playlist.m3u8 (HLS local reescrito)
<downloadsDir>/<slug-sanitizado>/segments/...  (HLS) + init map
<downloadsDir>/<slug-sanitizado>/keys/...      (AES-128 apenas quando o provedor entrega a chave)
```

- Nome: sanitizar (sem `..`, `<>:"/\|?*`, sem nomes reservados do Windows, máx. ~80 chars),
  colisão → sufixo ` (2)`; `id` = uuid.
- Manifesto: `{version, id, kind, title, subtitle, poster, listId, itemId, epId, season, episode,
  createdAt, completedAt, durationSec, engine:'mp4'|'hls', files:[{path,size,sha256?}],
  playlist:{master?, variant?}, drm:'none', sizeBytes, offlineUrl}`. Escrita `tmp`+rename.
- MP4: GET com `Range`, retomada via `.part` + validação de `Content-Length`/total; 206 esperado.
- HLS: baixar master, escolher variante, baixar segmentos/init map/chaves AES-128 **quando
  diretamente disponíveis**; reescrever playlist para caminhos relativos locais; sem FFmpeg.
- **DRM/recusa**: `SAMPLE-AES`, `com.apple.streamingkeydelivery`, Widevine, PlayReady, `#EXT-X-SESSION-KEY`
  com proteção → falha imediata com mensagem clara ("conteúdo protegido não pode ser baixado"),
  sem tentar contornar. Nunca salvar credenciais em nome/manifesto/log.
- Fila: concorrência **2**; eventos `queue|progress|done|error|removed` via IPC; pausar/retomar/cancelar/retry;
  checar espaço livre antes de iniciar (margem ~50 MB) → erro claro.
- Remover: somente `manifest.files` + pasta do item + entrada no índice; nunca fora de `downloadsDir`.
- `/offline/<itemId>/<rel>`: resolve pelo manifesto do item; só arquivos listados; Range para MP4.

## 5. Instalador (qa-release)

- NSIS per-user, sem UAC; páginas: boas-vindas, destino, **Pasta de downloads** (custom NSIS page,
  padrão `%USERPROFILE%\Videos\Space IPTV`, criar e testar escrita), atalhos (desktop/menu Iniciar),
  resumo, instalação, conclusão.
- A escolha grava `HKCU\Software\Space IPTV` valor `DownloadsDir` (o app lê no primeiro run).
- Instalação silenciosa (`/S`) usa o padrão e não pergunta nada.
- Desinstalador: remove atalhos, autostart (`HKCU\...\CurrentVersion\Run`), cache/config do app;
  **não** apaga a pasta de downloads por padrão (checkbox opcional no uninstall, desmarcado).
- `electron-builder.yml` e `package.json` são do lead; os scripts NSIS (`desktop/installer/*.nsh`)
  são do qa-release. Ícone: `desktop/build/icon.ico` gerado por `scripts/make-icons.py`.
- Auto-update: `electron-updater` já instalado e `publish` no yml; sem publicar e sem segredo no build.
  Build sem certificado = não assinado (documentar SmartScreen; nunca burlar).

## 6. Testes

| Pasta | Dono | Conteúdo |
|---|---|---|
| `desktop/test/unit/` | qa-release | paths/config/manifest/proxy/media proxy/HLS/DRM/EPG/autostart |
| `desktop/test/integration/` | qa-release | servidor interno (403 admin, CSRF/Origin, cookies), downloader com servidor mock local, EPG end-to-end, login via pages-runner |
| `desktop/test/e2e/` | qa-release | Electron + CDP: login, importar M3U, baixar, tocar offline, screenshots |
| `desktop/test/fixtures/` | qa-release (epg pode criar xmltv-*) | XMLTV, M3U, streams |
| `desktop/test/tmp/` | todos | temporários (gitignored) |

- `npm test` = `node --test test/`.
- Login E2E: backend local (`node tools/pages-runner.js --port 8789`) apontando para uma
  **branch Neon isolada** com usuários de teste; o lead fornece as credenciais/env em
  `desktop/test/tmp/env.json` (gitignored). Nunca commitar credenciais.
- Não-regressão: `node tools/test-m3u.js`, `tools/test-resume.js`, `tools/test-health.js`,
  `node web/smoke.js` continuam passando.

## 7. Definição de pronto por fase

- **F1**: app abre; login real via backend; sessão persiste após fechar/abrir; logout limpa;
  `/api/admin/*` → 403 no proxy; navegação por teclado/mouse; foco visível; sem admin no menu;
  CSP sem unsafe-eval; console sem erro.
- **F2**: MP4 baixa/retoma/pausa/cancela; HLS vira pacote e toca offline; DRM recusado; excluir
  apaga só o gerenciado; disco cheio/erro claro; tela Baixados completa.
- **F3**: EPG XMLTV (gzip) e Xtream; cache 24 h configurável + refresh; agora/a seguir nos canais;
  Guia com timeline teclado+mouse; vazio claro; sem duplicatas; pt-BR.
- **F4**: setup escolhe pasta; path inválido rejeitado; autostart liga/desliga e vem desligado;
  desinstalador remove autostart/shortcuts/cache e preserva downloads; ícone/nome corretos.
- **F5**: testes verdes, E2E com evidência, screenshots, teste offline real, install/uninstall
  nesta máquina, checksums, README/release notes.

## 8. Painel

`node tools/agents-live/server.js` (lead mantém em `http://127.0.0.1:8096/`).
Agentes: `auth-desktop`, `downloads`, `epg`, `ui-ux`, `qa-release`, `lead`.
Reporte honestamente: `working`/`blocked`/`error`/`done`, `--files` com o que está editando.
