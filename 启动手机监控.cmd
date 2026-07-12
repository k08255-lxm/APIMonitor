@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.5 or newer was not found. Please install Node.js first.
  pause
  exit /b 1
)

node "%~dp0scripts\launch-windows.mjs" --lan %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Mobile monitor startup failed. See data\launcher.log for details.
  pause
)
exit /b %EXIT_CODE%
