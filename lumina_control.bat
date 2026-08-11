@echo off
rem ASCII ONLY - no cyrillic in .bat files (cmd.exe mangles them, see PROJECTS.md gotcha #2)
title Lumina DMX - control panel
cd /d "%~dp0"

:menu
cls
echo ==========================================
echo   Lumina DMX - control panel
echo ==========================================
echo   1. Status
echo   2. Start server
echo   3. Stop server
echo   4. Open UI (desktop app)
echo   5. Open UI in browser
echo   0. Exit
echo.
set /p "choice=> "

if "%choice%"=="1" goto status
if "%choice%"=="2" goto start
if "%choice%"=="3" goto stop
if "%choice%"=="4" goto ui_desktop
if "%choice%"=="5" goto ui_browser
if "%choice%"=="0" exit /b 0
goto menu

:status
echo.
echo --- Scheduled task status ---
powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'LuminaDMX' -ErrorAction SilentlyContinue | Format-Table TaskName,State -AutoSize"
echo --- Server process ---
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'server_v4' }; if ($p) { $p | ForEach-Object { Write-Host ('server_v4 running, PID ' + $_.ProcessId) } } else { Write-Host 'server_v4 not running' }"
echo --- Desktop shell ---
powershell -NoProfile -Command "$p = Get-Process electron -ErrorAction SilentlyContinue; if ($p) { Write-Host ('Electron running, processes: ' + $p.Count) } else { Write-Host 'Electron not running' }"
echo.
pause
goto menu

:start
echo.
powershell -NoProfile -Command "Start-ScheduledTask -TaskName 'LuminaDMX' -ErrorAction SilentlyContinue"
echo Task started. Wait 3-5 sec - the server will come up by itself.
echo.
pause
goto menu

:stop
echo.
powershell -NoProfile -Command "Stop-ScheduledTask -TaskName 'LuminaDMX' -ErrorAction SilentlyContinue"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'server_v4' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo Server stopped (if it was running).
echo.
pause
goto menu

:ui_desktop
if exist "%~dp0web\release\win-unpacked\Lumina Control Center.exe" (
  start "" "%~dp0web\release\win-unpacked\Lumina Control Center.exe"
) else (
  start "" "%~dp0run_desktop.bat"
)
goto menu

:ui_browser
start "" "http://localhost:8000/"
goto menu
