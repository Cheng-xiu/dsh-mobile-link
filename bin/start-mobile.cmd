@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found in PATH. DeepSeek Harness requires Node.js.
  pause
  exit /b 1
)
node "%~dp0cli.js" start %*
echo.
echo dsh-mobile-link: DSH runs in the minimized "DSH Service" window.
echo Re-running this script while DSH is up just re-pushes the link.
pause
endlocal
