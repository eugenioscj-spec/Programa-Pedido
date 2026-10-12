@echo off
chcp 65001 >nul
title Oggi Pedidos - teste local
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto semnode

if exist node_modules\better-sqlite3 goto iniciar
echo Instalando o sistema. Isso acontece so na primeira vez e leva alguns minutos...
call npm install --omit=dev --no-audit --no-fund --loglevel=error
if errorlevel 1 goto erro

:iniciar
node scripts\teste-local.js
echo.
echo O sistema foi desligado.
pause
exit /b

:semnode
echo.
echo Falta instalar o Node.js, o programa que faz o sistema funcionar.
echo Vou abrir o site. Baixe a versao LTS, instale clicando em Next ate o fim
echo e depois clique de novo neste arquivo.
start "" https://nodejs.org/pt
pause
exit /b

:erro
echo.
echo Algo deu errado na instalacao. Tire um print desta janela e mande para o Claude.
pause
