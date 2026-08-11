@echo off
cd /d %~dp0
set LUMINA_SERVICE=1
"tools\wing\venv\Scripts\python.exe" server_v4.py
