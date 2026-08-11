@echo off
echo Stopping LuminaDMX...
schtasks /end /tn "LuminaDMX" >nul 2>&1
taskkill /im python.exe /f >nul 2>&1
timeout /t 3 /nobreak >nul

echo Starting LED-Button Mapper...
echo.
N:\python_ide\DMX-ART-L\tools\wing\venv\Scripts\python.exe N:\python_ide\DMX-ART-L\tools\wing\wing_led_button_map.py %1 %2
echo.

echo Restarting LuminaDMX...
schtasks /run /tn "LuminaDMX" >nul 2>&1
echo Done.
pause
