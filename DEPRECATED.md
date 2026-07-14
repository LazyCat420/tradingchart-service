# DEPRECATED — merged into lazy-tool-service

This service's agent-facing functionality now lives in **lazy-tool-service** and is
callable by the trading-service agent harness through prism-service's `/agent`
endpoint (MCP):

- Chart rendering → `save_trading_chart` tool
  (`lazy-tool-service/python/app/tools/charting_tools.py` — same plotly
  candlestick/volume/EMA renderer with line/zone/volume_void overlays; output
  served at `http://<host>:5591/charts/`).
- OHLCV data → `get_market_data` tool; indicators → `get_technical_indicators`.
- Fundamentals summary (`/api/summary`) → `get_ticker_summary` tool
  (`finance_tools.py`).
- The server-side vLLM overlay loop and browser→vLLM proxy are superseded by
  the prism agent harness (the agent does the reasoning and calls the tools).

What was NOT ported (research artifacts, not agent tools): the browser
benchmark lab under `benchmark_charts/`, `run_benchmark.py`,
`agentic_chart_benchmark.py`, and `fetch_live_screens.py`. They still run
standalone from this directory if needed.

The NAS containers (ports 8899 and 3000) can be stopped; nothing in the
ecosystem references them (verified by cross-repo grep, 2026-07-13).
