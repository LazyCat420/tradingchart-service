@echo off
echo ========================================================
echo    AGENTIC QUANT LAB — Pure HTML/JS (Zero Python)
echo ========================================================
echo.

:: Try npx serve first, fall back to Python http.server
where npx >nul 2>&1
if %errorlevel% equ 0 (
    echo [1] Starting via npx serve on http://localhost:3000 ...
    start "" "http://localhost:3000"
    cmd /c npx -y serve@14 ./benchmark_charts -l 3000 --no-clipboard
) else (
    echo [1] npx not found, using Python http.server on http://localhost:8899 ...
    start "" "http://localhost:8899"
    cd benchmark_charts
    cmd /c python -m http.server 8899
)
