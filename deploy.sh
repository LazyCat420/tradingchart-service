#!/bin/bash
# ============================================================
# Trading Chart Service — Build & Deploy to Synology NAS
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="tradingchart-service"
DISPLAY_NAME="📈 Trading Chart Service"

source "${SCRIPT_DIR}/../deploy-kit/lib.sh"
