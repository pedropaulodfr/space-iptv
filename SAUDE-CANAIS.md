# Saúde dos canais

Como o app descobre, sem abrir o canal, se ele está de pé — e como isso vira a bolinha
colorida que aparece ao lado de cada canal ao vivo.

- **Regra (compartilhada Tizen/Android):** [`tv/js/services/health.js`](tv/js/services/health.js)
- **Sondagem HTTP:** [`tv/js/api/http.js`](tv/js/api/http.js) → `App.http.probe`
- **Ponto na lista (Android):** [`mobile/js/ui.js`](celular/app/src/main/assets/mobile/js/ui.js) e [`mobile/js/screens/live.js`](celular/app/src/main/assets/mobile/js/screens/live.js)
- **Ponto na lista (Tizen):** [`tv/js/components/cards.js`](tv/js/components/cards.js) e [`tv/js/screens/browse.js`](tv/js/screens/browse.js)

---

## 1. O que o recurso responde

> "Neste instante, este canal está de pé?"

Ele **não** mede qualidade de imagem, não testa banda e não prevê buffering. Ele responde
uma pergunta binária — o servidor entrega um stream válido agora? — e acrescenta a latência,
que é o que diferencia "ótimo" de "aceitável".

O indicador aparece em todo item **ao vivo**: lista da TV, favoritos e cards da tela
inicial. Filmes e séries ficam de fora (o catálogo de VOD muda com frequência e o custo de
verificar tudo não se paga).

## 2. As duas fontes de informação

| Fonte | Quando entra | Peso |
|---|---|---|
| **Sondagem HTTP** (ativa) | quando o canal aparece na tela | define a cor na maior parte do tempo |
| **O próprio player** (passiva) | quando você abre o canal e ele toca (ou falha) | manda no indicador por **10 minutos** |

A segunda existe porque é o teste definitivo: se o vídeo abriu, o canal está bom, mesmo que
a sondagem HTTP tenha sido barrada pelo provedor.

## 3. Como é a sondagem (passo a passo)

```
canal na tela
   │
   ├─ já verificado há < 60 s? ......... usa o resultado em cache
   ├─ já existe verificação na fila? ... ignora (não duplica)
   │
   ├─ App.catalog.urls(canal)  →  [.m3u8, .ts] (Xtream) | [url] (M3U)
   │
   ├─ GET na 1ª URL, para no 1º byte
   │     ├─ HLS?  baixa até 64 KB do manifesto
   │     └─ TS/MP4?  aborta assim que o corpo começa
   │
   ├─ formato pelos bytes:  #EXTM3U = HLS · 0x47 = TS · ftyp = MP4 · '<' = HTML · vazio = suspeito
   │
   ├─ HLS: valida o manifesto, desce a 1ª variante (se for master)
   │        e testa o PRIMEIRO SEGMENTO  ← pega "playlist responde, vídeo não vem"
   │
   ├─ falhou? tenta a 2ª URL do canal
   │
   └─ classifica → grava o registro → emite 'health' no barramento → repinta os pontos
```

### Custo de cada verificação

- **1 requisição** para TS/MP4 (abortada no primeiro byte) e **2–3** para HLS
  (manifesto + segmento, mais a variante quando o manifesto é master).
- No máximo **64 KB** trafegados por verificação.
- Isso é o que permite deixar o recurso ligado por padrão.

### Limites e proteções

| Parâmetro | Padrão | Para quê |
|---|---|---|
| `timeout` | 8 s | servidor mudo não trava a fila |
| `retry` | 1 | nova tentativa 250 ms depois, só em timeout/erro de rede |
| `concurrency` | 3 | no máximo 3 sondagens simultâneas |
| `cache` | 60 s | mesmo canal não é re-sondado a cada rolagem |
| `maxQueue` | 80 | teto da fila (lista grande não vira ataque ao provedor) |
| `maxRecords` | 6 000 | teto de registros em memória (descarta os mais antigos) |
| `hlsSegment` | `true` | testar o primeiro segmento, não só o manifesto |

## 4. Quando roda (e quando não)

| Situação | Comportamento |
|---|---|
| Lista renderizada (Android) | verifica **as linhas visíveis**, à medida que a lista virtualizada as cria |
| Categoria ao vivo aberta (Tizen) | verifica as visíveis e **enfileira o resto da categoria** (limitado por `maxQueue`) |
| Player aberto | **pausa** — não compete com o stream que está tocando |
| Player fechado | **retoma** a fila que ficou parada |
| Troca de categoria | `cancel()` — descarta o lote anterior e aborta o que estava em voo |
| Conteúdo adulto / VOD | nunca (só `t === 'live'`) |
| Preferência desligada | **nenhuma requisição** e os pontos nem são desenhados |

No Android a verificação acompanha exatamente o que está na tela; no Tizen, ao entrar (ou
voltar) na categoria ao vivo, o resto do catálogo entra na fila — sempre com o teto de
`maxQueue`.

O interruptor é o **"Monitoramento da saúde dos canais"** em Configurações, ligado por
padrão (`App.store.get('healthOn', true)`). Desligar tem efeito imediato: aborta o que está
em voo, limpa a fila e esconde os pontos.

## 5. Como o resultado vira cor

A classificação é feita **em ordem** — o primeiro caso que casa vence:

| Situação | Cor | Texto |
|---|---|---|
| verificação abortada | — | não altera nada |
| provedor barrou a sondagem (`opaque`/CORS) | ⚪ cinza | "O provedor bloqueou a verificação (CORS)." |
| sem internet | 🔴 vermelho | "Sem conexão com a internet." |
| manifesto OK, 1º segmento falhou | 🟠 laranja | "O manifesto respondeu, mas o primeiro segmento falhou." |
| manifesto HLS inválido | 🟠 laranja | "O manifesto HLS não é válido." |
| timeout | 🟠 laranja | "O canal demorou demais para responder." |
| erro de rede | 🟠 laranja | "Não foi possível acessar o canal." |
| credenciais recusadas | 🟠 laranja | "O servidor recusou as credenciais da lista." |
| URL inválida na lista | 🟠 laranja | "A lista não forneceu um stream válido." |
| HTTP 401/403 | 🟠 laranja | "O servidor recusou o acesso (403)." |
| HTTP 404/410 | 🟠 laranja | "O canal não foi encontrado (404)." |
| outro erro HTTP | 🟠 laranja | "O servidor respondeu com erro 5xx." |
| resposta não parece vídeo (HTML/vazio) | 🟠 laranja | "A resposta não parece ser um stream de vídeo." |
| respondeu em ≤ 1 500 ms | 🟢 verde | "Respondeu em 320 ms." |
| respondeu em ≤ 4 000 ms | 🟡 amarelo | "Respondeu em 2 300 ms (latência moderada)." |
| respondeu acima de 4 000 ms | 🟠 laranja | "Respondeu em 6 100 ms (latência alta)." |

E duas regras que passam por cima:

- **Escalada para vermelho:** qualquer caso marcado como falha incrementa `failures`; com
  **2 falhas seguidas** (ou as 3 últimas verificações falhando) o canal vira 🔴 "Offline".
  Um sucesso zera o contador. 401/403 e `opaque` **não** contam como falha do canal — são
  recusa nossa, não dele.
- **Reprodução confirmada:** se o player tocou esse canal nos últimos **10 minutos**
  (`playbackWindow`), ele fica 🟢; 🟡 se demorou mais de **3 s** para começar
  (`playbackSlow`). Falha do player 2× → 🔴. O texto passa a ser "Reprodução confirmada
  recentemente.", que é honesto: é o teste que importa.

## 6. O que fica guardado por canal

Chave = `idDALista|live|idDoCanal`. Cada registro tem:

| Campo | Conteúdo |
|---|---|
| `state` / `label` / `detail` | cor, rótulo e explicação legível |
| `ttfb` | tempo até o primeiro byte (ms) |
| `status` / `code` / `kind` | HTTP, código interno do erro e formato detectado |
| `failures` / `lastOk` | falhas seguidas e último sucesso |
| `checkedAt` / `source` | quando e por quem foi verificado (`http` ou `player`) |
| `lastPlaybackAt` / `playbackState` | confirmação (ou falha) do player |
| `history` | últimas **5** verificações (ok, ms, status, code, kind) |

Tudo isso vive **em memória** — nada vai para o disco. Ao abrir o app, os canais aparecem
cinza e são verificados de novo. É intencional: saúde é informação do momento, e um
resultado de ontem mentiria sobre hoje.

## 7. Por que às vezes fica cinza

- **O canal ainda não foi verificado** (acabou de entrar na tela).
- **O provedor recusa requisição fora do player** (CORS), devolvendo `opaque`. Nesse caso
  não dá para afirmar nada — e cinza é melhor do que acusar "offline" um canal que toca
  normalmente no player.
- A verificação foi abortada (troca de categoria, monitoramento desligado).

## 8. Onde o ponto aparece

### Android
- `mobile/js/screens/live.js` → `App.health.observe(list, [item])` a cada linha renderizada.
- `mobile/js/ui.js` → desenha o `.hdot` no `channelRow` e repinta por `data-hkey` quando o
  barramento emite `health` (sem re-renderizar o card).
- `mobile/js/screens/home.js` → mesmo ponto nos cards da tela inicial.
- `mobile/js/player.js` → `pause()` ao abrir o player, `playback()` quando confirma/falha,
  `resume()` ao fechar.
- `mobile/js/screens/settings.js` → interruptor.
- Hoje o ponto é **informativo** no Android (sem toque para ver detalhes).

### Tizen
- `tv/js/screens/browse.js` → `observe` das linhas visíveis (e da categoria inteira ao
  entrar nela); a tecla **INFO** abre "Saúde do canal" com `App.health.detail(item)` — ou
  "Saúde dos canais" com a legenda, quando não há item focado.
- `tv/js/components/cards.js` → pintura do `.hdot`.
- `tv/js/player/player.js` → `pause`/`resume`/`playback`.

## 9. Ajuste fino (sem recompilar)

```js
// limites de latência e ritmo das verificações
App.health.configure({ green: 1200, yellow: 3000, timeout: 6000, concurrency: 2, cache: 120000 });

// diagnóstico rápido: quantos em cada estado, fila e paralelismo
App.health.stats();
// { green: 12, yellow: 3, orange: 1, red: 0, gray: 40, queued: 0, inflight: 0,
//   records: 56, paused: false, enabled: true, checking: false }

// textos prontos para exibir
App.health.legend();          // legenda das cores
App.health.detail(item);      // relatório de um canal
App.health.state(item);       // registro cru
```

Outros métodos úteis: `observe(lista, itens)`, `cancel()`, `pause()`, `resume()`,
`setEnabled(bool)`, `enabled()`, `idle()` (espera a fila esvaziar — usado nos testes) e
`reset()`. O barramento emite `health` (um canal mudou) e `health:config` (ligou/desligou).

> `health.configure()` só aceita chaves existentes em `DEFAULTS` e do mesmo tipo — nada de
> inventar campo novo em tempo de execução.

## 10. O que o recurso deliberadamente NÃO faz

- **Não baixa o vídeo.** Só o suficiente para provar que há stream.
- **Não verifica em massa no boot.** Isso derrubaria a lista e o provedor junto.
- **Não monitora continuamente.** É sob demanda (ao ver) com cache de 60 s — não é um
  painel de uptime.
- **Não julga qualidade** (bitrate, resolução, HDR) nem mede banda.
- **Não persiste entre sessões**, e por isso não guarda histórico longo.
- **Não acusa o canal quando o problema é nosso** (CORS, sem internet): cinza/vermelho com
  o motivo certo.

## 11. Como isso é testado

- **[`tools/test-health.js`](tools/test-health.js)** — 57 verificações no PC, com o `App`
  simulado: fila e concorrência (nunca mais de 3 em paralelo), cache de 60 s, cancelamento,
  falha isolada vs. repetida, CORS/`opaque`, timeout, HTTP 404/403, HLS com e sem segmento,
  reprodução confirmada vencendo a sondagem, interruptor (liga/desliga) e persistência da
  preferência.
- **[`tools/e2e.js`](tools/e2e.js)**, bloco "Saúde dos canais" — no app real, por CDP:
  monitoramento ligado por padrão, fila que esvazia (`App.health.idle()`), estados atribuídos
  aos canais da lista de teste (que inclui 403 e 404) e o interruptor desligando a
  verificação. O canal 404 existe justamente para provar a escalada para vermelho.

```powershell
node tools\test-health.js     # unitário, sem emulador
node tools\e2e.js             # ponta a ponta, com emulador + tools\mock-streams.js
```
