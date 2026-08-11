@echo off
:: Start Lumina autostart task
powershell -Command "Start-ScheduledTask -TaskName 'LuminaDMX' -ErrorAction SilentlyContinue"
