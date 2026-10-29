@echo off
chcp 65001 >nul
title LingGuangBot-QQ
cd /d "%~dp0"
if not exist logs mkdir logs
if exist .stop del /q .stop >nul 2>&1
if not exist ".proxy\config.yaml" node scripts\prepare-local-proxy.mjs
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 17899 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -WindowStyle Hidden -FilePath 'C:\Program Files\ClashForWindows\resources\static\files\win\x64\clash-win64.exe' -ArgumentList '-d','.proxy','-f','.proxy\config.yaml' }"
echo.
echo  ============================================
echo   LingGuangBot-QQ  X -> QQ forwarder
echo   logs: logs\run-YYYY-MM-DD.log
echo   stop: run stop.cmd or close this window
echo  ============================================
echo.
:loop
node src\main.js run
set "CODE=%errorlevel%"
if exist .stop (
  del /q .stop >nul 2>&1
  echo [LingGuangBot-QQ] stopped by stop.cmd
  goto end
)
if "%CODE%"=="2" (
  echo [LingGuangBot-QQ] another instance is already running, exiting.
  goto end
)
echo [LingGuangBot-QQ] node exited with code %CODE%, restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop
:end
echo.
pause
