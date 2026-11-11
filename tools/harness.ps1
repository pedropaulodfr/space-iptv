# DESENVOLVIMENTO: abre a interface do APK no navegador, na mesma janela do projetor,
# sem precisar de aparelho nenhum.
#
# Serve para testar layout e navegação por controle remoto quando os aparelhos estão
# ocupados. Ele monta uma cópia dos assets (mobile + js compartilhado + fontes) com um
# `SpaceNative` falso que se apresenta como o HY300 (low-ram, 1024x600, sem toque),
# então o app entra no modo projetor de verdade.
#
# Uso:
#   .\tools\harness.ps1                 # porta 9333, 1024x600
#   .\tools\harness.ps1 -Width 360 -Height 740   # jeito celular
#
# Depois, no outro terminal:
#   $env:CDP_PORT = "9333"; node tools\cdp.js "..."
#
# O que NÃO funciona aqui: reprodução de vídeo (não há ExoPlayer) e a área de
# transferência real (o stub devolve texto fixo).
param(
  [int]$Port = 9333,
  [int]$Width = 1024,
  [int]$Height = 600,
  [switch]$Touch,
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dst = Join-Path $env:TEMP 'spaceiptv-harness'
$perfil = Join-Path $env:TEMP 'spaceiptv-harness-perfil'

if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Force $dst | Out-Null

Copy-Item -Recurse (Join-Path $root 'celular\app\src\main\assets\mobile') (Join-Path $dst 'mobile')
Copy-Item -Recurse (Join-Path $root 'tv\js') (Join-Path $dst 'js')
Copy-Item -Recurse (Join-Path $root 'tv\fonts') (Join-Path $dst 'fonts')

# Ponte nativa falsa: mesmo contrato do NativeBridge, respostas fixas.
$stub = @'
<script>
/* HARNESS: faz as vezes do NativeBridge (não existe fora do APK). */
(function () {
  var info = { version: '1.0.5-harness', model: 'harness HY300', sdk: 28, density: 1,
               platform: 'android', lowRam: true, touch: __TOUCH__, refresh: 55, heap: 128 };
  var clip = '';
  window.SpaceNative = {
    info: function () { return JSON.stringify(info); },
    insets: function () { return JSON.stringify({ top: 0, bottom: 0, left: 0, right: 0, ime: 0 }); },
    seal: function (t) { return 'h1:' + btoa(unescape(encodeURIComponent(String(t)))); },
    open: function (s) { try { return decodeURIComponent(escape(atob(String(s).slice(3)))); } catch (e) { return ''; } },
    clipboard: function () { return clip; },
    __setClipboard: function (t) { clip = String(t || ''); },
    log: function (m) { if (window.console) console.log('native: ' + m); },
    exit: function () { }, orientation: function () { }, keepScreenOn: function () { },
    immersive: function () { }, webTransparent: function () { },
    playerOpen: function () { }, playerPlay: function () { }, playerPause: function () { },
    playerToggle: function () { }, playerSeek: function () { }, playerVolume: function () { },
    playerAudio: function () { }, playerBounds: function () { }, playerAspect: function () { },
    playerStop: function () { }, playerClose: function () { }, playerReleaseAll: function () { },
    playerState: function () { return JSON.stringify({ slot: 0, opened: false, playing: false, buffering: false, pos: 0, dur: 0, audio: 0 }); }
  };
})();
</script>
'@

$html = Join-Path $dst 'mobile\index.html'
$texto = [System.IO.File]::ReadAllText($html)
$marca = '<script src="../js/core/util.js">'
$pos = $texto.IndexOf($marca)
if ($pos -lt 0) { throw "index.html sem a marca dos scripts compartilhados" }
# -Touch faz o stub declarar tela sensivel: com janela estreita o app entra no
# modo celular, que e o que se quer ao depurar o layout de telefone.
if ($Touch) { $stub = $stub.Replace('__TOUCH__', 'true') } else { $stub = $stub.Replace('__TOUCH__', 'false') }
$texto = $texto.Substring(0, $pos) + $stub + "`r`n" + $texto.Substring($pos)
[System.IO.File]::WriteAllText($html, $texto, (New-Object System.Text.UTF8Encoding($false)))

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe" }
if (-not (Test-Path $edge)) { throw "Microsoft Edge nao encontrado" }

$url = 'file:///' + ((Join-Path $dst 'mobile\index.html') -replace '\\', '/')
$args = @(
  '--headless=new',
  "--remote-debugging-port=$Port",
  "--user-data-dir=$perfil",
  "--window-size=$Width,$Height",
  '--device-scale-factor=1',
  '--allow-file-access-from-files',
  '--disable-web-security',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--mute-audio',
  $url
)
Start-Process -FilePath $edge -ArgumentList $args -WindowStyle Hidden | Out-Null

# espera o DevTools responder
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
if (-not $ok) { throw "DevTools nao respondeu na porta $Port" }

# A janela do Edge headless nao tem exatamente o tamanho pedido (bordas). Forca o
# viewport exato pelo protocolo, senao o layout nao bate com o do projetor.
$nodeExe = "C:\Users\pedro\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path $nodeExe)) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if ($nodeExe) {
  $fix = Join-Path $env:TEMP 'spaceiptv-harness-size.js'
  @'
const path = require('path');
const http = require('http');
const WS = require(path.join(process.argv[5], 'node_modules', 'ws'));
const PORT = Number(process.argv[2]), W = Number(process.argv[3]), H = Number(process.argv[4]);
http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
  let d = ''; res.on('data', (c) => d += c);
  res.on('end', () => {
    const p = JSON.parse(d).find((t) => t.type === 'page');
    if (!p) process.exit(1);
    const ws = new WS(p.webSocketDebuggerUrl, { perMessageDeflate: false });
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Emulation.setDeviceMetricsOverride',
        params: { width: W, height: H, deviceScaleFactor: 1, mobile: false } }));
      setTimeout(() => { ws.close(); process.exit(0); }, 400);
    });
  });
}).on('error', () => process.exit(1));
'@ | Set-Content -Path $fix -Encoding UTF8
  & $nodeExe $fix $Port $Width $Height $PSScriptRoot | Out-Null
}

Write-Host "harness pronto: $Width x $Height em http://127.0.0.1:$Port"
Write-Host "assets: $dst"
Write-Host 'use:  $env:CDP_PORT = "' + $Port + '"; node tools\cdp.js "..."'
if (-not $Keep) { Write-Host 'para fechar: Get-Process msedge | Where-Object { $_.Path -like "*Edge*" } | Stop-Process -Force' }
