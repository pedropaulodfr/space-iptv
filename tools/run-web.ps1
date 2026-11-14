# Sobe a versão web do Space IPTV em http://127.0.0.1:8788
#
# Faz, em ordem: gera o build estático (dist/web), sobe o runner das Pages Functions
# (que serve dist/web + login/sincronização do Neon) e abre o navegador quando a porta
# responde.
#
# Uso: duplo clique em rodar-web.cmd (raiz do repositório) ou:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\run-web.ps1
#
# Para parar: feche a janela do console ou Ctrl+C.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$port = 8788
$url = "http://127.0.0.1:$port/"

function Test-Porta([int] $Porta) {
  $cliente = New-Object Net.Sockets.TcpClient
  try {
    $cliente.Connect('127.0.0.1', $Porta)
    return $true
  } catch {
    return $false
  } finally {
    $cliente.Dispose()
  }
}

function Abrir-Navegador([string] $Endereco) {
  try { Start-Process $Endereco | Out-Null } catch { }
}

Write-Host ''
Write-Host '  Space IPTV - versão web (localhost)' -ForegroundColor Cyan
Write-Host "  pasta: $root"
Write-Host ''

Set-Location $root

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '  ERRO: Node.js não encontrado no PATH.' -ForegroundColor Red
  Write-Host '  Instale o Node 18+ (https://nodejs.org) e rode de novo.' -ForegroundColor Red
  exit 1
}

# 2. Já existe um servidor nessa porta? Então só abre o navegador.
if (Test-Porta $port) {
  Write-Host "  Já existe um servidor rodando em $url" -ForegroundColor Yellow
  Write-Host '  Abrindo o navegador...'
  Abrir-Navegador $url
  Write-Host ''
  Write-Host '  (para subir pelo script, feche o servidor antigo e rode de novo)'
  exit 0
}

# 3. Build estático: o runner serve dist/web, então ele precisa estar atualizado.
Write-Host '[1/2] Gerando build estático (dist/web)...' -ForegroundColor Cyan
& node web/build.js
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host "  ERRO: o build falhou (código $LASTEXITCODE). Nada foi iniciado." -ForegroundColor Red
  exit 1
}

# 4. Abre o navegador assim que a porta responder (sem depender de tempo fixo).
$abridor = Start-Job -ArgumentList $url, $port -ScriptBlock {
  param($Endereco, $Porta)
  for ($i = 0; $i -lt 80; $i++) {
    $cliente = New-Object Net.Sockets.TcpClient
    try {
      $cliente.Connect('127.0.0.1', $Porta)
      $cliente.Close()
      Start-Process $Endereco | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 250
    } finally {
      $cliente.Dispose()
    }
  }
}

# 5. Servidor em primeiro plano (os logs aparecem aqui).
Write-Host ''
Write-Host "[2/2] Subindo o servidor em $url" -ForegroundColor Cyan
Write-Host '      Login e sincronização usam o banco configurado no .dev.vars.'
Write-Host '      Sem conta ainda? O cadastro é fechado: crie o primeiro admin por SQL (SETUP-NEON.md).'
Write-Host '      Para parar: Ctrl+C ou feche esta janela.'
Write-Host ''
try {
  & node tools/pages-runner.js --port $port
} finally {
  Stop-Job $abridor -ErrorAction SilentlyContinue
  Remove-Job $abridor -Force -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host '  Servidor encerrado.' -ForegroundColor DarkGray
}
