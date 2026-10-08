@echo off
cd /d "%~dp0"
start "cor proxy" cmd /k cor start
timeout /t 3 /nobreak >nul
start http://127.0.0.1:8787/dashboard
