import agentic_chart_benchmark
import pandas as pd
import datetime

symbol = 'AAPL'
df = agentic_chart_benchmark.fetch_data(symbol)
spec = {
  "overlays": [
    {
      "kind": "line",
      "x0": df.index[-20].strftime('%Y-%m-%d'),
      "y0": df['Low'].iloc[-20],
      "x1": df.index[-1].strftime('%Y-%m-%d'),
      "y1": df['Low'].iloc[-1],
      "color": "green",
      "label": "Support"
    },
    {
      "kind": "zone",
      "x0": df.index[-10].strftime('%Y-%m-%d'),
      "x1": df.index[-1].strftime('%Y-%m-%d'),
      "y0": df['High'].iloc[-10] * 0.99,
      "y1": df['High'].iloc[-10] * 1.01,
      "color": "blue",
      "label": "Supply Zone"
    }
  ],
  "analysis": "This is a mock analysis."
}
agentic_chart_benchmark.render_chart(df, spec, symbol, "3M Daily")
print("Rendered mock chart.")

