# Space IPTV Desktop — Relatório de testes (última execução)

Data: 2026-11-16 · Branch: `feat/desktop-app` · Windows 11 build 26300 x64 · Node 24.19
Electron **40.6.0** (o 45.x crasha nesta build do Windows — ver Observações de ambiente)

> Evidências reproduzíveis: comandos abaixo, capturas em `dist/desktop-shots/`
> (fora do git por decisão do repo: `dist/` é ignorado).

## 1. Suíte automatizada (`cd desktop; npm test`)

**Resultado: 175/175 testes verdes** (`node --test "test/**/*.test.js"`, 0 falhas).

| Arquivo | Cobre |
|---|---|
| `test/unit/config.test.js` | config JSON atômica, porta persistida, downloadsDir (env/config/registro/padrão), validação de pasta, cache de usuário offline |
| `test/unit/paths.test.js` | sanitização de nomes, colisão `(2)`, containment lexical/realpath, nomes reservados do Windows, traversal |
| `test/unit/manifest.test.js` | manifesto/índice atômicos, `.bak`, corrupção tolerada, reconstrução, remoção gerenciada |
| `test/unit/media-proxy.test.js` | Range/206, rewrite de playlist, allowlist, sem cookies upstream, timeouts |
| `test/unit/autostart.test.js` | login item per-user, padrão desligado, remoção ao desativar, `SPACE_NO_AUTOSTART` |
| `test/unit/epg-parse.test.js` | XMLTV incremental: gzip, fusos (+0000/-0330/+0200), CDATA/entidades, dedupe, truncado, vazio/inválido |
| `test/unit/epg-default.test.js` | fonte pública de EPG padrão no config, validação de URL, precedência M3U/Xtream/padrão/desligado, credenciais fora do estado/cache, allowlist |
| `test/integration/server.test.js` | servidor interno: `/api/admin/*` **403 sem tocar no upstream**, reescrita Origin/Referer/Host, Cookie repassado, Set-Cookie sem Domain/Secure, 401/403/502/timeout, Host inválido 400, traversal, `/_hosts`, `/_epg/source`, `/media-proxy` |
| `test/integration/media-epg.test.js` | EPG fim a ponta (`/_epg/source` gzip → parser → cache/TTL), MP4 idêntico e Range/206 |

Testes de núcleo compartilhado (não-regressão):

```text
node tools/test-m3u.js      -> M3U OK (4 canais, 1 filme, 1 série) + inválida + 100k itens
node tools/test-resume.js   -> TODOS OS 27 TESTES PASSARAM
node tools/test-health.js   -> TODOS OS 57 TESTES PASSARAM
```

## 2. E2E de UI no Electron real

Comando (runner via CDP, sem dependências; usa backend de teste local em
`127.0.0.1:8789` e a conta de teste isolada da branch Neon `desktop-tests`):

```powershell
node scripts/e2e-ui.js --electron <electron.exe> --shots --offline-proof
```

**Resultado: 35/35 verificações PASS** na execução final
(`--shots --offline-proof --with-autostart`). Evidências capturadas em `dist/desktop-shots/`:

| Verificação | Resultado |
|---|---|
| login real com a conta de teste (cookies HttpOnly no `session.defaultSession`) | PASS |
| sidebar na ordem exata, **sem "Administração"** | PASS |
| HUD com usuário; sem qualquer menção a admin | PASS |
| **palco preenche a janela**: `fill-stage`, `App.stageFit.fill=true`, sem faixas laterais | PASS (1350×681 → escala 0,703) |
| **layout compacto**: HUD encostado nas bordas (margem ~8px de projeto) e hints no fim da janela | PASS (HUD x=6..1344 em 1350; hints a 5,6px do fim) |
| mover o mouse sobre a grade **não rola sozinho** (`scrollTop` 0→0) | PASS |
| roda do mouse navega/rola a grade (0→1247) | PASS |
| **barra de rolagem visível** na grade (altura do polegar proporcional) | PASS |
| **arrastar a barra de rolagem** move a grade (1247→3355) | PASS (captura `16-barra-rolagem-filmes.png`) |
| importação M3U (mesmo parser da web) + catálogo | PASS |
| `#EXTM3U url-tvg` preservado (parser estendido) | PASS |
| EPG XMLTV via `/_epg/source` (host LAN no allowlist) | PASS |
| tela **Guia** com grade de programas + marca "Agora" | PASS (captura `07-guia-epg.png`) |
| TV ao vivo com "Agora/A seguir" e botão Guia | PASS (captura `02-tv-ao-vivo.png`) |
| Configurações com pasta de downloads/EPG/autostart | PASS (captura `08-configuracoes.png`) |
| Configurações com a ação **Fonte de EPG padrão** | PASS |
| **EPG público padrão** (EPGShare01 BR1 real): 215 canais / 22.644 programas em ~1,6–2,7 s | PASS |
| `tvg-id` com prefixo casa por alias (`SBT.br` → "Meu Coração é Teu") | PASS |
| captura do Guia com o EPG público real (`15-guia-epg-br1.png`) | PASS |
| **Iniciar com o Windows desligado por padrão** | PASS |
| autostart liga (Run key criada) e desliga (Run key removida) | PASS (`--with-autostart`) |
| download MP4 pelo fluxo da UI | PASS |
| download **HLS empacotado** (variantes 1080p/720p) | PASS |
| playlist HLS offline servida localmente | PASS (200, `#EXTM3U`) |
| reprodução offline do MP4 real (decodifica, `readyState=4`, 10,03 s) | PASS |
| **prova offline real**: Wi-Fi desconectado + mock provider e servidor de mídia parados | PASS (captura `13-player-offline-sem-internet.png`) |
| Wi-Fi reconectado depois do teste | PASS |
| exclusão remove os 2 downloads e os arquivos gerenciados | PASS |
| console do renderer sem erros inesperados | PASS |

### Prova offline (detalhe)

O E2E baixa um MP4 real (788.493 bytes) servido na LAN, desconecta o Wi-Fi
(`netsh wlan disconnect`) e **fecha** o mock provider e o servidor de mídia.
A reprodução abre `http://127.0.0.1:<porta>/offline/<id>/video.mp4`
(Range/206, arquivo local) com `navigator.onLine === false` e
`video.readyState === 4`, `duration ≈ 10,03 s`. Em seguida o Wi-Fi é
reconectado (o script só termina depois de confirmar a internet de volta).
Isso comprova: **download + reprodução offline não dependem do backend,
do Cloudflare nem de internet**.

## 3. Segurança / embalagem

```text
node scripts/check-secrets.js --dist  -> OK, 90 arquivos de texto, 0 segredo/escopo indevido
```

- sem `web/js/screens/admin.js` no renderer (build exclui);
- sem `.dev.vars`, `.env`, certificados, connection strings ou tokens no pacote;
- proxy interno só em `127.0.0.1`, nega `/api/admin/*` (403) e hospeda allowlist;
- CSP restritiva por header + meta, sem `unsafe-eval`;
- `contextIsolation`/`sandbox` ligados, `nodeIntegration` desligado, preload mínimo.

## 4. Instalador NSIS

```powershell
cd desktop; npm run dist
# -> dist/desktop/SpaceIPTV-Setup-1.0.0.exe
```

Instalação/desinstalação per-user (sem UAC) verificada nesta máquina com o
`.exe` copiado para `%TEMP%` (ver seção 5). A pasta de downloads **não** é
apagada no uninstall por padrão (há opção explícita).

### Evidência da execução

- Instalação silenciosa (`/S`): resultado, diretório instalado e atalhos na seção 5.
- App instalado abre e responde no servidor interno (`--smoke` do binário instalado).
- Desinstalação silenciosa: atalhos/autostart/cache removidos, pasta de downloads
  preservada.

## 5. Instalação limpa / desinstalação — evidência desta máquina

Executado a partir de `%TEMP%` (instalador copiado, como manda o ambiente).
Estado anterior de testes (instalação antiga apontando para uma pasta temporária)
foi removido antes — o teste abaixo é de uma instalação **limpa** per-user:

```text
instalador_sha256: 6b06f56066722806b955c9fb5857111e0740d5c53bcac8b456563456eb8e9123
instalador_bytes: 104091973

=== 0. estado limpo ===
run_space_iptv: (ausente)   run_space_iptv_desktop: (ausente)
registry_app: ausente       uninstall_key: (ausente)

=== 1. instalacao silenciosa (/S) ===
install_exit: 0
display_name: Space IPTV     display_version: 1.0.2     publisher: Space IPTV
install_dir: C:\Users\pedro\AppData\Local\Programs\Space IPTV   (per-user, sem admin)
app_exe: True                app_asar: True
shortcut_desktop: True       shortcut_startmenu: True
autostart_run_key_apos_install: (ausente)   <- desligado por padrão
downloads_registro: C:\Users\pedro\Videos\Space IPTV

=== 2. smoke do app INSTALADO ===
smoke_exit: 0
smoke_stdout: SPACE_SERVER=http://127.0.0.1:44002
smoke_stderr_erros: (nenhum)

=== 3. desinstalacao silenciosa (/S) ===
uninstall_exit: 0
install_dir_apos: removido        uninstall_key: removido
shortcuts: removidos              autostart: ausente
downloads_marker_preservado: True <- arquivo de teste em %USERPROFILE%\Videos\Space IPTV
downloads_pasta_preservada: True  <- requisito: não apagar downloads do usuário
appdata_cache_apos: False         <- cache/config do app removido
downloads_registro_apos: ausente
```

Observação: a **página "Pasta de downloads"** do instalador é a única parte que
exige interação (escolher pasta); em instalação silenciosa o padrão é usado e o
app lê o caminho do registro em `HKCU\Software\Space IPTV`. A escolha
interativa foi validada pela leitura do registro e pela lógica do
`installer/space-iptv.nsh` (a página roda antes do `instfiles` e grava a chave);
o teste acima confirma que o app usa o valor do registro.

## 6. Observações de ambiente (não são defeitos do produto)

1. **Electron 45.x crasha** nesta build do Windows 11 (26300) com
   `0xC0000005` mesmo em app mínimo; o projeto foi pinado em **40.6.0**, que roda.
2. O sandbox da sessão do agente **bloqueia executar binários de dentro do
   workspace** (Electron/Chromium → APPCRASH; o mesmo `.exe` copiado para fora
   roda). Por isso smoke/E2E usam `--electron <caminho externo>` e o instalador
   é executado de `%TEMP%`. Em uma máquina normal, `npx electron .` funciona.
3. O backend de teste usa `tools/pages-runner.js` contra a branch Neon
   isolada `desktop-tests` (dados de teste: `desktop.user@example.com` /
   `desktop.admin@example.com`). Credenciais em `desktop/test/tmp/env.json`
   (gitignored) — nunca versionadas. A branch pode ser apagada no console do Neon
   quando não for mais necessária.
4. Os fixtures de EPG próprios (`desktop/test/fixtures/xmltv-*`) usam data fixa;
   o mock provider de integração/E2E gera XMLTV relativo ao "agora" para o Guia
   cobrir a janela atual. O download do XMLTV tem **timeout total de 90 s**
   (fonte pública lenta não deixa o guia "carregando" para sempre).
5. **Fonte pública de EPG** (`EPGShare01 BR1`, `https://epgshare01.online/...`) é
   um serviço de terceiros, sem SLA; o app guarda cache (12/24/48 h) e o usuário
   pode trocar/desligar em Configurações. IDs do BR1 vêm prefixados
   (`São.Paulo/SP..SBT.br`); o app casa por alias (sufixo após `..`/`/`) e por
   nome normalizado — sem isso o `tvg-id="SBT.br"` não casaria (corrigido e
   coberto no E2E).
