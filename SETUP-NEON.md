# SETUP-NEON — login e administração do Space IPTV na Neon

Este documento substitui o antigo `SETUP-AUTH.md` (Supabase). A versão web usa
**Postgres na Neon** + **Cloudflare Pages Functions**; não há Supabase em lugar
nenhum.

## 0. O que já está pronto

| Item | Onde |
|---|---|
| Projeto Neon `space-iptv` (pg 17, `aws-sa-east-1`) | console.neon.tech — id `red-lake-26538811` |
| Schema aplicado (tabelas, RLS, RPCs) | `db/001_init.sql`, `db/002_last_sign_in.sql` |
| Migrador SQL por HTTP (zero dependências) | `tools/neon-migrate.js` |
| Auth próprio no edge (sessão + bcrypt) | `functions/_lib/*`, `functions/api/auth/*` |
| Sincronização por usuário | `functions/api/sync/*` |
| Administração de contas | `functions/api/admin/*` |
| Tela de login e tela de admin | `web/login.html`, `web/js/screens/admin.js` |
| Suíte de aceite | `tools/test-auth.js` (96 casos) |

## 1. Credenciais e variáveis

| Variável | Para que serve | Onde fica |
|---|---|---|
| `NEON_APP_URL` | conexão do papel **`space_app`** (DML apenas, RLS aplica) | `.dev.vars` local; secret no Pages |
| `AUTH_SECRET` | assina o token de acesso (HMAC-SHA256), mínimo 32 caracteres | `.dev.vars` local; secret no Pages |
| `NEON_DATABASE_URL` | conexão do **owner** (só migração/administração manual) | `.dev.vars` local (não vai para o Pages) |
| `AUTH_RECOVERY_ENABLED` | `false` (não há SMTP; reset é pelo admin) | opcional |
| `MEDIA_PROXY_HOSTS` | hosts/sufixos permitidos no `/media-proxy` (ex.: `tech-cdn.top`) | `wrangler.jsonc`/`.dev.vars` |

`AUTH_SECRET` pode ser gerado com:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 2. Aplicar o schema

```powershell
node tools/neon-migrate.js db/001_init.sql
node tools/neon-migrate.js db/002_last_sign_in.sql
```

O migrador lê `NEON_DATABASE_URL` do `.dev.vars`, divide o arquivo em instruções
(respeitando `$$` de funções) e aplica em lotes transacionais pelo endpoint
`https://<host>/sql`. Ele é idempotente (`create ... if not exists`, `drop policy
if exists`).

### 2.1 Definir a senha do papel de aplicação

O arquivo `db/001_init.sql` cria `space_app` como `nologin`. Escolha uma senha e
monte a URL:

```powershell
node tools/neon-sql.js "alter role space_app login password 'TROQUE-ESTA-SENHA'"
```

```
postgresql://space_app:TROQUE-ESTA-SENHA@<host-do-projeto>/neondb?sslmode=require
```

Esse valor é o `NEON_APP_URL`. O papel só tem DML nas tabelas do app; não cria
tabela, não lê schema alheio.

## 3. Criar o primeiro administrador

Cadastro público não existe: a primeira conta é criada por SQL, com a conexão
**owner**:

```powershell
node tools/neon-sql.js "insert into app_users (email, name, role, password_hash) values ('voce@exemplo.com', 'Pedro', 'admin', public.hash_password('uma-senha-forte-123'))"
```

Depois entre em `/login.html` com esse e-mail e senha. A partir daí, todas as
contas são criadas pela tela **Administração**.

## 4. Publicar no Cloudflare Pages

```powershell
node web/build.js
npx wrangler pages deploy
```

Cadastre em **Pages → Settings → Variables and Secrets** (Production **e** Preview):

- `NEON_APP_URL` (secret)
- `AUTH_SECRET` (secret)
- `AUTH_RECOVERY_ENABLED=false`

O `wrangler.jsonc` aponta `pages_build_output_dir` para `./dist/web`; o diretório
`functions/` fica na raiz e é compilado de lá.

## 5. Desenvolvimento local

```powershell
node web/build.js
node tools/pages-runner.js        # http://127.0.0.1:8788 com as Functions reais
# ou, com o runtime do Cloudflare:
npx wrangler pages dev
```

`node web/server.js` serve **só assets** (sem login) e avisa isso no console.

## 6. Testes

```powershell
node web/build.js
node tools/test-auth.js     # 96 casos contra o banco real (contas @e2e.local)
node web/smoke.js           # contrato do gate (302/200/401) + CSP
node web/smoke.js --static  # MIME/traversal/proxy do servidor estático
node tools/e2e-login.js     # Edge headless: login, admin, sync (capturas)
```

Os testes criam e apagam contas `@e2e.local` no banco do `.dev.vars`; nunca tocam
em contas reais.

## 7. Emergência: perder o último admin ou a senha

Com a conexão owner (`NEON_DATABASE_URL`):

```powershell
# devolver o papel de admin e reativar
node tools/neon-sql.js "update app_users set role = 'admin', disabled = false where lower(email) = 'voce@exemplo.com'"

# trocar a senha sem saber a atual
node tools/neon-sql.js "update app_users set password_hash = public.hash_password('senha-nova-forte-123') where lower(email) = 'voce@exemplo.com'"
```

Se você trocar a senha por SQL, revogue as sessões antigas:

```powershell
node tools/neon-sql.js "update app_sessions set revoked_at = now() where user_id = (select id from app_users where lower(email) = 'voce@exemplo.com')"
```

Sem a senha do owner: o console da Neon permite redefinir a senha do role ou
recriar credenciais; o schema e os dados continuam lá.

## 8. Segurança e janelas de revogação

| Ação | Efeito |
|---|---|
| **Desativar** conta | revoga todas as sessões na hora; o refresh para imediatamente; o token de acesso (15 min) expira sozinho |
| **Excluir** conta | cascata em listas, segredos, favoritos, histórico, preferências e sessões — não tem volta |
| **Redefinir senha** | revoga as sessões do alvo; a senha antiga deixa de funcionar na hora |
| **Trocar a própria senha** | exige a senha atual e derruba as outras sessões |

Camadas:

1. **Edge**: cookie `HttpOnly` + token HMAC verificado localmente (sem banco por
   requisição), CSRF por `Origin`/`Sec-Fetch-Site`, CSP, `no-store`.
2. **Banco**: papel `space_app` sem DDL e **RLS** em todas as tabelas, usando
   `app.uid`/`app.role` definidos na transação — um `where` esquecido não vaza
   linha de outro dono (testado).
3. **Administração**: guardrails no endpoint e na UI (não desativar/rebaixar/
   excluir a si mesmo; sempre ≥ 1 admin ativo) + auditoria de toda ação.

O admin **não** enxerga listas, favoritos ou histórico de ninguém: a policy de RLS
das tabelas de dados só libera `user_id = app.uid`, inclusive para o admin.

## 9. Checklist

- [ ] `NEON_APP_URL` e `AUTH_SECRET` no `.dev.vars` e nos secrets do Pages
- [ ] `node tools/neon-migrate.js db/001_init.sql` e `db/002_last_sign_in.sql` aplicados
- [ ] senha do papel `space_app` definida e `NEON_APP_URL` montada
- [ ] primeiro admin criado
- [ ] `node web/build.js` verde
- [ ] `node tools/test-auth.js`: 96 PASS
- [ ] `node web/smoke.js`: 15 PASS
- [ ] `npx wrangler pages deploy` publicado
- [ ] `https://space-iptv.pages.dev/` sem cookie → `/login.html?next=%2F`
