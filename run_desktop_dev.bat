@echo off
rem Lumina desktop shell (development): Vite dev server + HMR inside Electron.
rem Edit web/*.tsx and the window updates instantly - no vite build needed.
cd /d "%~dp0web"
npm run electron:dev
