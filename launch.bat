@echo off
echo ========================================================
echo        VISION TEST BENCHMARK LAUNCHER
echo ========================================================
echo.

echo Starting local server on localhost:3000 and opening Dashboard...
start "" "http://localhost:3000"

echo.
echo Launch Complete! Server is running at http://localhost:3000
echo Press Ctrl+C to stop the server and exit.
cmd /c "venv\Scripts\activate.bat && python data_proxy.py"
