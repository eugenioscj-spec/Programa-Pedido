@echo off
chcp 65001 >nul
title Oggi - Gravar passos do CPlug
cd /d "%~dp0"

where node >/dev/null 2>nul
if errorlevel 1 goto semnode

if exist node_modules\playwright-core goto gravar
echo Preparando o gravador. Isso acontece so na primeira vez...
call npm install --no-save --no-audit --no-fund --loglevel=error playwright-core@1.56.1
if errorlevel 1 goto erro

:gravar
node scripts\gravar-cplug.js
pause
exit /b

:semnode
echo Falta instalar o Node.js. Rode primeiro o "Testar no Windows.bat".
pause
exit /b

:erro
echo.
echo Algo deu errado. Tire um print desta janela e mande para o Claude.
pause
