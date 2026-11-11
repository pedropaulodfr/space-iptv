# Empacota o Space IPTV para a Samsung Apps TV Seller Office.
#
# A Seller Office ACEITA APENAS pacote assinado com certificado SAMSUNG
# (autor Samsung + distribuidor Samsung). Pacote assinado com o certificado publico
# da Tizen (tizen-distributor-signer.p12) instala em Modo Desenvolvedor, mas e
# recusado no upload da loja. Este script falha de proposito nesse caso.
#
# Uso:
#   pwsh tools\package-store.ps1 -Profile <PerfilSamsung> [-Version 1.0.1] [-Out .\dist\tv\store]
#
# O perfil Samsung e criado no Tizen Studio: Tools > Certificate Manager > + >
# Samsung certificate > TV > login Samsung > marcar o DUID da TV > criar.

param(
  [Parameter(Mandatory = $true)][string]$Profile,
  [string]$Version = '',
  [string]$Out = '.\dist\tv\store',
  [string]$TizenStudio = 'D:\tizen-studio'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tz = Join-Path $TizenStudio 'tools\ide\bin\tizen.bat'
$dataProfile = Join-Path (Split-Path $TizenStudio -Parent) 'tizen-studio-data\profile\profiles.xml'

if (-not (Test-Path $tz)) { throw "Tizen CLI nao encontrado: $tz" }
if (-not (Test-Path $dataProfile)) { throw "profiles.xml nao encontrado: $dataProfile" }
if (-not (Select-String -Path $dataProfile -Pattern "name=`"$Profile`"" -Quiet)) {
  throw "Perfil '$Profile' nao existe. Crie o certificado Samsung no Certificate Manager (veja o cabecalho deste script)."
}

Push-Location $root
try {
  if ($Version) {
    $cfg = Join-Path $root 'tv\config.xml'
    $xml = [System.IO.File]::ReadAllText($cfg)
    $novo = [regex]::Replace($xml, 'version="[0-9][^"]*"', "version=`"$Version`"", 1)
    if ($novo -ne $xml) { [System.IO.File]::WriteAllText($cfg, $novo, (New-Object System.Text.UTF8Encoding($false))); Write-Host "Versao do config.xml -> $Version" -ForegroundColor Cyan }
  }

  New-Item -ItemType Directory -Path $Out -Force | Out-Null
  Write-Host "Empacotando com o perfil '$Profile'..." -ForegroundColor Cyan
  & cmd /c "`"$tz`" package -t wgt -s `"$Profile`" -o `"$Out`" -- `"$root\app`" 2>&1" | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { throw "Falha ao empacotar (exit $LASTEXITCODE)" }

  $gerado = Join-Path $Out 'Space IPTV.wgt'
  $final = Join-Path $Out 'SpaceIPTV.wgt'
  if (-not (Test-Path $gerado)) { throw "Pacote nao gerado em $gerado" }
  Move-Item $gerado $final -Force

  # ---- verificacao da assinatura (le os certificados embutidos no signature1.xml) ----
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $final))
  function Subjects($nome) {
    $e = $zip.Entries | Where-Object { $_.FullName -eq $nome }
    if (-not $e) { return @() }
    $sr = New-Object System.IO.StreamReader($e.Open()); $xml = $sr.ReadToEnd(); $sr.Close()
    [regex]::Matches($xml, '(?s)<X509Certificate>(.*?)</X509Certificate>') | ForEach-Object {
      $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(,[Convert]::FromBase64String(($_.Groups[1].Value -replace '\s', '')))
      $c.Subject
    }
  }
  $autor = Subjects 'author-signature.xml'
  $dist = Subjects 'signature1.xml'
  $zip.Dispose()

  $distTexto = ($dist -join ' | ')
  $eSamsung = ($distTexto -match 'Samsung') -or ($autor -join ' | ' -match 'Samsung')

  Write-Host ""
  Write-Host "Autor    : $($autor -join ' | ')"
  Write-Host "Distrib. : $distTexto"

  $sha = (Get-FileHash $final -Algorithm SHA256).Hash
  $kb = [math]::Round((Get-Item $final).Length / 1kb, 1)

  if (-not $eSamsung) {
    $ruim = Join-Path $Out 'SpaceIPTV-nao-assinado-samsung.wgt'
    Move-Item $final $ruim -Force
    Write-Host ""
    Write-Host "RECUSADO PELA LOJA: o pacote NAO esta assinado com certificado Samsung." -ForegroundColor Red
    Write-Host "Certificado de distribuidor encontrado: $distTexto" -ForegroundColor Yellow
    Write-Host "O arquivo foi renomeado para: $ruim" -ForegroundColor Yellow
    Write-Host "Crie/escolha o perfil Samsung no Certificate Manager e rode de novo com -Profile <nome>." -ForegroundColor Yellow
    exit 1
  }

  Write-Host ""
  Write-Host "OK: pacote assinado com certificado Samsung." -ForegroundColor Green
  Write-Host "Arquivo: $final"
  Write-Host "Tamanho: $kb KB"
  Write-Host "SHA256 : $sha"
  Write-Host "Proximo passo: Seller Office > subir este .wgt"
} finally {
  Pop-Location
}
