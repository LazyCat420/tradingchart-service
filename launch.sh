#!/usr/bin/env bash
echo "========================================================"
echo "       VISION TEST BENCHMARK LAUNCHER (WSL/Linux)"
echo "========================================================"
echo

echo "Starting local data proxy server on port 3000..."
echo "Open your browser to http://localhost:3000"
echo
echo "Press Ctrl+C to stop the server."
echo

# Activate virtual environment and run proxy
source venv/bin/activate
python data_proxy.py
