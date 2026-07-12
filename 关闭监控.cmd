@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or newer was not found. Please install Node.js first.
  pause
  exit /b 1
)

node "%~dp0scripts\stop-windows.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Monitor shutdown was not forced. See the message above and verify the service state.
  pause
)
exit /b %EXIT_CODE%
