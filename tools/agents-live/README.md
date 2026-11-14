# agents-live — painel de execução dos agentes

Ferramenta **de desenvolvimento** (fora do app e do `dist/web`) para acompanhar o trabalho
multiagente em tempo real. Zero dependências: só Node.js e um navegador.

```
tools/agents-live/
  server.js    servidor estático + SSE em 127.0.0.1:8096
  index.html   painel
  app.js       EventSource + render (cards, timeline, grafo)
  style.css    tema Space Launcher (Orbitron/Inter de tv/fonts)
  report.js    CLI que cada agente chama para se reportar
  demo.js      cria 5 agentes fictícios para validar a UI
  state/       estado de execução (não versionado)
```

## Subir

```powershell
node tools/agents-live/server.js          # http://127.0.0.1:8096/
node tools/agents-live/server.js --port 9000
```

O bind é fixo em `127.0.0.1`; não há autenticação. Não exponha essa porta na rede.

Para validar a UI **antes** de disparar agentes reais:

```powershell
node tools/agents-live/demo.js            # 5 agentes fictícios, ciclo de 1,5 s
node tools/agents-live/demo.js --seconds 30
```

`Ctrl+C` (SIGINT/SIGTERM) remove os arquivos `demo-*` criados e limpa as linhas demo do
`state/events.ndjson`. Nada do demo deve sobrar no estado real.

## Reportar o trabalho

Cada agente chama a CLI ao começar, a cada passo relevante, ao bloquear e ao terminar (no
mínimo a cada 30 s enquanto trabalha):

```powershell
node tools/agents-live/report.js --agent player --role "Player web" --status working `
  --phase F2 --task "Integrando hls.js" --progress 40 --files web/js/player.js
```

Opções:

| Opção | Uso |
|---|---|
| `--agent` | slug do agente; vira `state/<slug>.json` (obrigatório) |
| `--role` | papel legível (ex.: `Player web`) |
| `--status` | `idle`, `working`, `blocked`, `done`, `error` |
| `--phase` | fase (`F0`…`F5`) |
| `--task` | tarefa atual, curta |
| `--progress` | inteiro 0–100 |
| `--files` | arquivo(s); repita ou separe por vírgula |
| `--note` | nota curta; **obrigatória** para `blocked`/`error` |
| `--list` | imprime o estado atual |
| `--remove --agent NOME` | remove o estado de um agente |
| `--remove` | remove todos os estados (não mexe em eventos) |

Regras de honestidade:

- `working` + `updatedAt` com mais de **30 s** mostra **sem sinal** em amarelo no card/grafo.
- `blocked` e `error` sempre levam `note` curta e acionável.
- `progress` reflete o momento; não invente porcentagem.
- `done` só com critério verificado pelo orquestrador.

## Estado e timeline

Um JSON por agente, escrita atômica (`tmp` + `rename`) em `state/<slug>.json`:

```json
{
  "agent": "player",
  "role": "Player web",
  "status": "working",
  "phase": "F2",
  "task": "Integrando hls.js",
  "progress": 40,
  "files": ["web/js/player.js"],
  "note": "",
  "startedAt": 1730000000000,
  "stateSince": 1730000000000,
  "updatedAt": 1730000123000
}
```

Cada chamada também acrescenta uma linha em `state/events.ndjson` (timeline). `startedAt` e
`stateSince` são preservados pelo `report.js`; `stateSince` muda quando o status muda.

`state/` está no `.gitignore`: é estado de execução, não código.

## Endpoints

| Rota | O que faz |
|---|---|
| `GET /` | painel (`index.html`) |
| `GET /app.js`, `/style.css` | UI |
| `GET /tv/*` | arquivos da raiz `tv/` (fontes/ícone) |
| `GET /events` | SSE `text/event-stream`; snapshot `{ agents, events, now }` + heartbeat 15 s |
| `GET /api/state` | mesmo snapshot em JSON (fallback/inspeção) |

O servidor lê `state/*.json` com `fs.watch` + debounce e fallback de polling a cada 500 ms.
O painel usa SSE; se cair, passa a consultar `/api/state` a cada 1 s e nunca fica em branco.

## Limites

- Sem autenticação e sem histórico persistente além de `events.ndjson`.
- O painel mostra o que foi reportado; **não** substitui teste, revisão nem relatório.
- Se o ambiente do agente não permitir rodar o CLI, o orquestrador reporta por ele nos marcos
  e diz isso no relatório final.
