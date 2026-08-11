@echo off
rem Lumina desktop shell (production): loads UI from http://localhost:8000
rem If the Python server is down, a splash screen offers to start it.
cd /d "%~dp0web"
npm run electron
