# Space IPTV Desktop — Release

Checklist e comandos para gerar e publicar o instalador Windows.

## 1. Pré-requisitos

- Node 18+ e npm; `cd desktop && npm install`.
- Ícones (já versionados em `desktop/build/`; só regerar se o logo mudar):
  `python scripts/make-icons.py` (precisa de Pillow).
- Opcional: certificado de assinatura de código (`.pfx`) quando houver.

## 2. Build

```powershell
cd desktop
npm run build:renderer      # dist/renderer (tv/ + web/ sem admin + camada desktop)
npm test                    # suíte automatizada
node scripts/check-secrets.js --dist   # segredos/escopo do pacote
npm run dist                # ../dist/desktop/SpaceIPTV-Setup-<versao>.exe (NSIS x64)
```

Artefatos em `dist/desktop/` (fora do controle de versão, por decisão do repo):

| Arquivo | O que é |
|---|---|
| `SpaceIPTV-Setup-<versao>.exe` | instalador NSIS per-user x64 |
| `SpaceIPTV-Setup-<versao>.exe.blockmap` | delta para auto-update |
| `latest.yml` | manifesto do feed de atualização |
| `win-unpacked/` | build descompactado (usado no smoke e no instalador) |

### Checksums

```powershell
cd ..\dist\desktop
Get-ChildItem SpaceIPTV-Setup-*.exe | ForEach-Object {
  "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name
} | Set-Content SHA256SUMS.txt -Encoding ascii
```

## 3. Teste antes de entregar

1. `node scripts/e2e-ui.js --electron <electron.exe> --shots --offline-proof`
   (login real, importação M3U, EPG/Guia, download MP4+HLS, reprodução offline
   com Wi-Fi desligado, exclusão).
2. Instalação silenciosa e normal em uma máquina/VM limpa **sem admin**:
   - escolher a pasta de downloads no setup e conferir que ela é usada;
   - conferir atalhos (desktop/menu Iniciar), nome "Space IPTV" e versão no Sobre;
   - conferir que **Iniciar com o Windows** vem desligado;
   - desinstalar: atalhos/autostart/cache removidos e **pasta de downloads
     preservada**.
3. Ver `docs/TEST-REPORT.md` com o resultado da última execução.

## 4. Assinatura de código (quando houver certificado)

O build atual é **não assinado** e o SmartScreen mostra "Editor desconhecido"
(instrua o usuário a clicar em *Mais informações → Executar assim mesmo*).

Para assinar, basta exportar as variáveis antes de `npm run dist` — o
electron-builder detecta o certificado automaticamente:

```powershell
$env:CSC_LINK = "C:\caminho\space-iptv.pfx"       # ou base64 do .pfx
$env:CSC_KEY_PASSWORD = "senha-do-certificado"
npm run dist
```

Recomendado: EV Code Signing para reputação imediata no SmartScreen. Nunca
comitar o certificado.

## 5. Auto-update

Já preparado (`electron-updater` + feed no `electron-builder.yml`):

```yaml
publish:
  - provider: github
    owner: pedropaulodfr
    repo: space-iptv
    releaseType: release
```

Publicar (requer token com permissão de release, nunca no repositório):

```powershell
$env:GH_TOKEN = "<token>"
npm run dist
npx electron-builder --win --x64 --publish always   # envia .exe + latest.yml para o GitHub Releases
```

Regras:

- a versão do `package.json` define o nome e a comparação do update;
- o app só checa atualização quando está **empacotado** (não em dev);
- sem `GH_TOKEN` o build apenas empacota localmente, sem publicar;
- rollback = publicar uma versão maior com o build anterior.

## 6. Checklist final

- [ ] `npm test` verde (unit + integração; E2E separado).
- [ ] `check-secrets` OK (sem `.dev.vars`, tokens, connection strings).
- [ ] Sem `web/js/screens/admin.js` no pacote e `/api/admin/*` retorna 403.
- [ ] Instalador per-user instala/desinstala sem admin.
- [ ] Pasta de downloads escolhida no setup criada e gravada no registro.
- [ ] Autostart desligado por padrão; ligar/desligar e uninstall removem a entrada.
- [ ] Reprodução offline comprovada com a internet desligada.
- [ ] `SHA256SUMS.txt` gerado e publicado junto do `.exe`.
- [ ] README e TEST-REPORT atualizados.

## 7. Observações do ambiente de desenvolvimento desta entrega

- Esta máquina é Windows 11 build **26300**; o Electron **45.x crasha** nela
  (`0xC0000005`). O projeto usa **electron 40.6.0** (pinado no `package.json`).
- O sandbox da sessão do agente bloqueia executar binários de dentro do
  workspace — por isso o smoke/E2E usam um Electron copiado para fora
  (`--electron ...`) e o instalador é executado a partir de `%TEMP%`.
  Isso é particularidade do ambiente de desenvolvimento, não do produto.
