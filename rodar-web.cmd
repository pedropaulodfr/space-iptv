@echo off
rem Duplo clique aqui para rodar o Space IPTV (versao web) em http://127.0.0.1:8788
rem Windows: o PowerShell 5.1 que ja vem no sistema executa tools\run-web.ps1.
setlocal
title Space IPTV - servidor web local
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\run-web.ps1"

rem So pausa em falha explicita do script (codigo 1); Ctrl+C/fechar a janela encerra normal.
if "%ERRORLEVEL%"=="1" pause

endlocal
