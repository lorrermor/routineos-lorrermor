@echo off
setlocal

cd /d "%~dp0"

".venv\Scripts\python.exe" "start_pantrypro.py"
if errorlevel 1 pause
