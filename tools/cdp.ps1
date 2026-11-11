# DESENVOLVIMENTO: prepara o tunel para o DevTools da WebView do app Android.
# Uso:  .\tools\cdp.ps1                 (abre o tunel na porta 9222)
#       .\tools\cdp.ps1 "App.lists.all()"
#
# Com mais de um aparelho ligado (emulador + projetor), escolha pelo serial:
#       $env:ADB_SERIAL = "emulator-5554"        ou   "192.168.0.6:5555"
$adb = "D:\Arquivos de Programas\Android\Sdk\platform-tools\adb.exe"
if (-not (Test-Path $adb)) { $adb = "adb" }

# Aparelho alvo: emulador, projetor ou o unico conectado.
$dev = @()
if ($env:ADB_SERIAL) { $dev = @("-s", $env:ADB_SERIAL) }

# Escolhe o socket da WebView do app QUE ESTA RODANDO agora. Um socket de execucao
# anterior continua listado por um tempo em /proc/net/unix; usar o primeiro da lista
# abre o tunel para um processo morto e o CDP fica pendurado.
$socks = & $adb @dev shell cat /proc/net/unix 2>$null | Select-String -Pattern "webview_devtools_remote_(\d+)"
if (-not $socks) { Write-Error "WebView sem socket de depuracao. O app esta rodando em build debug?"; exit 1 }

$pids = @()
foreach ($pkg in @("app.spaceiptv.mobile.debug", "app.spaceiptv.mobile")) {
  $p = (& $adb @dev shell pidof $pkg 2>$null)
  if ($p) { $pids += $p.Trim().Split("`n") | ForEach-Object { $_.Trim() } }
}
$pidWeb = $null
foreach ($s in $socks) {
  $m = [regex]::Match($s.Line, "webview_devtools_remote_(\d+)")
  if ($m.Success -and ($pids -contains $m.Groups[1].Value)) { $pidWeb = $m.Groups[1].Value; break }
}
if (-not $pidWeb) {
  $pidWeb = [regex]::Match(($socks | Select-Object -Last 1).Line, "webview_devtools_remote_(\d+)").Groups[1].Value
}

& $adb @dev forward --remove tcp:9222 2>$null | Out-Null
& $adb @dev forward tcp:9222 "localabstract:webview_devtools_remote_$pidWeb" | Out-Null
Write-Host "tunel pronto: tcp:9222 -> webview_devtools_remote_$pidWeb"

if ($args.Count -gt 0) {
  $node = "C:\Users\pedro\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  & $node (Join-Path $PSScriptRoot "cdp.js") $args
}
