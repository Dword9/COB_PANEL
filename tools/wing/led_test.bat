@echo off
chcp 65001 >nul
:: Stop Lumina server task so the wing is free
cd /d "%~dp0\.."
powershell -NoProfile -Command "Stop-ScheduledTask -TaskName 'LuminaDMX' -ErrorAction SilentlyContinue"
:: Kill any leftover python processes
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'server_v4' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
timeout /t 5 /nobreak >nul

cd /d "%~dp0"
echo === Wing LED layout test ===
"venv\Scripts\python.exe" wing_led_test.py

echo.
echo === Restarting Lumina server task ===
cd /d "%~dp0\.."
powershell -NoProfile -Command "Start-ScheduledTask -TaskName 'LuminaDMX' -ErrorAction SilentlyContinue"

pause
