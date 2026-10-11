@echo off
rem ghprobe one-click deploy wrapper (ASCII only: cmd.exe reads .cmd as OEM codepage)
chcp 65001 >nul
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
echo ---- Done. Press any key to close. ----
pause >nul
