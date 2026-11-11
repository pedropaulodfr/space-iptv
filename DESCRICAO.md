# Space IPTV — descrições prontas para uso

App: **Space IPTV 1.0** · Plataforma: **Samsung Smart TV (Tizen)** · Idioma: **português (Brasil)**
Todas as versões abaixo são fiéis ao que está implementado hoje (sem MultiView, que esta TV não suporta).

---

## 1. Chamada curta (tagline) — até ~80 caracteres

> **Space IPTV — suas listas M3U e Xtream na TV, com cara de app nativo.**

Alternativas:
- "Seu IPTV organizado, rápido e no controle remoto."
- "Canais, filmes e séries da sua lista, num só app para TV."

---

## 2. Descrição curta (vitrine / listagem) — ~200 caracteres

> O Space IPTV reproduz as listas IPTV que **você** já tem: canais ao vivo, filmes e séries em
> M3U (URL) ou Xtream Codes, com navegação 100% pelo controle remoto. O app não inclui canais
> nem conteúdo — só o player.

---

## 3. Descrição média (texto principal da loja) — ~900 caracteres

> **Space IPTV é o player de IPTV feito para assistir na TV, e não no mouse.**
>
> Cadastre sua lista M3U (por URL) ou sua conta Xtream Codes — servidor, usuário e senha — e o app
> organiza tudo em um só lugar: TV ao vivo com categorias, filmes, séries com temporadas e episódios,
> além de busca global, favoritos e "continuar assistindo".
>
> A navegação foi desenhada para o controle remoto: foco sempre visível, atalhos numéricos de 1 a 9
> para os nove canais favoritos, troca rápida entre os dois últimos canais e um player que reconecta
> sozinho quando o sinal cai.
>
> Pensando em quem divide a TV, há **controle parental com senha**: conteúdo adulto fica oculto e
> nunca é retomado automaticamente ao abrir o app. E para saber onde está o problema antes de abrir
> um canal morto, cada canal mostra um **indicador de saúde** (verde, amarelo, laranja, vermelho).
>
> O app **não inclui listas, canais ou credenciais**: você usa a lista do seu provedor.

---

## 4. Descrição longa (site / README / ficha completa)

### Space IPTV
Assistir IPTV na TV deveria ser simples: você tem uma lista, o app toca. O Space IPTV faz exatamente
isso — com a organização, os atalhos e o visual de um app feito para a sala, não para o desktop.

Feito para **Samsung Smart TV (Tizen)**, roda em tela cheia em 1920×1080, sem depender de teclado,
mouse ou celular. Tudo se resolve com as setas, o OK, o Voltar e as teclas coloridas do controle.

### Suas listas, do seu jeito
- **M3U por URL** e **Xtream Codes** (servidor + usuário + senha).
- Várias listas cadastradas, uma ativa por vez — troque quando quiser.
- Catálogo interpretado e guardado no aparelho: na próxima abertura ele aparece em segundos.
- Suporta listas grandes (testado com 88 MB / 317 mil entradas: 520 canais, 30 mil filmes e 8,4 mil séries).

### Organização que ajuda
- **TV ao vivo** com categorias, **Filmes** e **Séries** com temporadas e episódios.
- **Pesquisa** em toda a lista ativa e **Favoritos** por lista.
- **Continuar assistindo**: retoma filmes e episódios de onde pararam.

### Player de verdade
- Reprodução nativa (**AVPlay**) para HLS, TS, MP4 e MKV — o caminho mais compatível da TV.
- **Reconexão automática** quando o sinal cai e tentativa de URLs alternativas.
- Painel de canais durante o ao vivo, troca por CH+/CH− e controle de pausa/seek nos filmes.

### Atalhos de quem assiste muito
- **Teclas 1 a 9** abrem o 1º ao 9º canal favorito, de qualquer tela — com o número marcado no card.
- **Troca rápida (tecla AZUL)**: pula entre os dois últimos canais, sem passar pela lista.
- **Iniciar no último canal assistido**: opção que retoma o canal da última sessão (desligada por padrão).

### Controle parental
- Senha de 4 dígitos, digitada no controle.
- Conteúdo adulto é **oculto** da lista, dos favoritos e da busca enquanto estiver bloqueado.
- Regra fixa: **canal adulto nunca abre automaticamente**, nem com a retomada ligada.
- O acesso manual continua liberado com a senha.

### Saúde dos canais
- Ao entrar em uma categoria, o app testa a disponibilidade dos canais em segundo plano e marca cada
  um com uma bolinha: **verde** (respondeu rápido), **amarelo** (respondeu com latência), **laranja**
  (lento ou com erro), **vermelho** (falhou de forma repetida), **cinza** (não verificado).
- O resultado real da reprodução vale mais que o teste: se o canal tocou, ele fica verde.
- Tudo local, sem serviço externo, e pode ser desligado em Configurações.

### Privacidade
- Senhas de Xtream e URLs de M3U ficam **criptografadas no aparelho** (AES-GCM).
- Nada é enviado para servidores do app — ele não tem servidor, conta ou telemetria.
- Logs nunca mostram endereço completo, usuário ou senha.

### Importante
O Space IPTV **não fornece, não vende e não indica listas, canais ou assinaturas**. É um player: você
precisa de uma lista própria, fornecida pelo seu provedor, e é responsável por usá-la conforme a lei
e os termos do serviço contratado. Conteúdo adulto pode ser bloqueado por senha.

---

## 5. Palavras-chave (busca na loja)

`iptv` · `player iptv` · `m3u` · `xtream codes` · `lista iptv` · `tv ao vivo` · `filmes e séries` ·
`controle parental` · `samsung smart tv` · `tizen`

### Tags (3)

| # | Tag | Por que |
|---|---|---|
| 1 | **Player IPTV** | diz o que o app é (player, não provedor de conteúdo) |
| 2 | **Samsung Tizen** | diz onde roda — filtra quem procura app para Smart TV Samsung |
| 3 | **M3U e Xtream** | diz o que ele aceita — os dois formatos que o app lê |

Variantes de formato:
- Loja (texto livre): `Player IPTV`, `Samsung Tizen`, `M3U e Xtream`
- Tópicos técnicos (GitHub, minúsculas com hífen): `iptv-player`, `samsung-tizen`, `m3u-xtream`


---

## 6. Ficha técnica (para loja/site)

| Item | Valor |
|---|---|
| Nome | Space IPTV |
| Versão | 1.0 |
| Plataforma | Samsung Smart TV (Tizen 3.0+), perfil `tv-samsung` |
| Categoria sugerida | Vídeo / Entretenimento |
| Tamanho | ~475 KB |
| Resolução | 1920×1080 (Full HD) |
| Entrada | Controle remoto Samsung (D-Pad, OK, Voltar, coloridas, numéricas, CH+/CH−) |
| Conexão | Internet (para baixar a lista e os streams) |
| Conta/login | Não tem: usa a lista do usuário |
| Coleta de dados | Nenhuma |
| Classificação | Depende do conteúdo da lista do usuário; há controle parental com PIN |

---

## 7. Notas para publicação (Samsung)

1. **Sem conteúdo embutido**: o app não inclui listas nem canais — descreva-o sempre como *player*,
   nunca como "app de canais". Isso também evita recusa por direitos autorais.
2. **Certificado**: publicar/distribuir exige certificado Samsung (Certificate Manager + DUID da TV).
   Em modo desenvolvedor o perfil de teste já funciona.
3. **Controle parental**: deixar claro na ficha que existe PIN e que conteúdo adulto é bloqueado —
   costuma ser exigência para apps que exibem conteúdo de terceiros.
4. **MultiView**: não citar. Esta TV tem um único decodificador e o recurso não existe no app.
5. **Privacidade**: se a loja pedir política, a resposta é simples — o app não envia dados a servidores
   próprios; credenciais ficam criptografadas no aparelho.

---

## 8. Passo a passo do pacote para a Seller Office

A Seller Office **só aceita** `.wgt` assinado com **certificado Samsung** (autor Samsung + distribuidor
Samsung). O pacote gerado com o certificado público da Tizen instala em Modo Desenvolvedor, mas é
recusado no upload. Por isso existe um verificador: `tools\package-store.ps1`.

### 1) Criar o certificado Samsung (uma vez, no Tizen Studio)
1. Tizen Studio → **Tools → Certificate Manager** → **+** → **Samsung certificate** → **TV**.
2. Login com a conta Samsung do seller (quem publica faz isso; senha nunca deve ser compartilhada).
3. Marcar o **DUID** que aparece na lista. O DUID desta TV de teste é
   `uuid:3c5ad79c-bdf8-4458-8474-69bbeb09f8bd` (confira em `http://IP-DA-TV:8001/api/v2/` → `duid`).
4. Salvar com um nome, por exemplo **`SamsungTV`**.

### 2) Empacotar já com a verificação
```powershell
cd D:\Documentos\projects\IPTV-Tizen
pwsh tools\package-store.ps1 -Profile SamsungTV -Version 1.0.1
```
O script empacota em `dist\store\SpaceIPTV.wgt`, lê os certificados de dentro do `signature1.xml` e:
- se **não** for Samsung → renomeia para `*-nao-assinado-samsung.wgt`, explica e sai com erro;
- se for Samsung → mostra autor, distribuidor, tamanho e **SHA256** do pacote.

### 3) Subir na Seller Office
- Arquivo: `dist\store\SpaceIPTV.wgt`
- Ícone: `tv/icon.png` (512×512, já pronto)
- Capturas: **1920×1080**, pelo menos 4 (início, TV ao vivo com os indicadores de saúde, detalhes de série, configurações)
- Título e descrições: seções 1 a 3 deste arquivo
- Categoria: Vídeo/Entretenimento · Classificação: conforme o conteúdo das listas do usuário (há PIN)
- Observação obrigatória na ficha: **o app não fornece listas nem canais**

> A cada novo envio, aumente a `version` do `config.xml` (o `-Version` já faz isso).
> Se instalar o pacote assinado com Samsung na TV de teste por `sdb`, será preciso desinstalar antes
> (certificado diferente do atual) — o que apaga listas e favoritos salvos no aparelho.

