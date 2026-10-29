@echo off
chcp 65001 >nul
title x2qq
cd /d "%~dp0"
if not exist logs mkdir logs
if exist .stop del /q .stop >nul 2>&1

rem Optional: if you keep a local proxy for downloading X media, set CLASH_EXE
rem and put the generated config at .proxy\config.yaml
if defined CLASH_EXE (
  if exist ".proxy\config.yaml" (
    powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 17899 -State Listen -ErrorAction SilentlyContinue)) { Start-Process -WindowStyle Hidden -FilePath $env:CLASH_EXE -ArgumentList '-d','.proxy','-f','.proxy\config.yaml' }"
  )
)

echo.
echo  ==========================================
echo   x2qq   X -^> QQ forwarder
echo   logs: logs\run-YYYY-MM-DD.log
echo   stop: stop.cmd  or close this window
echo  ==========================================
echo.

:loop
node src\main.js run
set "CODE=%errorlevel%"
if exist .stop (
  del /q .stop >nul 2>&1
  echo [x2qq] stopped by stop.cmd
  goto end
)
if "%CODE%"=="2" (
  echo [x2qq] another instance is already running, exiting.
  goto end
)
echo [x2qq] node exited with code %CODE%, restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop

:end
echo.
pause
