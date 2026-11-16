# Guia de programação (EPG) no Space IPTV Desktop

Este documento descreve de onde o aplicativo pega o guia de programação (EPG XMLTV),
qual é a **fonte pública padrão**, como trocar/desligar e quais são as limitações.

## Fonte pública padrão

Quando a lista ativa **não informa** um guia próprio, o app usa:

```
https://epgshare01.online/epgshare01/epg_ripper_BR1.xml.gz
```

- **O que é:** arquivo XMLTV comprimido (`.xml.gz`) com a programação de canais
  brasileiros, distribuído gratuitamente pelo projeto **EPGShare01**
  (<https://epgshare01.online/>). O agregador é mantido pela comunidade e gera os
  arquivos diariamente com WebGrab+Plus e scripts próprios.
- **Crédito e uso:** os dados são de propriedade dos respectivos emissores e são
  redistribuídos publicamente pelo EPGShare01. O próprio site pede uso **legal**
  ("free EPG for LEGAL use only") e não presta suporte a players ou provedores.
  O Space IPTV apenas baixa o arquivo como um cliente qualquer — não redistribui
  nem incorpora o conteúdo ao aplicativo.
- **Atualização:** o arquivo é regerado aproximadamente uma vez por dia (o
  `Last-Modified` do servidor é de hoje, 16/11/2026). O app baixa uma vez e guarda
  em cache por 12/24/48 h (padrão: 24 h).
- **Verificação realizada em 16/11/2026:** `HTTP 200`, `Content-Length: 900693`
  (~900 KB), gzip válido, **8,54 MB** de XML descomprimido, **266 canais** e
  **22.644 programas** lidos pelo parser do app (`epg-parse.js`) em ~0,7 s,
  cobrindo **16/11/2026 03:00 UTC → 20/11/2026 07:30 UTC**. Exemplos de `channel id`:
  `São.Paulo/SP..Globo.br`, `São.Paulo/SP..SBT.br`, `São.Paulo/SP..Record.br`,
  `São.Paulo/SP..Band.br`, `São.Paulo/SP..ESPN.br`, `São.Paulo/SP..CNN.Brasil.br`.

> Se o servidor do EPGShare01 ficar fora do ar ou bloquear sua rede/VPN, o app
> mostra um erro claro no Guia/cards e mantém o guia já baixado até o cache vencer.
> Você pode apontar para outra URL XMLTV em **Configurações → Fonte de EPG padrão**.

## Ordem de descoberta da fonte

1. **Lista M3U:** cabeçalho `#EXTM3U url-tvg="..."` (ou `x-tvg-url`). Se houver
   várias URLs separadas por espaço, o app usa a primeira `http(s)` válida.
2. **Lista Xtream:** `servidor + /xmltv.php?username=...&password=...`
   (as credenciais ficam só em memória; nunca vão para log, cache ou estado da UI).
3. **Fonte pública padrão:** `space.config.get().epgUrl` (esta URL, ou a que o
   usuário configurou). Só é usada se as opções 1 e 2 não fornecerem guia.
4. **Nenhuma fonte:** o estado do guia fica `'none'` ("Sem EPG nesta lista") e
   nada é baixado.

A origem escolhida aparece em `App.epg.state()`:

- `state.source` — URL ou rótulo **sem credenciais** (para Xtream: `servidor/xmltv.php`);
- `state.sourceKind` — `'list'` (M3U), `'xtream'` ou `'default'` (fonte pública).

O mesmo par é gravado no `meta` do cache do guia (`epg.meta.<listId>`).

## Como trocar ou desligar

Em **Configurações → Fonte de EPG padrão**:

- **Trocar:** cole uma URL `http://` ou `https://` de um XMLTV (`.xml` ou `.xml.gz`)
  e salve. O cache do guia da lista ativa é descartado e o app oferece baixar de novo.
- **Desligar:** deixe o campo em branco e salve. O app deixa de usar fonte pública;
  cada lista volta a depender só do `url-tvg`/`xmltv.php` dela.
- **Restaurar o padrão:** cole de volta a URL do EPGShare01 mostrada acima.

Regras de validação (em `src/main/config.js`):

- `epgUrl` vazio (`''`) = desligado;
- qualquer `http(s)` válido é aceito (query string preservada);
- `ftp://`, texto solto e valores acima de 2048 caracteres são recusados com a
  mensagem "A URL do EPG precisa começar com http:// ou https:// e ser válida.";
- valor inválido gravado à mão no `config.json` **não desliga** a fonte: o app
  volta ao padrão.

O host da fonte escolhida é registrado automaticamente na allowlist do servidor
interno (`registerMediaHosts`) antes do download — o proxy `/_epg/source` nunca
aceita host fora dessa lista.

## Cache e atualização

- O guia fica no IndexedDB local (`spaceiptv`/`kv`), em blocos, por lista:
  `epg.meta.<listId>`, `epg.idx.<listId>` e `epg.ch.<listId>.<i>`.
- TTL configurável em **Configurações → Cache do guia**: 12, 24 (padrão) ou 48 h.
- **Configurações → Atualizar guia agora** força o download imediato.
- Trocar a fonte de EPG descarta o cache da lista ativa antes de oferecer a atualização.

## Limitações conhecidas

- **Cobertura:** o BR1 cobre ~266 canais (TV aberta, fechada, esportes, notícias
  e alguns internacionais exibidos no Brasil). Canais regionais, locais e de
  provedores pequenos podem não estar na lista.
- **Casamento por `tvg-id`:** os IDs do EPGShare01 BR1 trazem prefixo de cidade/UF,
  por exemplo `São.Paulo/SP..SBT.br`. Listas com IDs simples (`SBT.br`, `Globo.br`)
  **não casam exatamente** por `tvg-id`; o app ainda tenta casar pelo
  `display-name` normalizado, o que também é limitado porque o nome do EPG inclui o
  prefixo ("São Paulo/SP SBT"). Na tela Guia, quando nenhum canal da lista casa, o
  app lista **os canais do próprio EPG** para que a grade continue visível; os
  cards "agora/a seguir" da TV ao vivo só aparecem para canais que casaram.
- **Nomes/descriptions:** vêm como o agregador publica; podem ter grafias
  inconsistentes e programas sem descrição.
- **Dependência de terceiro:** disponibilidade, bloqueio por VPN/região e mudanças
  de formato são responsabilidade do EPGShare01. O app valida o gzip e o XMLTV e
  mostra erro amigável quando o arquivo vem inválido/vazio.
- **Sem credenciais:** a fonte padrão é pública; listas Xtream continuam com as
  credenciais apenas em memória e nunca no estado/cache exibido na UI.

## Alternativas públicas (opcionais)

A URL de Configurações aceita qualquer XMLTV público, por exemplo projetos
comunitários como <https://i.mjh.nz/> (guias por país/região) ou repositórios
GitHub que publiquem XMLTV. Prefira fontes com atualização diária e licença/uso
claro; cobertura e IDs variam (o casamento continua dependendo de `tvg-id`/nome).
A fonte padrão do aplicativo continua sendo o EPGShare01 BR1 acima.

## Arquivos relacionados

- `desktop/src/main/config.js` — `DEFAULT_EPG_URL`, `epgUrl` no schema e validação.
- `desktop/src/renderer/js/epg/epg.js` — descoberta da fonte, allowlist e cache.
- `desktop/src/renderer/js/settings-desktop.js` — ação "Fonte de EPG padrão".
- `desktop/test/unit/epg-default.test.js` — testes do padrão, validação e fallback.
