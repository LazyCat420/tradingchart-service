#!/bin/bash
echo "Starting data proxy on port 3000..."
python3 data_proxy.py &

echo "Starting server on port 8899..."
python3 server.py
