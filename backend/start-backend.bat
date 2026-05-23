@echo off
cd /d "%~dp0"
netstat -ano | findstr /R /C:"127.0.0.1:8765 .*LISTENING" >nul
if not errorlevel 1 (
    echo Backend gia attivo su http://127.0.0.1:8765
    exit /b 0
)
"..\.venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 8765 >> "%~dp0uvicorn.out.log" 2>> "%~dp0uvicorn.err.log"
if errorlevel 1 (
    echo Backend non avviato. Controlla backend\uvicorn.err.log
    pause
)
