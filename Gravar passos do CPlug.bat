@echo off
chcp 65001 >nul
title Oggi - Gravar passos do CPlug
cd /d "%~dp0"
echo Pasta: %CD%

where node >nul 2>nul
if errorlevel 1 goto semnode

if exist node_modules\playwright-core\package.json goto gravar
echo Preparando o gravador. Isso acontece so na primeira vez...
call npm install --no-save --no-audit --no-fund --loglevel=error playwright-core@1.56.1
if errorlevel 1 goto erro

:gravar
node scripts\gravar-cplug.js
if errorlevel 2 goto baixar
pause
exit /b

:baixar
echo.
echo Baixando um navegador so para a gravacao (uns 150 MB, pode levar alguns minutos)...
call npx --yes playwright-core@1.56.1 install chromium
if errorlevel 1 goto erro
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
