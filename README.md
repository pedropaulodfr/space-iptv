# Space IPTV

Player de listas IPTV (**M3U por URL** e **Xtream Codes**) com o visual do Space Launcher
Design System, feito para rodar em **três tipos de aparelho**. O app não traz nenhuma lista,
canal ou credencial: só reproduz o que o usuário cadastra.

| Pasta | Projeto | O que roda |
|---|---|---|
| [`tv/`](tv/) | **TV Samsung (Tizen)** | app web Tizen (JavaScript puro, sem build) |
| [`celular/`](celular/) | **Celular Android** | projeto Gradle → **um APK** que também roda no projetor |
| [`projetor/`](projetor/) | **Projetor / TV box** | documentação do modo projetor (HY300), capturas e como testar |
| [`tools/`](tools/) | ferramentas de desenvolvimento | servidor de streams de teste, bateria ponta a ponta, harness no navegador |
| `dist/` | artefatos gerados (APK/WGT) | **fora do controle de versão** — veja "Gerar os pacotes" |

**Celular e projetor usam o MESMO APK**: o app detecta a tela (largura, memória, WebView) e
escolhe o modo — trilha lateral + controle remoto no projetor, abas + toque no celular. Dá
para fixar em **Configurações → Tela**.

## A camada de negócio é uma só

`tv/js` é a fonte única de verdade (parser M3U, Xtream, catálogo, listas, favoritos,
histórico, controle parental, retomada, saúde dos canais, sinopses do TMDb). O build do
Android copia esses arquivos para os assets do APK (`syncTizenSources`) em vez de manter
cópia. **Corrigiu um bug de regra de negócio? Corrija em `tv/js` e as três versões ficam
certas.**

```
tv/          app Tizen completo (o `js/` é compartilhado com o Android)
celular/     projeto Android (Java 17 + AGP + Media3/ExoPlayer) → APK
projetor/    modo projetor: o que muda, teclas do controle, capturas
tools/       servidor de teste, e2e, harness, empacotamento Tizen
```

## Gerar os pacotes

**Android** (celular + projetor, um APK):

```powershell
gradle -p celular :app:assembleDebug      # dist (build/outputs/apk/debug)
gradle -p celular :app:assembleRelease    # assinado, lê celular/keystore.properties
adb install -r celular\app\build\outputs\apk\release\app-release.apk
```

**Tizen** (a TV), com o Tizen Studio instalado e um perfil de certificado:

```powershell
pwsh tools\package.ps1                    # empacota e instala na TV de desenvolvimento
pwsh tools\package-store.ps1 -Profile SEU_PERFIL   # pacote para a Samsung Store
```

Os APK/WGT gerados não vão para o repositório (`.gitignore`): são artefatos de build.

## Versões e documentação

- **Android**: [`celular/README.md`](celular/README.md) (como compilar, assinar e testar) e
  [`ANDROID.md`](ANDROID.md) (arquitetura, decisões, histórico das versões).
- **Projetor**: [`projetor/README.md`](projetor/README.md) — trilha lateral, setas/OK,
  botão **Colar** no campo de URL, visual leve para 1 GB de RAM e limites da WebView Chrome 71.
- **Saúde dos canais** (bolinha colorida): [`SAUDE-CANAIS.md`](SAUDE-CANAIS.md).
- **Estado do projeto / próximos passos**: [`HANDOFF.md`](HANDOFF.md).

## TV de desenvolvimento

- Samsung 5 Series 43" `UN43T5300AGXZD` (Tizen, linha 2020), IP `192.168.0.13`.
- O `sdb` só conecta do IP cadastrado no Modo Desenvolvedor da TV (hoje `192.168.0.11`).
- **MultiView (duas janelas ao vivo) não é suportado por esta TV**: o Tizen 5.5 tem um único decodificador de vídeo e não oferece `IN_APP_MULTIVIEW` (recurso do Tizen 7.0+). A funcionalidade foi removida do app; no lugar dela existe a **TROCA RÁPIDA** na tecla AZUL.

### Como instalar na TV

1. Na TV: Apps → digite `12345` → Developer mode **On** → *Host PC IP* = IP deste PC (hoje `192.168.0.9`) → reiniciar a TV.
2. Certificado: Tizen Studio → Certificate Manager → criar perfil **Samsung** (login Samsung, marcar o DUID da TV). Sem ele a TV recusa o pacote.
3. Empacotar e instalar (troque `SEU_PERFIL`):
```bash
sdb connect 192.168.0.13
tizen package -t wgt -s SEU_PERFIL -o dist/tv -- tv
tizen install -n "Space IPTV.wgt" -t UN43T5300AGXZD -- dist/tv     # ou: sdb install
tizen run -p SpcIptv001.SpaceIPTV -t UN43T5300AGXZD
```

## Estrutura do app da TV (`tv/`)

| Pasta | Conteúdo |
|---|---|
| `js/core` | namespace, utilidades, logs com redação de credenciais, fundo de estrelas |
| `js/storage` | localStorage, IndexedDB (catálogo em cache), segredos AES-GCM |
| `js/api` | `http.js` (timeout/erros), `xtream.js` (player_api.php) |
| `js/parser` | `m3u.js` (tolerante, classifica live/filme/série, agrupa episódios) |
| `js/services` | listas, catálogo (índices e busca em memória), favoritos e histórico |
| `js/navigation` | teclas do controle remoto, toque longo no OK, pilha de camadas |
| `js/components` | lista virtualizada, cards, faixa horizontal, modais/formulários |
| `js/player` | AVPlay (Samsung) com fallback HTML5, reconexão, seek, painel de canais |
| `js/screens` | início, TV/filmes/séries, pesquisa/favoritos, detalhes, configurações |
| `css` | `design-system.css` (tokens) e `app.css` |

## Decisões

- **AVPlay primeiro** (`webapis.avplay`): é o caminho nativo e mais compatível para HLS/TS/MP4/MKV na Tizen. HTML5 `<video>` só se o AVPlay não existir.
- **No Android**: ExoPlayer (Media3) numa `TextureView` **atrás** da WebView, com a página transparente — mesmo modelo do AVPlay na TV.
- **Live Xtream**: tenta `.m3u8`, depois `.ts`. Reconecta até 3 vezes antes de mostrar erro.
- **Virtualização**: só as linhas visíveis existem no DOM; imagens só carregam perto do foco.
- **Vidro (blur)** só em painéis grandes. Nos cards usa fundo translúcido sem `backdrop-filter`, por custo de GPU.
- **Segredos**: senha Xtream e URL M3U são salvas com AES-GCM. Na TV a chave fica no armazenamento privado do app; no Android vai para o AndroidKeystore (com reserva de chave local em aparelho cujo Keystore é quebrado, como o projetor HY300).
- **Favoritos/histórico** ficam atrelados ao ID da lista de origem.
- **Controle parental**: PIN de 4 dígitos (selado com AES-GCM) esconde canais/filmes/séries adultos e pede a senha para liberar. A detecção é por palavra-chave no nome da categoria, do item ou da lista (xxx, adulto, porn, erótic, sexo, +18, 🔞); lista com nome adulto fica inteira oculta. O desbloqueio vale só para a sessão. Em **Configurações → 🔒 Controle parental**.
- **Iniciar no último canal assistido**: opção **desligada por padrão** em Configurações. Quando ligada, ao abrir o app ele reproduz o último canal visto — guardado por **id do canal + id da lista** (`sl.lastCh`), nunca por nome ou posição. Canal adulto **nunca** é retomado automaticamente (regra que vence a preferência), mas o registro é preservado e o acesso manual continua pedindo a senha do controle parental.
- **Saúde dos canais**: ao abrir uma categoria de TV ao vivo, o app verifica os canais em segundo plano (3 por vez, timeout 8 s, cache de 60 s) e mostra uma bolinha no logo: verde ≤1,5 s, amarelo ≤4 s, laranja (lento/erro/formato), vermelho após 2 falhas seguidas, cinza = não verificado ou bloqueio de CORS. O resultado real da reprodução prevalece (verde). **INFO** mostra os detalhes do canal focado; a fila pausa enquanto um canal está tocando. Pode ser desligado em **Configurações → Monitoramento da saúde dos canais** (liga por padrão; desligado não faz requisições, cancela a fila e esconde os indicadores). Como funciona por dentro: [SAUDE-CANAIS.md](SAUDE-CANAIS.md).

## Listas grandes

- M3U é baixado em fluxo (`fetch` + `ReadableStream`, reserva XHR binário) e interpretado em pedaços; o arquivo nunca vira um texto único.
- Episódios de séries M3U ficam em blocos separados no IndexedDB (`eps.<lista>.<n>`) e só são lidos ao abrir a série.
- Medido na TV (T5300, Tizen 5.5) com 88 MB / 317 mil entradas (520 canais, 30 mil filmes, 8,4 mil séries): carga ~85 s, abrir série ~120 ms, pesquisa ~120 ms, início a frio com cache 1 s (tela) e ~5 s (catálogo).
- **Google Drive não serve a TV**: responde HTTP 500 ao User-Agent "SMART-TV; Tizen", que o app não pode trocar. Hospede a lista em outro lugar.

## Atalhos

Exit (código 10182, registrado via `tvinputdevice`) abre "Deseja fechar o Space IPTV?"; em "Ficar" a TV não leva o usuário ao Samsung TV Plus. O que a TV abre ao ligar não é controlável pelo app (use "Executar último app automaticamente" nos ajustes da TV).
OK = selecionar (segurar OK ou tecla amarela = favoritar) • Voltar • ◀▶▲▼ • Play/Pause/FF/RW • CH+/CH− troca canal • Info mostra controles.
**Teclas 1 a 9** abrem o 1º…9º canal favorito da lista ativa — funcionam de qualquer tela (inclusive durante a reprodução) e o número aparece numa bolinha no card do canal.

## Testes

- `node tools/test-m3u.js`: parser (aspas, EXTGRP, BOM, CRLF, séries, lista inválida, 100 mil itens).
- `node tools/test-resume.js`: retomada do último canal (padrão desligado, persistência, canal ausente, adulto bloqueado, inicialização única).
- `node tools/test-health.js`: saúde dos canais (fila/concorrência, cache, cancelamento, falha isolada vs. repetida, CORS, timeout, HTTP 404/403, HLS com e sem segmento, integração com o player, interruptor ligado/desligado e persistência).
- `node tools/test-tmdb.js`: serviço de sinopses contra a API real do TMDb.
- `node tools/test-compat.js`: garante que a interface do APK não usa nada que a WebView do projetor (Chrome 71) não entenda.
- `node tools/e2e.js`: bateria ponta a ponta no aparelho Android (**122 verificações**), com `node tools/mock-streams.js` no ar.
- `.\tools\harness.ps1`: abre a interface do APK no navegador da máquina (1024×600, modo projetor) para testar layout e setas **sem aparelho**.
- `node tools/mock-server.js`: servidor **só de desenvolvimento** (porta 8080) que serve o app da TV e imita Xtream (usuário/senha `test`), para testar a interface no navegador.
