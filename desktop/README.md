# Space IPTV Desktop (Windows)

Aplicativo instalável para **Windows 10/11 x64** que reutiliza o mesmo núcleo do
Space IPTV (`tv/js`) e os módulos do app web (`web/js`): mesma identidade visual,
mesmo login, mesmas listas. **O módulo de administração fica só na web.**

- Shell glass/escuro com sidebar (Início, TV ao vivo, Filmes, Séries, Pesquisa,
  Favoritos, Baixados, Configurações), HUD com usuário/sessão e estado de rede.
  O **palco preenche a janela** (em janelas mais largas que 16:9 a altura de
  projeto é reduzida em vez de deixar faixas laterais) e a barra de menu nativa
  fica auto-oculta (Alt mostra).
- Login igual ao da web (`/api/auth/*`), sessão em cookies HttpOnly no
  `session.defaultSession`, logout limpa cookies e estado offline.
- Importação de lista `.m3u/.m3u8` pelo **seletor nativo do Windows** (leitura no
  processo principal), com o mesmo parser/validação/renomear/substituir/excluir.
- **Downloads offline**: filme MP4 (Range/retomada) e HLS empacotado como pasta
  gerenciada (playlist local + segmentos + chaves AES-128 quando o provedor
  entrega), fila com concorrência 2, pausar/retomar/cancelar/retry, tela
  **Baixados** e reprodução sem internet nem backend.
- **EPG novo**: XMLTV por M3U (`url-tvg`/`x-tvg-url`) ou Xtream (`xmltv.php`),
  gzip, cache em IndexedDB (TTL configurável, padrão 24 h), "Agora/A seguir" nos
  canais e tela **Guia** com timeline (teclado e mouse). Se a lista não informar
  EPG, usa a **fonte pública padrão** `EPGShare01 BR1`
  (`https://epgshare01.online/epgshare01/epg_ripper_BR1.xml.gz`) — trocável ou
  desligável em Configurações; IDs prefixados (ex.: `São.Paulo/SP..SBT.br`) são
  casados por alias com `tvg-id` comuns (`SBT.br`).
- **Iniciar com o Windows** desligado por padrão (per-user, sem administrador),
  bandeja (Abrir/Baixados/Sair), single-instance e posição/tamanho da janela
  lembrados.
- Sem `nodeIntegration`, `contextIsolation`/`sandbox` ligados, CSP restritiva,
  proxy interno só em `127.0.0.1` que **nega `/api/admin/*`**.

## Requisitos

| Item | Versão |
|---|---|
| Windows | 10/11 x64 |
| Node.js (desenvolvimento) | 18+ (testado com 24.19) |
| npm | 9+ |
| Python + Pillow (opcional, só para regerar ícones) | 3.10+ |

O app **não** precisa de FFmpeg, servidor, VPS, Cloudflare Worker ou PC ligado.

## Desenvolvimento

```powershell
cd desktop
npm install                 # Electron 40.6.0 + electron-builder + electron-updater
npm run build:renderer      # copia tv/ + web/ (sem admin) + src/renderer -> dist/renderer
npm start                   # abre o app (builda o renderer antes)
npm run dev                 # idem + DevTools
npm test                    # node --test "test/**/*.test.js"
```

Testes de UI/E2E (sem dependências, via Chrome DevTools Protocol):

```powershell
node scripts/e2e-ui.js --electron "C:\caminho\electron.exe" --shots
node scripts/e2e-ui.js --electron "..." --shots --offline-proof   # desconecta/reconecta o Wi-Fi
```

O E2E usa o backend de teste local em `http://127.0.0.1:8789`
(`node tools/pages-runner.js`) e as credenciais de `desktop/test/tmp/env.json`
(gerado pelo lead, gitignored; nunca commitar).

> **Ambiente de desenvolvimento restrito (importante):** nesta máquina, o
> sandbox da sessão do agente bloqueia executar binários de dentro do workspace
> (Electron dá APPCRASH; o mesmo `.exe` copiado para fora roda). Por isso os
> smoke/E2E usam um Electron externo (`--electron ...`). Em uma máquina normal,
> `npx electron . --smoke` funciona direto. O Electron **45.x crasha** nesta
> build do Windows 11 (26300), então o projeto está fixado em **40.6.0**.

## Instalador (NSIS)

```powershell
npm run dist         # -> ../dist/desktop/SpaceIPTV-Setup-1.0.1.exe
```

- Instalação **per-user** (sem UAC), NSIS com páginas: boas-vindas, destino,
  **Pasta de downloads** (padrão `%USERPROFILE%\Videos\Space IPTV`, valida
  escrita), atalhos (desktop/menu Iniciar), resumo, instalação, conclusão.
- Instalação silenciosa (`/S`) usa o padrão, sem perguntas.
- Desinstalador remove atalhos, autostart e o cache/config do app; **não apaga a
  pasta de downloads** por padrão (há opção explícita no desinstalador).
- O build **não é assinado** (não há certificado no projeto): o Windows
  SmartScreen mostra "Editor desconhecido". Clique em *Mais informações →
  Executar assim mesmo*. Para assinar, veja [`RELEASE.md`](RELEASE.md).

## Onde ficam os dados

| O quê | Caminho |
|---|---|
| Configuração | `%APPDATA%\Space IPTV\config.json` (porta interna persistida, pasta de downloads, EPG TTL, autostart, janela) |
| Cache de sessão | `%APPDATA%\Space IPTV` (cookies do `session.defaultSession`, IndexedDB) |
| Downloads | padrão `%USERPROFILE%\Videos\Space IPTV` (escolhido no instalador/Configurações) |
| Biblioteca offline | `<downloads>/.space-iptv/index.json` + `<downloads>/<item>/manifest.json` |
| Logs | não há log persistente; console só em `--dev` (sem senha/token/cookie) |

Trocar a pasta de downloads **não apaga** os arquivos antigos: o app só passa a
gerenciar a pasta nova (a antiga continua no disco).

## Configuração pela interface

**Configurações** (tela compartilhada com a TV/web + ações desktop):

- listas M3U/Xtream (adicionar, por arquivo, editar, excluir, atualizar);
- pasta de downloads (mostrar/alterar/validar);
- cache do guia (12/24/48 h), **fonte de EPG padrão** (URL pública, trocar/limpar)
  e "Atualizar guia agora";
- iniciar com o Windows (**desligado por padrão**) e iniciar minimizado na bandeja;
- fechar minimiza para a bandeja;
- conta: e-mail/papel (sempre "usuário" no desktop), trocar senha, sair.

## Limitações conhecidas

- **Sem MSIX/Microsoft Store** nesta entrega (estrutura de `appId`/ícones já
  compatível para o futuro).
- **Sem módulo admin**: `/api/admin/*` é bloqueado no proxy interno (403).
- **DRM não é contornado**: playlists com SAMPLE-AES/Widevine/PlayReady são
  recusadas com mensagem clara.
- **HLS ao vivo** depende do provedor e do codec suportado pelo Chromium
  embutido; MPEG-TS é reproduzido via `mpegts.js` (vendorizado).
- **EPG** depende de a lista fornecer `url-tvg`/`x-tvg-url` (M3U) ou `xmltv.php`
  (Xtream); sem isso usa a fonte pública padrão (EPGShare01 BR1) — um serviço de
  terceiros, sem SLA e com cobertura parcial (o casamento é por alias/nome).
  A tela Guia mostra estado vazio explicativo quando não há guia.
- Build **não assinado** (SmartScreen) e auto-update apenas **preparado**
  (`electron-updater` + feed GitHub no `electron-builder.yml`), sem publicar.
- Recuperação de senha depende das capabilities do backend (hoje
  `recovery=false`: peça reset ao administrador no site).
- O app usa o site `https://space-iptv.pages.dev` como backend de login/sync
  (configurável por `SPACE_API_ORIGIN` em desenvolvimento).

## Estrutura

```
desktop/
  src/main/       processo principal: janela, servidor interno, proxy /api,
                  media-proxy, downloads/HLS, config, autostart, tray, IPC
  src/preload/    window.space (API mínima via contextBridge)
  src/renderer/   HTML/CSS/JS da camada desktop (shell reaproveita web/js)
  scripts/        build-renderer, ícones, check-secrets, e2e-ui
  installer/      macros NSIS (página da pasta de downloads, uninstall)
  test/           unit, integration, e2e e fixtures (node --test)
  docs/           UI-UX-AUDIT, UI-UX-NOTES, TEST-REPORT
  CONTRACTS.md    contratos do time (arquitetura/segurança)
```

## Licença e conteúdo

O Space IPTV é um reprodutor de listas fornecidas pelo usuário. O app não inclui
canais, mídia nem credenciais. Não há telemetria.
