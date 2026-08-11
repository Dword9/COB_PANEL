@echo off
:: Run as Administrator
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Administrator rights required. Right-click -^> Run as administrator.
    pause
    exit /b 1
)
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File uninstall_autostart.ps1
pause
