"""
Agentic Quant Lab — Backend API Server
Serves the dashboard and handles LLM analysis requests from the browser.
Supports iterative strategy improvement: the LLM sees its own previous
overlay specs and reasoning, then tries to improve on them.
"""
import os
import json
import asyncio
import time
import datetime
import aiohttp
import yfinance as yf
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from http.server import HTTPServer, SimpleHTTPRequestHandler
import threading
import urllib.parse

import urllib.request

VLLM_ENDPOINT = "http://10.0.0.141:8000/v1/chat/completions"

def get_model_name(endpoint):
    base = endpoint.replace("/chat/completions", "")
    try:
        req = urllib.request.Request(f"{base}/models")
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode())
            if data and "data" in data and len(data["data"]) > 0:
                return data["data"][0]["id"]
    except Exception as e:
        print(f"Warning: Failed to fetch dynamic model from {base}: {e}")
    return "Qwen/Qwen3.5-122B-A10B-FP8" # Fallback

MODEL_NAME = get_model_name(VLLM_ENDPOINT)
OUTPUT_DIR = "benchmark_charts"
HISTORY_DIR = os.path.join(OUTPUT_DIR, "history")
PORT = 8899

# ── In-memory state ──
run_history = {}   # symbol -> list of {iteration, spec, reasoning, timestamp}
results_cache = [] # latest results list for the dashboard


def fetch_data(symbol, period="3mo"):
    df = yf.Ticker(symbol).history(period=period)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if len(df) == 0:
        raise Exception(f"No data found for {symbol}")
    df['EMA_20'] = df['Close'].ewm(span=20, adjust=False).mean()
    df['EMA_50'] = df['Close'].ewm(span=50, adjust=False).mean()
    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)
    return df


def build_iteration_prompt(symbol, data_str, iteration, prev_specs):
    """Build the prompt. On iteration > 1, include previous specs so the LLM can improve."""

    base = f"""You are an elite quantitative technical analyst.
I am giving you the last 30 days of OHLCV data for {symbol}.

Analyze the data and produce a JSON overlay specification:
1. Support / Trendlines (kind: "line")
2. Resistance lines (kind: "line")
3. Demand / Supply zones (kind: "zone")
4. Liquidity voids — areas where price moved fast on low volume (kind: "volume_void")
5. Use quant equations (Z-score, RSI, ATR, Bollinger Bands, Fibonacci) in your reasoning.

Output ONLY raw JSON matching this schema — no markdown, no explanation outside the JSON:
{{
  "overlays": [
    {{"kind":"line","x0":"YYYY-MM-DD","y0":float,"x1":"YYYY-MM-DD","y1":float,"color":"green","label":"str"}},
    {{"kind":"zone","x0":"YYYY-MM-DD","x1":"YYYY-MM-DD","y0":float,"y1":float,"color":"blue","label":"str"}},
    {{"kind":"volume_void","x0":"YYYY-MM-DD","x1":"YYYY-MM-DD","y0":float,"y1":float,"color":"purple","label":"str"}}
  ],
  "strategy_name": "A short name for your strategy approach",
  "analysis": "2-3 sentence explanation.",
  "confidence": 0.0-1.0
}}
"""

    if iteration > 1 and prev_specs:
        history_block = "\n\n--- PREVIOUS ITERATIONS (your earlier work) ---\n"
        for prev in prev_specs:
            history_block += f"\nIteration {prev['iteration']} (strategy: {prev.get('strategy_name','unknown')}, confidence: {prev.get('confidence','?')}):\n"
            history_block += f"  Analysis: {prev.get('analysis','')}\n"
            history_block += f"  Overlays: {json.dumps(prev.get('overlays',[]), indent=2)}\n"
        history_block += "\n--- END PREVIOUS ITERATIONS ---\n"
        history_block += f"\nThis is iteration {iteration}. Review your previous work above."
        history_block += "\nIdentify weaknesses or missed patterns. Try a DIFFERENT strategy approach."
        history_block += "\nYou must IMPROVE on your previous analysis — do not repeat the same thing.\n"
        base += history_block

    base += f"\nHere is the data:\n{data_str}\n"
    return base


async def ask_llm(session, df, symbol, iteration=1, prev_specs=None):
    recent_df = df.tail(30)
    data_str = "Date | Open | High | Low | Close | Volume\n"
    for date, row in recent_df.iterrows():
        ds = date.strftime('%Y-%m-%d')
        data_str += f"{ds} | {row['Open']:.2f} | {row['High']:.2f} | {row['Low']:.2f} | {row['Close']:.2f} | {row['Volume']}\n"

    prompt = build_iteration_prompt(symbol, data_str, iteration, prev_specs or [])

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": "You are a quant assistant that outputs strict JSON."},
            {"role": "user", "content": prompt}
        ],
        "max_tokens": 4000,
        "temperature": 0.3 if iteration > 1 else 0.1  # slightly more creative on retries
    }

    async with session.post(VLLM_ENDPOINT, json=payload, timeout=300) as resp:
        if resp.status != 200:
            text = await resp.text()
            raise Exception(f"LLM API Error {resp.status}: {text}")
        result = await resp.json()
        msg = result["choices"][0]["message"]
        content = msg.get("content") or ""

        reasoning = msg.get("reasoning_content") or ""
        if not reasoning and "<think>" in content:
            try:
                s = content.find("<think>") + 7
                e = content.find("</think>")
                reasoning = content[s:e].strip()
            except:
                pass
        if not reasoning:
            try:
                reasoning = content[:content.find('{')].strip()
            except:
                pass

        clean = content.replace('```json', '').replace('```', '').strip()
        si = clean.find('{')
        ei = clean.rfind('}') + 1
        if si != -1 and ei > si:
            clean = clean[si:ei]
        spec = json.loads(clean)
        return spec, reasoning


def render_chart(df, spec, symbol, iteration=1):
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True,
                        vertical_spacing=0.03,
                        subplot_titles=(f"{symbol} · Iteration {iteration}", "Volume"),
                        row_width=[0.2, 0.7])

    fig.add_trace(go.Candlestick(x=df.index, open=df['Open'], high=df['High'],
                                  low=df['Low'], close=df['Close'], name="Price"), row=1, col=1)
    fig.add_trace(go.Scatter(x=df.index, y=df['EMA_20'], line=dict(color='orange', width=1.5), name='EMA 20'), row=1, col=1)
    fig.add_trace(go.Scatter(x=df.index, y=df['EMA_50'], line=dict(color='purple', width=1.5), name='EMA 50'), row=1, col=1)

    colors = ['green' if row['Close'] >= row['Open'] else 'red' for _, row in df.iterrows()]
    fig.add_trace(go.Bar(x=df.index, y=df['Volume'], marker_color=colors, name="Volume"), row=2, col=1)

    for ov in spec.get("overlays", []):
        kind = ov.get("kind")
        if kind == "line":
            fig.add_shape(type="line", x0=ov["x0"], y0=ov["y0"], x1=ov["x1"], y1=ov["y1"],
                          line=dict(color=ov.get("color","white"), width=2, dash="dashdot"), row=1, col=1)
            fig.add_annotation(x=ov["x1"], y=ov["y1"], text=ov.get("label",""), showarrow=False,
                               yshift=10, font=dict(color=ov.get("color","white")), row=1, col=1)
        elif kind in ("zone", "volume_void"):
            is_void = kind == "volume_void"
            fc = ov.get("color", "purple" if is_void else "blue")
            fig.add_shape(type="rect", x0=ov["x0"], y0=ov["y0"], x1=ov["x1"], y1=ov["y1"],
                          line=dict(color=fc, width=1 if is_void else 0, dash="dot" if is_void else "solid"),
                          fillcolor=fc, opacity=0.3 if is_void else 0.2, row=1, col=1)
            fig.add_annotation(x=ov["x0"], y=ov["y1"], text=ov.get("label",""), showarrow=False,
                               yshift=10, font=dict(color=ov.get("color","white")), row=1, col=1)

    strat = spec.get("strategy_name", "")
    conf = spec.get("confidence", "")
    fig.update_layout(
        title=f"{symbol} · {strat} (confidence: {conf})<br><sup>{spec.get('analysis','')}</sup>",
        template='plotly_dark', xaxis_rangeslider_visible=False, height=800)

    out = os.path.join(OUTPUT_DIR, f"{symbol}.html")
    fig.write_html(out)
    return out


async def run_single_ticker(symbol, iterations=1):
    """Run 1..N iterations for a single ticker, each building on the last."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(HISTORY_DIR, exist_ok=True)

    print(f"[{symbol}] Starting {iterations} iteration(s)...")
    df = await asyncio.to_thread(fetch_data, symbol)
    prev_specs = run_history.get(symbol, [])

    async with aiohttp.ClientSession() as session:
        for i in range(1, iterations + 1):
            current_iter = len(prev_specs) + 1
            print(f"[{symbol}] Iteration {current_iter}...")
            try:
                spec, reasoning = await ask_llm(session, df, symbol, current_iter, prev_specs)
                await asyncio.to_thread(render_chart, df, spec, symbol, current_iter)

                entry = {
                    "iteration": current_iter,
                    "timestamp": datetime.datetime.now().isoformat(),
                    "strategy_name": spec.get("strategy_name", ""),
                    "confidence": spec.get("confidence", 0),
                    "analysis": spec.get("analysis", ""),
                    "reasoning": reasoning,
                    "overlays": spec.get("overlays", []),
                    "status": "success"
                }
                prev_specs.append(entry)
                print(f"[{symbol}] Iteration {current_iter} done — strategy: {spec.get('strategy_name','')}, confidence: {spec.get('confidence','')}")
            except Exception as e:
                print(f"[{symbol}] Iteration {current_iter} FAILED: {e}")
                prev_specs.append({
                    "iteration": current_iter,
                    "timestamp": datetime.datetime.now().isoformat(),
                    "status": "error",
                    "error": str(e)
                })

    run_history[symbol] = prev_specs

    # Save history to disk
    hist_path = os.path.join(HISTORY_DIR, f"{symbol}.json")
    with open(hist_path, "w") as f:
        json.dump(prev_specs, f, indent=2)

    # Update results cache
    latest = prev_specs[-1] if prev_specs else {}
    return {
        "symbol": symbol,
        "status": latest.get("status", "error"),
        "analysis": latest.get("analysis", ""),
        "reasoning": latest.get("reasoning", ""),
        "strategy_name": latest.get("strategy_name", ""),
        "confidence": latest.get("confidence", 0),
        "iterations": len(prev_specs),
        "error": latest.get("error", "")
    }


async def run_batch(tickers, iterations=1):
    """Run analysis for a batch of tickers concurrently."""
    sem = asyncio.Semaphore(5)

    async def _wrap(sym):
        async with sem:
            return await run_single_ticker(sym, iterations)

    results = await asyncio.gather(*[_wrap(t) for t in tickers])

    global results_cache
    # Merge into cache (replace existing symbols, append new)
    existing = {r["symbol"]: r for r in results_cache}
    for r in results:
        existing[r["symbol"]] = r
    results_cache = list(existing.values())

    with open(os.path.join(OUTPUT_DIR, "results.json"), "w") as f:
        json.dump(results_cache, f, indent=2)

    return results


# ── HTTP API Server ──

class APIHandler(SimpleHTTPRequestHandler):
    """Serves static files from OUTPUT_DIR and handles API endpoints."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=OUTPUT_DIR, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/":
            self.path = "/index.html"
            return super().do_GET()

        elif parsed.path == "/api/results":
            self._json_response(results_cache)

        elif parsed.path.startswith("/api/history/"):
            symbol = parsed.path.split("/")[-1].upper()
            hist = run_history.get(symbol, [])
            self._json_response(hist)

        elif parsed.path == "/api/status":
            self._json_response({
                "status": "online",
                "model": MODEL_NAME,
                "endpoint": VLLM_ENDPOINT,
                "tickers_loaded": len(results_cache),
                "total_iterations": sum(len(v) for v in run_history.values())
            })

        else:
            return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/analyze":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            tickers = body.get("tickers", [])
            iterations = body.get("iterations", 1)
            tickers = [t.strip().upper() for t in tickers if t.strip()]

            if not tickers:
                self._json_response({"error": "No tickers provided"}, 400)
                return

            # Run in background thread with its own event loop
            def _run():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                result = loop.run_until_complete(run_batch(tickers, iterations))
                loop.close()
                # Rebuild dashboard after run
                from build_dashboard import build_dashboard
                build_dashboard()
                print(f"[SERVER] Batch complete: {len(result)} tickers processed")

            thread = threading.Thread(target=_run, daemon=True)
            thread.start()

            self._json_response({"message": f"Analysis started for {len(tickers)} tickers ({iterations} iteration(s))", "tickers": tickers})

        elif parsed.path == "/api/clear":
            run_history.clear()
            results_cache.clear()
            self._json_response({"message": "History cleared"})

        else:
            self._json_response({"error": "Unknown endpoint"}, 404)

    def _json_response(self, data, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        # Suppress noisy static file logs
        if "/api/" in (args[0] if args else ""):
            print(f"[API] {args[0]}")


def start_server():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Load any existing history
    if os.path.exists(HISTORY_DIR):
        for fname in os.listdir(HISTORY_DIR):
            if fname.endswith(".json"):
                sym = fname.replace(".json", "")
                with open(os.path.join(HISTORY_DIR, fname)) as f:
                    run_history[sym] = json.load(f)

    # Load existing results
    global results_cache
    rp = os.path.join(OUTPUT_DIR, "results.json")
    if os.path.exists(rp):
        with open(rp) as f:
            results_cache = json.load(f)

    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), APIHandler)
    print(f"=" * 50)
    print(f"  AGENTIC QUANT LAB — Server running")
    print(f"  http://localhost:{PORT}")
    print(f"  Model: {MODEL_NAME}")
    print(f"  Endpoint: {VLLM_ENDPOINT}")
    print(f"=" * 50)
    server.serve_forever()


if __name__ == "__main__":
    start_server()
