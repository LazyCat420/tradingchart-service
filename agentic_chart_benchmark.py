import os
import json
import re
import yfinance as yf
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import aiohttp
import asyncio
import time

VLLM_ENDPOINT = "http://10.0.0.141:8000/v1/chat/completions"
MODEL_NAME = "Qwen/Qwen3.5-122B-A10B-FP8"
OUTPUT_DIR = "benchmark_charts"
MAX_RETRIES_PER_CALL = 1  # retry once on JSON parse failure


def repair_json(raw: str) -> str:
    """Fix common LLM JSON defects."""
    s = raw
    # Strip trailing commas before } or ]
    s = re.sub(r",\s*([}\]])", r"\1", s)
    # Replace bare NaN / Infinity with null
    s = re.sub(r":\s*NaN\b", ": null", s)
    s = re.sub(r":\s*-?Infinity\b", ": null", s)
    # Strip control characters that break json.loads
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)
    return s


def try_close_truncated(s: str) -> str:
    """Try to close truncated JSON (LLM ran out of tokens)."""
    braces = s.count("{") - s.count("}")
    brackets = s.count("[") - s.count("]")
    patched = re.sub(r',\s*"[^"]*"?\s*:?\s*$', '', s)
    patched = re.sub(r",\s*$", "", patched)
    patched += "]" * max(0, brackets)
    patched += "}" * max(0, braces)
    return patched


def safe_json_parse(raw: str, symbol: str = "?"):
    """3-step JSON parse: raw -> repair -> truncation fix."""
    # Attempt 1: raw
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e1:
        print(f"[{symbol}] Raw parse failed ({e1}), repairing...")
    # Attempt 2: repair
    repaired = repair_json(raw)
    try:
        return json.loads(repaired)
    except json.JSONDecodeError as e2:
        print(f"[{symbol}] Repaired parse failed ({e2}), trying truncation...")
    # Attempt 3: close truncated
    closed = try_close_truncated(repaired)
    try:
        spec = json.loads(closed)
        print(f"[{symbol}] Recovered truncated JSON")
        return spec
    except json.JSONDecodeError as e3:
        print(f"[{symbol}] All parse attempts failed. Raw[:500]: {raw[:500]}")
        raise Exception(f"JSON Parse Error after repair: {e3}")

TICKERS = [
    "AAPL", "MSFT", "GOOG", "NVDA", "AMZN", 
    "META", "NFLX", "AMD", "INTC", "BA", 
    "DIS", "JPM", "V", "WMT", "PEP", 
    "KO", "XOM", "CVX", "JNJ", "SPY"
]

TIMEFRAMES = {
    "short": {"range": "3mo", "interval": "1d", "label": "3M Daily", "prompt_label": "SHORT-TERM (3 months, daily candles)", "tail": 30},
    "medium": {"range": "1y", "interval": "1wk", "label": "1Y Weekly", "prompt_label": "MEDIUM-TERM (1 year, weekly candles)", "tail": 52},
    "long": {"range": "5y", "interval": "1mo", "label": "5Y Monthly", "prompt_label": "LONG-TERM (5 years, monthly candles)", "tail": 60}
}

def fetch_data(symbol, period="3mo", interval="1d"):
    df = yf.Ticker(symbol).history(period=period, interval=interval)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    
    if len(df) == 0:
        raise Exception(f"No data found for {symbol}")

    df['EMA_20'] = df['Close'].ewm(span=20, adjust=False).mean()
    df['EMA_50'] = df['Close'].ewm(span=50, adjust=False).mean()
    
    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)
        
    return df

async def ask_llm_for_overlays(session, df, symbol, tf_config):
    recent_df = df.tail(tf_config['tail'])
    
    data_str = "Date | Open | High | Low | Close | Volume\n"
    for date, row in recent_df.iterrows():
        date_str = date.strftime('%Y-%m-%d')
        data_str += f"{date_str} | {row['Open']:.2f} | {row['High']:.2f} | {row['Low']:.2f} | {row['Close']:.2f} | {row['Volume']}\n"

    prompt = f"""You are an elite quantitative technical analyst.
I am going to provide you with the {tf_config['prompt_label']} OHLCV data for {symbol}.
I want you to analyze the data and identify key structural levels:
1. Identify one major Support line or Trendline.
2. Identify one major Resistance line.
3. Identify a demand or supply 'zone' (a rectangular area where price consolidated or reversed).
4. Identify any Volume 'Liquidity Voids' (areas where price moved quickly on low volume) or 'High Volume Nodes'.
5. use quant equations to calculate where the price will go next based on things like z score, vol, RSI, atr, bollinger bands, etc. in your reasoning.

You MUST output your analysis EXACTLY according to this JSON schema. Do not output any markdown formatting, ONLY raw JSON:

{{
  "overlays": [
    {{
      "kind": "line",
      "x0": "YYYY-MM-DD",
      "y0": price_float,
      "x1": "YYYY-MM-DD",
      "y1": price_float,
      "color": "green",
      "label": "string"
    }},
    {{
      "kind": "zone",
      "x0": "YYYY-MM-DD",
      "x1": "YYYY-MM-DD",
      "y0": price_float_low,
      "y1": price_float_high,
      "color": "blue",
      "label": "string"
    }},
    {{
      "kind": "volume_void",
      "x0": "YYYY-MM-DD",
      "x1": "YYYY-MM-DD",
      "y0": price_float_low,
      "y1": price_float_high,
      "color": "purple",
      "label": "string"
    }}
  ],
  "analysis": "A brief 2 sentence explanation of your reasoning."
}}

Here is the data:
{data_str}
"""

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": "You are a quant assistant that outputs strict JSON."},
            {"role": "user", "content": prompt}
        ],
        "max_tokens": 4000,
        "temperature": 0.1
    }

    async with session.post(VLLM_ENDPOINT, json=payload, timeout=300) as response:
        if response.status == 200:
            result = await response.json()
            msg = result["choices"][0]["message"]
            content = msg.get("content") or ""
            
            # Extract reasoning trace (from 'reasoning_content' or inside <think> tags)
            reasoning = msg.get("reasoning_content") or ""
            if not reasoning and "<think>" in content:
                try:
                    start_think = content.find("<think>") + 7
                    end_think = content.find("</think>")
                    reasoning = content[start_think:end_think].strip()
                except:
                    pass
            
            # Fallback if no reasoning field/tags, just store the text that isn't JSON
            if not reasoning:
                try:
                    reasoning = content[:content.find('{')].strip()
                except:
                    pass
                
            clean_content = content.replace('```json', '').replace('```', '').strip()
            start_idx = clean_content.find('{')
            end_idx = clean_content.rfind('}') + 1
            if start_idx != -1 and end_idx > start_idx:
                clean_content = clean_content[start_idx:end_idx]
            spec = safe_json_parse(clean_content, symbol)
            return spec, reasoning
        else:
            text = await response.text()
            raise Exception(f"[{symbol}] LLM API Error: {response.status} {text}")

def render_chart(df, spec, symbol, tf_label):
    # Create subplots: 2 rows, 1 col. Top is Price (80%), Bottom is Volume (20%)
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True, 
                        vertical_spacing=0.03, subplot_titles=(f"Agentic Charting: {symbol} ({tf_label})", "Volume"),
                        row_width=[0.2, 0.7])

    # Candlestick chart on Row 1
    fig.add_trace(go.Candlestick(x=df.index,
                open=df['Open'],
                high=df['High'],
                low=df['Low'],
                close=df['Close'],
                name="Price"), row=1, col=1)

    fig.add_trace(go.Scatter(x=df.index, y=df['EMA_20'], line=dict(color='orange', width=1.5), name='EMA 20'), row=1, col=1)
    fig.add_trace(go.Scatter(x=df.index, y=df['EMA_50'], line=dict(color='purple', width=1.5), name='EMA 50'), row=1, col=1)

    # Volume Bar chart on Row 2
    colors = ['green' if row['Close'] >= row['Open'] else 'red' for idx, row in df.iterrows()]
    fig.add_trace(go.Bar(x=df.index, y=df['Volume'], marker_color=colors, name="Volume"), row=2, col=1)

    overlays = spec.get("overlays", [])
    for overlay in overlays:
        kind = overlay.get("kind")
        if kind == "line":
            fig.add_shape(type="line",
                x0=overlay["x0"], y0=overlay["y0"],
                x1=overlay["x1"], y1=overlay["y1"],
                line=dict(color=overlay.get("color", "white"), width=2, dash="dashdot"),
                row=1, col=1
            )
            fig.add_annotation(
                x=overlay["x1"], y=overlay["y1"],
                text=overlay.get("label", ""),
                showarrow=False,
                yshift=10,
                font=dict(color=overlay.get("color", "white")),
                row=1, col=1
            )
        elif kind in ["zone", "volume_void"]:
            is_void = (kind == "volume_void")
            fill_color = overlay.get("color", "purple" if is_void else "blue")
            opacity = 0.3 if is_void else 0.2
            
            fig.add_shape(type="rect",
                x0=overlay["x0"], y0=overlay["y0"],
                x1=overlay["x1"], y1=overlay["y1"],
                line=dict(color=fill_color, width=1 if is_void else 0, dash="dot" if is_void else "solid"),
                fillcolor=fill_color,
                opacity=opacity,
                row=1, col=1
            )
            fig.add_annotation(
                x=overlay["x0"], y=overlay["y1"],
                text=overlay.get("label", ""),
                showarrow=False,
                yshift=10,
                font=dict(color=overlay.get("color", "white")),
                row=1, col=1
            )

    fig.update_layout(
        title=f"Agentic Charting: {symbol} · {tf_label} <br><sup>Analysis: {spec.get('analysis', '')}</sup>",
        template='plotly_dark',
        xaxis_rangeslider_visible=False,
        height=800
    )
    
    tf_suffix = tf_label.replace(' ', '_').replace('.', '')
    out_file = os.path.join(OUTPUT_DIR, f"{symbol}_{tf_suffix}.html")
    fig.write_html(out_file)
    return out_file

async def process_ticker(sem, session, symbol):
    results_for_ticker = []
    async with sem:
        for tf_key, tf_config in TIMEFRAMES.items():
            try:
                print(f"[{symbol} | {tf_key}] Fetching data...")
                df = await asyncio.to_thread(fetch_data, symbol, tf_config['range'], tf_config['interval'])
                last_err = None
                for attempt in range(MAX_RETRIES_PER_CALL + 1):
                    try:
                        label = f" (retry {attempt})" if attempt > 0 else ""
                        print(f"[{symbol} | {tf_key}] Analyzing with LLM...{label}")
                        spec, reasoning = await ask_llm_for_overlays(session, df, symbol, tf_config)
                        print(f"[{symbol} | {tf_key}] Rendering chart...")
                        out_file = await asyncio.to_thread(render_chart, df, spec, symbol, tf_config['label'])
                        print(f"[{symbol} | {tf_key}] Success -> {out_file}")
                        results_for_ticker.append({"symbol": symbol, "timeframe": tf_key, "status": "success", "analysis": spec.get("analysis", ""), "reasoning": reasoning})
                        break
                    except Exception as inner_e:
                        last_err = inner_e
                        print(f"[{symbol} | {tf_key}] Attempt {attempt+1} failed: {inner_e}")
                else:
                    # All retries exhausted
                    raise last_err
            except Exception as e:
                print(f"[{symbol} | {tf_key}] Failed: {str(e)}")
                results_for_ticker.append({"symbol": symbol, "timeframe": tf_key, "status": "error", "error": str(e), "reasoning": ""})
    return results_for_ticker

async def main():
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)

    print(f"Starting benchmark for {len(TICKERS)} tickers...")
    start_time = time.time()
    
    # Use a semaphore to limit concurrency so we don't overwhelm the vLLM server
    sem = asyncio.Semaphore(5) 
    
    async with aiohttp.ClientSession() as session:
        tasks = [process_ticker(sem, session, ticker) for ticker in TICKERS]
        nested_results = await asyncio.gather(*tasks)
        results = [item for sublist in nested_results for item in sublist]
        
    end_time = time.time()
    
    print("\n" + "="*40)
    print("BENCHMARK RESULTS")
    print("="*40)
    success_count = sum(1 for r in results if r['status'] == 'success')
    total_runs = len(TICKERS) * len(TIMEFRAMES)
    print(f"Total Time: {end_time - start_time:.2f} seconds")
    print(f"Successful: {success_count} / {total_runs}")
    print("="*40)
    
    with open(os.path.join(OUTPUT_DIR, "results.json"), "w") as f:
        json.dump(results, f, indent=4)
        
    print(f"Results saved to: {os.path.abspath(os.path.join(OUTPUT_DIR, 'results.json'))}")

if __name__ == "__main__":
    asyncio.run(main())
