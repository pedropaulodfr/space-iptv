# Empacota o Space IPTV (e opcionalmente instala/abre na TV) com o perfil de assinatura
# AltLauncherProfile. Sem esse perfil a TV recusa a atualizacao
# ("Author certificate not match") e seria preciso desinstalar o app.
#
# Uso:
#   pwsh tools\package.ps1                  # so empacota  -> dist\tv\SpaceIPTV.wgt
#   pwsh tools\package.ps1 -Install         # empacota e instala na TV
#   pwsh tools\package.ps1 -Install -Run    # empacota, instala e abre
#
# Perfil de assinatura: ver HANDOFF secao 2. O backup do author.p12 esta em
# D:\Documentos\projects\_iptv-backup\tizen-cert\

param(
  [switch]$Install,
  [switch]$Run,
  [string]$Tv = '192.168.0.13:26101',
  [string]$TvIp = '192.168.0.13',
  [string]$TizenStudio = 'D:\tizen-studio',
  [string]$Profile = 'AltLauncherProfile'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tz = Join-Path $TizenStudio 'tools\ide\bin\tizen.bat'
$sdb = Join-Path $TizenStudio 'tools\sdb.exe'
$dataProfile = Join-Path (Split-Path $TizenStudio -Parent) 'tizen-studio-data\profile\profiles.xml'

if (-not (Test-Path $tz)) { throw "Tizen CLI nao encontrado: $tz" }
if (-not (Test-Path $dataProfile) -or -not (Select-String -Path $dataProfile -Pattern $Profile -Quiet)) {
  throw "Perfil '$Profile' nao encontrado em $dataProfile. Veja HANDOFF secao 2 (backup em _iptv-backup\tizen-cert)."
}

Push-Location $root
try {
  Write-Host "Empacotando com o perfil $Profile..." -ForegroundColor Cyan
  & cmd /c "`"$tz`" package -t wgt -s $Profile -o .\dist\tv -- .\tv 2>&1" | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { throw "Falha ao empacotar (exit $LASTEXITCODE)" }
  Copy-Item '.\dist\tv\Space IPTV.wgt' '.\dist\tv\SpaceIPTV.wgt' -Force
  Write-Host "Pacote: $(Resolve-Path '.\dist\tv\SpaceIPTV.wgt')" -ForegroundColor Green

  if ($Install -or $Run) {
    Write-Host "Conectando em $TvIp..." -ForegroundColor Cyan
    & $sdb connect $TvIp | Out-Null
    Write-Host "Instalando na TV (atualiza por cima)..." -ForegroundColor Cyan
    & cmd /c "`"$tz`" install -n SpaceIPTV.wgt -s $Tv -- .\dist\tv 2>&1" | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "Falha ao instalar (exit $LASTEXITCODE)" }
  }
  if ($Run) {
    Write-Host "Abrindo na TV..." -ForegroundColor Cyan
    & cmd /c "`"$tz`" run -p SpcIptv001.SpaceIPTV -s $Tv 2>&1" | ForEach-Object { Write-Host "  $_" }
  }
} finally {
  Pop-Location
}
