@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '%~dp0scripts\allow-private-lan-firewall.ps1', '-StatusPath', '%~dp0data\firewall-setup-status.json'); exit $process.ExitCode"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo Firewall setup did not finish. Approve the Windows administrator prompt, then try again.
  pause
)
exit /b %EXIT_CODE%
