import os
import json
import yfinance as yf
import pandas as pd
import plotly.graph_objects as go
import aiohttp
import asyncio

import urllib.request

# The vLLM text endpoint
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

def fetch_data(symbol="TSLA", period="3mo"):
    print(f"Fetching {period} of data for {symbol}...")
    df = yf.Ticker(symbol).history(period=period)
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    
    # Calculate simple EMAs
    df['EMA_20'] = df['Close'].ewm(span=20, adjust=False).mean()
    df['EMA_50'] = df['Close'].ewm(span=50, adjust=False).mean()
    
    # Make index timezone naive for JSON serialization
    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)
        
    return df

async def ask_llm_for_overlays(df):
    print("Sending market data to Quant LLM for technical analysis...")
    
    # Take the last 30 days for the LLM to analyze to avoid huge prompts
    recent_df = df.tail(30)
    
    # Format data for prompt
    data_str = "Date | Open | High | Low | Close | Volume\n"
    for date, row in recent_df.iterrows():
        date_str = date.strftime('%Y-%m-%d')
        data_str += f"{date_str} | {row['Open']:.2f} | {row['High']:.2f} | {row['Low']:.2f} | {row['Close']:.2f} | {row['Volume']}\n"

    prompt = f"""You are an elite quantitative technical analyst.
I am going to provide you with the last 30 days of OHLCV data for TSLA.
I want you to analyze the data and identify key structural levels:
1. Identify one major Support line.
2. Identify one major Resistance line.
3. Identify a demand or supply 'zone' (a rectangular area where price consolidated or reversed).

You MUST output your analysis EXACTLY according to this JSON schema. Do not output any markdown formatting, ONLY raw JSON:

{{
  "overlays": [
    {{
      "kind": "line",
      "x0": "YYYY-MM-DD",
      "y0": price_float,
      "x1": "YYYY-MM-DD",
      "y1": price_float,
      "color": "red or green",
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

    async with aiohttp.ClientSession() as session:
        async with session.post(VLLM_ENDPOINT, json=payload, timeout=300) as response:
            if response.status == 200:
                result = await response.json()
                msg = result["choices"][0]["message"]
                content = msg.get("content") or ""
                
                # If content is empty, maybe it's stuck in reasoning?
                if not content.strip():
                    content = msg.get("reasoning") or ""
                    
                # Clean up the output in case it wrapped it in markdown
                content = content.replace('```json', '').replace('```', '').strip()
                try:
                    # Find the start and end of the JSON object in case there's extra text
                    start_idx = content.find('{')
                    end_idx = content.rfind('}') + 1
                    if start_idx != -1 and end_idx != -1:
                        content = content[start_idx:end_idx]
                    return json.loads(content)
                except json.JSONDecodeError as e:
                    print("Failed to parse JSON from LLM. Raw output:")
                    print(content)
                    raise e
            else:
                text = await response.text()
                raise Exception(f"LLM API Error: {response.status} {text}")

def render_chart(df, spec, symbol="TSLA"):
    print("Rendering interactive chart with Plotly...")
    
    # Create main candlestick trace
    fig = go.Figure(data=[go.Candlestick(x=df.index,
                open=df['Open'],
                high=df['High'],
                low=df['Low'],
                close=df['Close'],
                name="Price")])

    # Add EMAs
    fig.add_trace(go.Scatter(x=df.index, y=df['EMA_20'], line=dict(color='orange', width=1.5), name='EMA 20'))
    fig.add_trace(go.Scatter(x=df.index, y=df['EMA_50'], line=dict(color='purple', width=1.5), name='EMA 50'))

    # Add the Agent's overlays
    overlays = spec.get("overlays", [])
    for overlay in overlays:
        kind = overlay.get("kind")
        if kind == "line":
            fig.add_shape(type="line",
                x0=overlay["x0"], y0=overlay["y0"],
                x1=overlay["x1"], y1=overlay["y1"],
                line=dict(color=overlay.get("color", "white"), width=2, dash="dashdot"),
            )
            # Add an annotation for the line
            fig.add_annotation(
                x=overlay["x1"], y=overlay["y1"],
                text=overlay.get("label", ""),
                showarrow=False,
                yshift=10,
                font=dict(color=overlay.get("color", "white"))
            )
        elif kind == "zone":
            fig.add_shape(type="rect",
                x0=overlay["x0"], y0=overlay["y0"],
                x1=overlay["x1"], y1=overlay["y1"],
                line=dict(color=overlay.get("color", "blue"), width=0),
                fillcolor=overlay.get("color", "blue"),
                opacity=0.2,
            )
            fig.add_annotation(
                x=overlay["x0"], y=overlay["y1"],
                text=overlay.get("label", ""),
                showarrow=False,
                yshift=10,
                font=dict(color=overlay.get("color", "white"))
            )

    fig.update_layout(
        title=f"Agentic Charting: {symbol} <br><sup>Analysis: {spec.get('analysis', '')}</sup>",
        yaxis_title='Price',
        xaxis_title='Date',
        template='plotly_dark',
        xaxis_rangeslider_visible=False
    )
    
    out_file = "agentic_chart_demo.html"
    fig.write_html(out_file)
    print(f"Chart saved successfully to {os.path.abspath(out_file)}")

async def main():
    df = fetch_data("TSLA")
    try:
        spec = await ask_llm_for_overlays(df)
        print(f"\nLLM Generated Overlays:\n{json.dumps(spec, indent=2)}\n")
        render_chart(df, spec, "TSLA")
    except Exception as e:
        print(f"Error during execution: {e}")

if __name__ == "__main__":
    asyncio.run(main())
