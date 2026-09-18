@echo off
REM Publish a BrainDump Lite update to your friends. Just double-click me.
REM   push-update.bat          bump patch  (0.3.0 -> 0.3.1)
REM   push-update.bat minor    bump minor  (0.3.1 -> 0.4.0)
REM   push-update.bat major    bump major  (0.4.0 -> 1.0.0)
REM   push-update.bat 0.5.2    set exact version
setlocal
set "BUMP=%~1"
if "%BUMP%"=="" set "BUMP=patch"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push-update.ps1" -Bump %BUMP%
echo.
pause
