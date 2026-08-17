@echo off
setlocal
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Windows PowerShell not found.
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set code=%errorlevel%
echo.
if not "%code%"=="0" echo [ERROR] Installation failed with exit code %code%.
pause
exit /b %code%
