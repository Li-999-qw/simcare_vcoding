@echo off
setlocal
cd /d "%~dp0"
if /i "%~1"=="--non-interactive" goto unattended
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restart-Local.ps1"
set "restart_exit=%errorlevel%"
goto result
:unattended
if /i "%~2"=="--deployment-lock-held" goto deployment
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restart-Local.ps1" -NoBrowser
set "restart_exit=%errorlevel%"
goto result
:deployment
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restart-Local.ps1" -NoBrowser -DeploymentLockHeld
set "restart_exit=%errorlevel%"
:result
if not "%restart_exit%"=="0" (
  echo.
  echo Restart failed. Check the message above and the logs folder.
)
if /i not "%~1"=="--non-interactive" pause
exit /b %restart_exit%
