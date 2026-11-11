# Space IPTV — projeto Android

Versão Android (smartphones) do app IPTV. A lógica de negócio é a **mesma** do app
Samsung Tizen: o build copia `../tv/js` para `assets/js` em vez de manter uma cópia.

## Requisitos

- JDK 17 (`JAVA_HOME`)
- Android SDK com `platforms/android-36` e `build-tools/36.0.0`
- Gradle 9.8.2 (ou o wrapper, se presente)

O caminho do SDK fica em `local.properties` (`sdk.dir=...`).

## Compilar

```powershell
gradle -p celular :app:assembleDebug        # APK de depuração
gradle -p celular :app:assembleRelease      # APK de release (assinado)
```

Saídas:

```
celular/app/build/outputs/apk/debug/app-debug.apk
celular/app/build/outputs/apk/release/app-release.apk
```

## Assinatura

`build.gradle` lê `celular/keystore.properties` (fora do controle de versão):

```properties
storeFile=D:/caminho/spaceiptv-release.jks
storePassword=...
keyAlias=spaceiptv
keyPassword=...
```

Sem esse arquivo o build de release sai **sem assinatura** (o de depuração não é afetado).

## Instalar

```powershell
adb install -r celular\app\build\outputs\apk\release\app-release.apk
```

O `applicationId` de release é `app.spaceiptv.mobile`; o de depuração é
`app.spaceiptv.mobile.debug`, então os dois podem ficar instalados juntos.

## Testar

```powershell
# 1) streams IPTV locais de verdade (HLS, TS, MP4, Xtream, canais com erro)
node tools\mock-streams.js

# 2) instale o APK de depuração, abra o app e prepare o túnel de depuração
#    (com mais de um aparelho ligado, escolha pelo serial)
$env:ADB_SERIAL = "82a9a8e1"     # celular no USB, ou "192.168.0.6:5555" (projetor)
.\tools\cdp.ps1

# 3) suíte ponta a ponta (114 verificações: catálogo, reprodução, favoritos,
#    parental, saúde, persistência, MultiView, Xtream, TS, erros, Colar, controle)
node tools\e2e.js

# 4) a interface usa algo que a WebView do projetor não entende?
node tools\test-compat.js
```

Aparelho no **USB** (não alcança a máquina pela rede): `adb -s <serial> reverse tcp:8090 tcp:8090`
e rode com `MOCK=127.0.0.1:8090`. No **emulador**, `10.0.2.2` é a máquina host. Num aparelho na
**rede Wi-Fi** (projetor), use `HOST_IP=192.168.x.x` no servidor e `MOCK=192.168.x.x:8090`.

## Estrutura

- `app/src/main/java/app/spaceiptv/mobile/` — `MainActivity` (host da WebView),
  `NativeBridge` (ponte JS↔Java), `PlayerManager` (2 slots ExoPlayer), `SecretsStore` (Keystore)
- `app/src/main/assets/mobile/` — interface Android (HTML/CSS/JS)
- `celular/app/src/main/assets/js` e `assets/fonts` — **gerados** no build a partir de `../tv/`

## Notas de manutenção

- Mudou uma regra de negócio? Corrija em `tv/js` (a mesma usada pela TV). Nada a fazer no
  Android: o `syncTizenSources` copia no build.
- Mudou a interface? Só `assets/mobile/`.
- `usesCleartextTraffic="true"` e `setAllowUniversalAccessFromFileURLs(true)` são
  intencionais: equivalem ao `<access origin="*">` do Tizen e são o que permite falar com
  painéis IPTV que não mandam CORS.
- Durante a reprodução a página fica transparente, mas o fundo da **janela** continua opaco
  (`setWebTransparent` limpa só o WebView). Janela translúcida faz o Android parar de limpar o
  buffer entre quadros e sobra imagem antiga nas faixas pretas do vídeo. O vídeo é uma
  `TextureView` dentro da mesma janela, então aparece através da página transparente.
