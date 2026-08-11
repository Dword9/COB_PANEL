@echo off
:: Stop Lumina autostart task
powershell -Command "Stop-ScheduledTask -TaskName 'LuminaDMX' -ErrorAction SilentlyContinue"
