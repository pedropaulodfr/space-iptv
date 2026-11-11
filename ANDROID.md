# Space IPTV — versão Android (celular e projetor)

Portabilidade do app Samsung Tizen para Android, preservando a lógica de negócio.
O pacote Tizen (`tv/`, `dist/tv/*.wgt`) **não foi alterado**: as duas versões convivem.

- **APK de entrega:** gerado em `celular/app/build/outputs/apk/release/app-release.apk` (artefato de build, fora do repositório)
- **APK de depuração:** gerado em `celular/app/build/outputs/apk/debug/app-debug.apk`
- **Projeto:** [`celular/`](celular/) · instruções curtas em [`celular/README.md`](celular/README.md)
- **Rodar em projetor / TV box:** [`projetor/README.md`](projetor/README.md)

---

## 1. Estratégia de portabilidade

O app Tizen é uma aplicação web (HTML/CSS/JS) que roda num WebView e usa o AVPlay da
Samsung para vídeo. A portabilidade foi feita em **três camadas**, sem reescrever regras
de negócio:

| Camada | O que é | Como foi portada |
|---|---|---|
| **Negócio** (12 módulos, ~92 KB) | parser M3U, Xtream, listas, catálogo, favoritos/histórico, controle parental, retomada, saúde dos canais, TMDb (sinopses), HTTP, armazenamento | **Reaproveitada sem nenhuma alteração.** O Gradle copia os arquivos de `tv/js/` para os assets do APK no build (fonte única de verdade) |
| **Interface** (tela de TV) | `screens/`, `components/`, `navigation/`, `css/` | **Reescrita** para toque: abas inferiores, folhas deslizantes, listas virtualizadas, alvos de 48 dp |
| **Plataforma** | AVPlay, `tizen.*`, chave AES no localStorage | **Substituída** por ExoPlayer (Media3), `AndroidKeyStore` e ponte JS↔Java |

Duas decisões estruturais explicam todo o resto:

1. **Vídeo nativo atrás da página.** O ExoPlayer desenha numa `TextureView` que fica
   *atrás* da `WebView`; durante a reprodução a página fica transparente e desenha só os
   controles. É exatamente o modelo que o app Tizen já usava com o AVPlay (`html.playing`),
   então o mesmo raciocínio de layout vale nas duas plataformas. A `TextureView` (e **não**
   `SurfaceView`) é o que garante a ordem: `SurfaceView` é composta numa camada do próprio
   sistema e, dependendo do aparelho, sobe para cima da página — foi a causa de os controles
   do player sumirem atrás do vídeo na 1.0.0 (corrigido na 1.0.1).
2. **Adaptadores em vez de `if (android)`.** Os únicos pontos que dependiam da TV são
   trocados por adaptadores carregados antes das telas: `App.secrets` (Keystore),
   `App.ui.pinAsk/confirm/alert` (componentes de toque) e `App.m.player`. Nenhum arquivo
   compartilhado precisou de condicional.

## 2. Tecnologias e bibliotecas

| Item | Versão / escolha |
|---|---|
| Linguagem | Java 17 (sem Kotlin, para evitar mais um plugin no build) |
| Build | Gradle 9.8.2 + AGP 9.5.0 |
| SDK | `compileSdk 36`, `targetSdk 36`, **`minSdk 23`** |
| Vídeo | **AndroidX Media3 1.11.1**: `media3-exoplayer`, `-exoplayer-hls`, `-exoplayer-dash`, `-ui` |
| Interface | WebView do sistema (HTML/CSS/JS próprios, sem framework) |
| Segredos | `AndroidKeyStore` (AES-256/GCM) |
| Dependências totais | apenas as 4 do Media3 — nenhuma outra biblioteca externa |

`minSdk 23` (Android 6.0) foi escolhido porque gerar chave AES no AndroidKeyStore
(`KeyGenParameterSpec`) exige API 23; abaixo disso não haveria proteção real das
credenciais. Cobre praticamente todo o parque de aparelhos em uso.

## 3. Arquitetura final

```
celular/                          # projeto Android (o APK roda no celular E no projetor)
├── app/build.gradle              # minSdk/targetSdk, assinatura, sync da camada da TV
└── app/src/main/
    ├── AndroidManifest.xml       # só INTERNET; cleartext liberado (IPTV usa http)
    ├── java/app/spaceiptv/mobile/
    │   ├── MainActivity.java     # hospeda a WebView, insets, teclado, ciclo de vida, voltar
    │   ├── NativeBridge.java     # ponte JS↔Java (@JavascriptInterface "SpaceNative")
    │   ├── PlayerManager.java    # 2 slots de ExoPlayer, bounds em px, fallback de URL
    │   └── SecretsStore.java     # AES-GCM com chave no AndroidKeyStore
    ├── res/                      # tema, splash, ícones (gerados de tv/icon.png)
    └── assets/
        ├── js/                   # COPIADO de tv/js no build (10 módulos compartilhados)
        ├── fonts/                # COPIADO de tv/fonts
        └── mobile/               # interface Android
            ├── index.html
            ├── css/mobile.css
            └── js/{native,ui,focus,player,shell}.js + js/screens/{home,live,vod,favs,search,settings}.js
```

`focus.js` é a navegação por controle remoto (foco espacial, faixas e listas que rolam) — é
o que faz o mesmo APK ser usável no projetor. Detalhes em
[`projetor/README.md`](projetor/README.md).

Fluxo de uma reprodução:

```
toque no canal → App.parental.guard() → App.catalog.urls(item, lista, ep)   [regra compartilhada]
   → SpaceNative.playerOpen(slot, urls, live, startMs)                      [ponte]
   → ExoPlayer (HLS/DASH/MP4/TS, fallback .m3u8→.ts, reconexão 3×)
   → eventos {state, playing, progress, error} → window.SpacePlayer.onEvent  [JS]
   → controles, favoritos, histórico, saúde, retomada (tudo em JS compartilhado)
```

## 4. Funcionalidades preservadas e adaptadas

| Funcionalidade | Situação |
|---|---|
| TV ao vivo: categorias, busca, reprodução, troca de canal | preservada; lista com chips de categoria, busca instantânea e "◀ Canal / Canal ▶" no player |
| Favoritos | preservados; estrela em cada item e **área de acesso rápido 3×3** com os nove primeiros (o equivalente mobile das teclas 1–9 da TV) |
| Último canal assistido | preservado; preferência **desligada por padrão**, retomada uma única vez por sessão, **nunca em conteúdo adulto** |
| Saúde dos canais | preservado o mesmo serviço (fila, concorrência 3, cache 60 s, verde/amarelo/laranja/vermelho/cinza, interruptor ligado por padrão); indicadores aparecem na lista. Como funciona: [`SAUDE-CANAIS.md`](SAUDE-CANAIS.md) |
| Controle parental | preservado (PIN selado, filtro de catálogo/categorias/favoritos, `guard()` antes de abrir, desbloqueio só na sessão) |
| Configurações | preservadas (listas M3U/Xtream com credenciais seladas, ativar/atualizar/editar/excluir, retomada, monitoramento, limpar histórico, PIN, sobre, sair) |
| MultiView (2 canais) | **implementado** com dois ExoPlayer independentes: tela dividida ↔ janela em destaque, troca de áudio (um mudo por vez), fechar o 2º sem interromper o 1º |
| Filmes e séries | preservados; grade de pôsteres virtualizada, detalhes com sinopse e episódios (temporadas), retomada de posição |
| Credenciais | cifradas com chave no **AndroidKeyStore**; em aparelho cujo Keystore recusa criar chaves (o projetor HY300 é um), cai para uma chave AES local — nunca para texto puro. Ver [`projetor/README.md`](projetor/README.md) §7 |
| **Projetor / TV box** | **novo na 1.0.4**: trilha lateral em vez da barra inferior, alvos e fontes maiores, visual leve em aparelhos de 1 GB, modo automático (ou fixado em Configurações → Tela) |
| **Controle remoto (D-pad)** | **novo na 1.0.4**: setas navegam (foco espacial), OK confirma, Voltar sai, teclas de mídia controlam o player. Ver [`projetor/README.md`](projetor/README.md) §4 |
| **Colar link da lista** | **novo na 1.0.4**: botão que lê a área de transferência do Android, limpa o texto colado e sugere o nome da lista. Também nos campos do Xtream |

## 5. O que não foi reproduzido (e por quê)

| Item | Motivo |
|---|---|
| Animação de estrelas em canvas | trocada por gradiente + poeira estelar em CSS: mesma identidade visual com custo de GPU menor |
| Reprodução em segundo plano (Foreground Service) | não foi implementada de propósito: o pedido manda usar serviço em primeiro plano **só se houver necessidade real**. Ao sair do app o vídeo pausa (áudio não continua) |
| Picture-in-Picture do sistema | o MultiView é interno ao app; PiP do Android não foi usado para não competir com ele |
| Enviar o link do celular para o projetor pela rede | não implementado; hoje o "Colar" usa a área de transferência do próprio aparelho |

## 6. Arquivos criados e modificados

**Criados** (nada disso existia antes): `celular/` completo (4 classes Java, manifest,
recursos, `assets/mobile/**`), `dist/celular/*.apk`, `ANDROID.md`, `celular/README.md`,
`tools/android-icons.py`, `tools/mock-streams.js`, `tools/cdp.js`, `tools/cdp.ps1`,
`tools/cdp-shot.js`, `tools/e2e.js`.

**Modificados:** apenas `README.md` e `HANDOFF.md` (uma referência à versão Android).
**Nenhum arquivo do app Tizen foi alterado** — `tv/js`, `tv/css`, `tv/index.html` e
`tv/config.xml` continuam com as datas originais, e o empacotamento `.wgt` segue igual.

## 7. Requisitos de Android

- **Mínimo:** Android 6.0 (API 23), ARM de 32 ou 64 bits, 1 GB de RAM, ~10 MB livres.
  (O APK não tem código nativo, então instala em `armeabi-v7a` e em `arm64-v8a`.)
- **Recomendado:** Android 9+ (API 28) para melhor decodificação H.264/HEVC por hardware
  e para o comportamento de bordas/teclado do sistema.
- WebView atualizada (qualquer aparelho com Play Store atualiza sozinha). Em projetores
  sem loja a WebView pode ser de 2018 — por isso a interface não usa nada posterior ao
  Chrome 71 (ver [`projetor/README.md`](projetor/README.md) §8 e `tools/test-compat.js`).
- Rede: internet; fluxos HTTP simples e HTTPS. `usesCleartextTraffic` está ligado porque
  muitos provedores IPTV usam `http://` — sem ele, Android 9+ recusaria os streams.

**Aparelhos em que foi testado:** Galaxy J4 Core (Android 8.1 / API 27, 32 bits, modo
Go, 1 GB) e projetor HY300 (Android 9 / API 28, 32 bits, 1 GB, WebView 71).

## 8. Testes realizados

Test bed local gerado com ffmpeg ([`tools/mock-streams.js`](tools/mock-streams.js)):
listas M3U e API Xtream, HLS com playlist + segmentos, MPEG-TS contínuo (ao vivo), MP4
com `Range`, canal 404, canal 403, canal adulto e uma lista grande de 20 000 entradas.

**Automação:** [`tools/e2e.js`](tools/e2e.js) dirige a interface real (cliques no DOM,
via Chrome DevTools Protocol) e confere o estado — **122 verificações, todas passando**
em dois aparelhos: **Galaxy J4 Core** (Android 8.1 / API 27, 32 bits, modo Go) e
**projetor HY300** (Android 9 / API 28, WebView 71):

| Bloco | Verificações |
|---|---|
| Inicialização, ponte nativa, 5 abas | 6 |
| Selagem das credenciais (Keystore ou chave local), senha não fica em texto puro | 4 |
| Cadastro de lista pela interface, URL selada | 4 |
| Catálogo: 5 canais, 2 filmes, série com episódios, cache IDB | 6 |
| Telas: TV, filmes, séries, detalhes com episódios | 5 |
| Favoritos: numeração 1–9, acesso rápido | 4 |
| Reprodução HLS: toca, posição avança, duração | 5 |
| Controles: pausa, retomada, ajuste de imagem, liberação do player | 6 |
| Último canal e preferência | 3 |
| Controle parental: PIN, filtro de canal/categoria, bloqueio | 7 |
| Saúde: fila concluída, estados, interruptor | 4 |
| Persistência após reiniciar (listas, favoritos, PIN, catálogo, retomada) | 6 |
| Botão voltar: raiz, pilha de telas, player | 3 |
| Segurança: canal adulto não retoma sozinho, registro preservado | 4 |
| Xtream: credenciais, catálogo, URLs montadas, episódios, reprodução | 8 |
| MultiView: 2 streams, troca de áudio, layout, fechar o 2º | 5 |
| Canal TS contínuo, erro de canal fora do ar | 3 |
| Ícones do player, engrenagem de configurações e chips ao trocar de filme para canal | 6 |
| Barra de progresso preenchida até a posição e acompanhando o arrasto | 2 |
| Sinopses do TMDb: serviço (filme, série, título inexistente) e tela de detalhes | 4 |
| **Colar link**: botão no formulário, extração da URL, nome sugerido | 6 |
| **Controle remoto**: primeira seta no conteúdo, setas movem, anel visível, OK reproduz | 5 |
| **Setas em listas longas**: faixa de categorias rola, coluna da grade desce até o fim, foco não escapa | 8 |
| **Modo projetor**: classe `tv`, trilha lateral, conteúdo ocupando a tela, linha mais alta, volta ao modo celular | 5 |

Fora do e2e:

| Teste | O que cobre |
|---|---|
| `node tools\test-compat.js` | impede reintroduzir CSS/JS que a WebView do projetor não entende |
| `node tools\test-health.js` | 57 verificações da fila de saúde dos canais |
| `node tools\test-tmdb.js` | serviço de sinopses contra a API real |
| `node tools\clip.js "http://…"` | põe texto na área de transferência do aparelho para testar o "Colar" de verdade |

**Escala (lista de 3,0 MB / 40 000 linhas):** download + parse + índice em **7,0 s**;
15 000 canais e 6 categorias classificados; lista renderiza **12 linhas** no DOM (só a
janela visível), **5** depois de rolar até o fim; busca em **82 ms**; heap de **14 MB**.

**APK de release:** instalado e testado por toque — abre, cadastro da lista colando a URL,
lista carregada com indicadores de saúde, reprodução de vídeo em tela cheia com os
controles por cima, assinatura conferida com `apksigner`
(`CN=Pedro Paulo Franco, O=Space IPTV, C=BR`).

## 9. Limitações conhecidas

1. **Uma única lista ativa por vez** (igual à versão Tizen) — trocar de lista recarrega o catálogo.
2. **MultiView depende da GPU do aparelho**: decodificar dois H.264 ao mesmo tempo exige
   dois decodificadores. Se o segundo falhar, o app mostra um aviso e mantém o primeiro
   tocando — nunca quebra a reprodução normal. Testado no emulador; em aparelhos modestos
   o segundo canal pode não abrir.
3. **Sem reprodução em segundo plano** (áudio para ao sair do app).
4. **Sem cabeçalhos HTTP customizados**: igual à versão Tizen, o app usa a URL como vem da
   lista. Provedores que exigem `User-Agent` específico funcionam porque o player envia um
   UA de navegador (o mesmo truque que o AVPlay fazia).
5. **Conteúdo adulto** é detectado por heurística de nome (categoria/item/lista), igual à TV:
   lista que não usa termos reconhecíveis não é bloqueada automaticamente.
6. **Séries M3U** dependem de o provedor nomear episódios com `S01E01`; sem isso, os
   episódios aparecem como canais comuns (comportamento herdado do parser).

## 10. Como gerar e assinar

```powershell
# depuração
gradle -p celular :app:assembleDebug
# release assinado (lê celular/keystore.properties)
gradle -p celular :app:assembleRelease
# instalar
adb install -r dist/celular/SpaceIPTV-1.0.3-release.apk
```

A chave de assinatura **não está no projeto**: fica em
`D:\Documentos\projects\_iptv-backup\android-keystore\spaceiptv-release.jks`
(senha em `LEIA-ME.txt`, na mesma pasta) e é referenciada por
`celular/keystore.properties`, que está no `.gitignore`. Sem essa chave não é possível
atualizar o app já instalado — o Android exige a mesma assinatura.

## 11. Correções das versões 1.0.1 a 1.0.5

### 1.0.5 — setas em faixas e listas que rolam

No projetor, com o controle remoto: ao chegar na **última categoria visível** a seta
direita não fazia nada, e na **grade de filmes** a seta para baixo parava na última
linha visível. O mesmo valia para TV ao vivo e Séries.

| Problema | Causa | Correção |
|---|---|---|
| Seta morria na última categoria da faixa | a navegação só considerava itens **dentro da janela**; o chip seguinte, recortado pelo `overflow`, não era candidato | itens fora da tela voltam a ser candidatos e o `scrollIntoView` traz a faixa junto |
| Grade não descia além da primeira tela | as linhas de baixo estavam fora da janela ou ainda não existiam (lista virtualizada) | quando não há candidato, a camada rola o container um passo e tenta de novo |
| Seta direita pulava da categoria para o cartão de baixo / para a trilha | escolha só por distância: um item deslocado e um pouco mais perto vencia | quem está **alinhado** (mesma faixa/coluna) tem preferência |
| Abrir uma tela poderia rolar a página sozinho | idem | o foco inicial continua preferindo o que já está à vista |

Validado no harness (`tools/harness.ps1`) com 12 categorias e 60 filmes: 12 passos
para a direita percorrem a faixa inteira rolando, 11 passos para baixo percorrem a
coluna inteira rolando a grade. Virou o bloco 23 do `tools/e2e.js`.

### 1.0.4 — projetor HY300, controle remoto e "Colar"

Pedido: fazer o app rodar num projetor Android (HY300: Android 9, 32 bits, 1 GB,
1024×600, WebView Chrome 71) e permitir colar o link da lista com facilidade.

**A WebView de 2018 era o problema maior.** No primeiro teste no aparelho o
`#app` media 898×953 em vez de 1024×600: `inset: 0` não existe no Chrome 71, então
a casca encolhia e a barra de abas ia para fora da tela. O CSS foi reescrito sem
`inset`, `aspect-ratio`, `min()/clamp()` e `gap` de flexbox — e `tools/test-compat.js`
passou a barrar esses recursos.

| Problema | Causa | Correção |
|---|---|---|
| Casca do app fora de tamanho, abas invisíveis | `inset: 0` ignorado no Chrome 71 | `top/right/bottom/left` explícitos |
| Cartões de canal e pôsteres com 500 px de altura | `padding-bottom` percentual dentro de `flex` é calculado sobre a **largura do container** | a caixa 2:3 virou um filho bloco (`.frame`) |
| Nada selecionável com o controle | não havia navegação por teclado, e a `WebView` nascia sem foco | `js/focus.js` (foco espacial) + `requestFocus()` na Activity |
| Anel de foco sumia sozinho | as telas se redesenham (catálogo, saúde) e o nó focado era descartado | vigilância de 500 ms devolve o anel ao item mais próximo |
| Foco preso no botão de pesquisa / no campo de busca | ordem do DOM começa na barra de cima | primeira seta nasce no conteúdo; campos ficam por último; busca não abre o teclado no projetor |
| Folha do player ficava aberta por cima da tela seguinte | trocar de tela não fechava camadas | `shell.mount()` e `player.close()` esvaziam a pilha de diálogos |
| Botão "Colar" nunca alcançado pela seta ▼ | ficava ao lado do campo | no projetor ele vai para baixo do campo |
| Senha do Xtream gravada em base64 | o Keystore do HY300 responde `ProviderException` | chave AES local (`l1:`) antes de cair no base64 (`p0:`) |
| Interface pesada em 1 GB / Mali-G31 | brilhos, sombras e camadas extras | classe `html.low` desliga o que é enfeite e reduz buffer/sondagens |

**Colar link.** O campo de URL ganhou um botão que lê a área de transferência pelo
lado nativo (`SpaceNative.clipboard()`), extrai a URL de um texto colado com conversa
em volta, preenche o nome com o domínio e, na primeira lista, já abre a tela inicial.
Está também nos campos do Xtream.

Detalhes de comportamento, teclas e limites: [`projetor/README.md`](projetor/README.md).

### 1.0.1 — ícones e ordem das camadas

Três problemas relatados depois da 1.0.0 — todos reproduzidos no emulador antes de
corrigir e verificados depois:

| Problema | Causa | Correção |
|---|---|---|
| O ícone de configurações parecia "alternar claro/escuro" | o desenho era um **sol** (círculo + 8 raios) | engrenagem de verdade (aro denteado + eixo), no mesmo estilo de traço dos outros ícones |
| Alguns botões do player sem ícone (voltar, canal anterior/próximo, ±10 s) | o HTML nascia com os botões vazios e o JS só preenchia play/pause e a estrela | `initIcons()` preenche os cinco no boot do módulo; ±10 s ganharam seta circular |
| Controles, título e barra de progresso **atrás** do vídeo | o vídeo era uma `SurfaceView`, que o sistema compõe numa camada própria e, nesta combinação de janela translúcida + Android 16, fica **acima** da `WebView` | o vídeo passou a ser `TextureView` (uma View comum, sempre abaixo da `WebView`), ver `res/layout/player_view.xml` |
| Faixas pretas do vídeo mostravam a tela anterior (fantasma) | janela translúcida: o Android para de limpar o buffer entre quadros | a janela voltou a ser **opaca**; o que fica transparente é só o WebView (`setWebTransparent`) |

Corrigido junto um bug latente que só aparecia em sequência: `paintHeader()` procurava o
chip "Canais", que só existe quando há canal ao vivo — abrir um canal **depois de um filme**
estourava e deixava os chips do player vazios. Agora a busca é restrita aos botões fixos e
tolera elemento ausente (há verificação automatizada para isso).

Os três modos de imagem continuam funcionando com `TextureView` (Ajustar / Preencher /
Esticar, conferidos por captura de tela) e o MultiView segue com dois vídeos simultâneos.

### 1.0.2 — preenchimento da barra de progresso

A trilha do `input[type=range]` tinha **fundo cinza fixo**: o indicador azul andava, mas
nada ficava preenchido atrás dele. O preenchimento agora é um gradiente na própria trilha
(`::-webkit-slider-runnable-track`) com parada em `--p` (0..1) — azul→roxo até a posição,
cinza no restante.

`--p` é derivado do **valor do próprio input**, então acompanha a reprodução, o arrasto do
dedo e os botões de ±10 s sem duplicar cálculo. O cálculo do tempo, a duração e a posição
do indicador não mudaram: o indicador e o preenchimento sempre terminam no mesmo ponto.

### 1.0.3 — sinopses do TMDb (e filmes que não abrem)

**Sinopses.** Lista M3U praticamente nunca traz sinopse e o Xtream só manda quando o painel
tem o campo preenchido. Agora, quando a tela de detalhes não tem texto do provedor, ela
consulta o TMDb — [`tv/js/services/tmdb.js`](tv/js/services/tmdb.js), módulo
**compartilhado com a TV** (mesmo arquivo, mesmas regras):

- limpa o nome do arquivo (`Oppenheimer (2023) 1080p DUBLADO` → `Oppenheimer`);
- busca em pt-BR e cai para en-US quando não há tradução;
- aceita apenas resultado com título compatível (e ano próximo, quando existe): título
  desconhecido devolve **nada** em vez da sinopse de outro filme;
- preenche sinopse, pôster, nota e ano **só onde a lista não trouxe** — texto do provedor
  sempre tem prioridade;
- cache de 30 dias em `localStorage` + cache de sessão, no máximo 2 requisições em paralelo:
  cada título custa no máximo duas requisições na vida.

A chave (v3, somente leitura) fica em `tmdb.js` porque o app não tem servidor próprio. Para
trocar sem recompilar: `App.tmdb.setKey('...')`; o token v4 também é aceito
(`App.tmdb.setToken('eyJ...')`, enviado no header `Authorization`).

**"O servidor demorou demais para responder" em filmes.** `movieUrls`/`episodeUrls` agora
devolvem **duas** URLs (a extensão do catálogo e a alternativa mp4↔mkv): painel que informa
`container_extension` errado costuma deixar a conexão pendurada em vez de devolver 404. Se o
primeiro formato falhar, o player tenta o outro antes de desistir. A mensagem de falha passou
a diferenciar canal de filme e a mostrar o detalhe técnico do erro.

