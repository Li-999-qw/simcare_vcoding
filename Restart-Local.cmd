@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restart-Local.ps1"
if errorlevel 1 (
  echo.
  echo Restart failed. Check the message above and the logs folder.
)
pause
