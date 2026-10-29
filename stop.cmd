@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo stop > .stop
if not exist ".run.lock" (
  echo [LingGuangBot-QQ] not running: no .run.lock
  exit /b 0
)
powershell -NoProfile -Command "$l = Get-Content '.run.lock' -Raw | ConvertFrom-Json; if ($l.pid) { Stop-Process -Id $l.pid -Force -ErrorAction SilentlyContinue; Write-Host ('[LingGuangBot-QQ] stopped pid ' + $l.pid) }"
del /q ".run.lock" >nul 2>&1
exit /b 0
