import os
import json
import yfinance as yf
import mplfinance as mpf
import matplotlib.pyplot as plt
import pandas as pd
from PIL import Image, ImageDraw, ImageFont

os.makedirs("data/images", exist_ok=True)
manifest_path = "data/manifest.json"
if os.path.exists(manifest_path):
    with open(manifest_path, "r") as f:
        manifest = json.load(f)
else:
    manifest = []

print("Fetching real market data...")
aapl = yf.Ticker('AAPL').history(start='2024-01-01', end='2024-12-31')
msft = yf.Ticker('MSFT').history(start='2024-12-01', end='2024-12-31')
goog = yf.Ticker('GOOG').history(start='2024-12-01', end='2024-12-31')
amzn = yf.Ticker('AMZN').history(start='2024-12-01', end='2024-12-31')

# Ensure columns are standard
for df in [aapl, msft, goog, amzn]:
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

# --- Edge Case 1: Extreme Density (1 Year of Candles + Indicators) ---
print("Generating Edge Case 1...")
filename1 = "data/images/dense_chart.png"
# Calculate RSI manually for plotting
delta = aapl['Close'].diff()
up = delta.clip(lower=0)
down = -1 * delta.clip(upper=0)
ema_up = up.ewm(com=13, adjust=False).mean()
ema_down = down.ewm(com=13, adjust=False).mean()
rs = ema_up / ema_down
aapl['RSI'] = 100 - (100 / (1 + rs))

apds = [
    mpf.make_addplot(aapl['RSI'], panel=2, color='purple', ylabel='RSI')
]
mpf.plot(aapl, type='candle', volume=True, mav=(50, 200), addplot=apds,
         title="AAPL 1-Year Dense Chart (SMA 50, 200, Volume, RSI)",
         savefig=filename1, figratio=(12, 6), panel_ratios=(4, 1, 1))

manifest.append({
    "image_path": filename1,
    "prompt": "This is a dense 1-year trading chart for AAPL. It includes 50-day and 200-day moving averages, Volume, and RSI at the bottom. Please estimate the final RSI value at the very right edge of the chart. Also, is the 50-day SMA currently above or below the 200-day SMA?",
    "category": "Edge Case: Extreme Density"
})


# --- Edge Case 2: Multi-Panel Dashboard ---
print("Generating Edge Case 2...")
filename2 = "data/images/multi_panel.png"
fig, axes = plt.subplots(2, 2, figsize=(12, 8))
axes[0, 0].plot(msft.index, msft['Close'], color='blue')
axes[0, 0].set_title('MSFT (Microsoft)')
axes[0, 0].grid(True)

axes[0, 1].plot(goog.index, goog['Close'], color='green')
axes[0, 1].set_title('GOOG (Alphabet)')
axes[0, 1].grid(True)

axes[1, 0].plot(amzn.index, amzn['Close'], color='orange')
axes[1, 0].set_title('AMZN (Amazon)')
axes[1, 0].grid(True)

axes[1, 1].plot(aapl.index[-21:], aapl['Close'].iloc[-21:], color='red')
axes[1, 1].set_title('AAPL (Apple)')
axes[1, 1].grid(True)

plt.tight_layout()
plt.savefig(filename2)
plt.close()

manifest.append({
    "image_path": filename2,
    "prompt": "This is a 2x2 multi-panel dashboard showing 4 different stocks. Look closely at all 4 quadrants. What is the approximate final price of GOOG (Alphabet)? What is the approximate final price of AMZN (Amazon)? Do not mix them up.",
    "category": "Edge Case: Multi-Panel Confusion"
})


# --- Edge Case 3: Information Overload (Chart + Level 2 Text Overlay) ---
print("Generating Edge Case 3...")
filename3 = "data/images/level2_overlay.png"
# Create base chart
mpf.plot(aapl.iloc[-50:], type='candle', volume=True, savefig=filename3, figratio=(10, 6))

# Overlay text
img = Image.open(filename3)
d = ImageDraw.Draw(img)

try:
    font_bold = ImageFont.truetype("arialbd.ttf", 16)
    font_small = ImageFont.truetype("arial.ttf", 12)
except:
    font_bold = ImageFont.load_default()
    font_small = ImageFont.load_default()

# Draw a semi-transparent box for the order book
overlay = Image.new('RGBA', img.size, (255, 255, 255, 0))
d_overlay = ImageDraw.Draw(overlay)
d_overlay.rectangle(((700, 50), (950, 400)), fill=(0, 0, 0, 200))
img = Image.alpha_composite(img.convert('RGBA'), overlay).convert('RGB')
d = ImageDraw.Draw(img)

d.text((710, 60), "LEVEL 2 ORDER BOOK", fill=(255, 255, 255), font=font_bold)
d.text((710, 90), "BID      SIZE", fill=(0, 255, 0), font=font_small)
bids = [("150.25", "100"), ("150.20", "500"), ("150.15", "1200"), ("150.10", "300"), ("150.00", "5000")]
y = 110
for price, size in bids:
    d.text((710, y), f"{price}      {size}", fill=(0, 255, 0), font=font_small)
    y += 20

d.text((710, y+10), "ASK      SIZE", fill=(255, 0, 0), font=font_small)
y += 30
asks = [("150.30", "200"), ("150.35", "150"), ("150.40", "800"), ("150.45", "400"), ("150.50", "10000")]
for price, size in asks:
    d.text((710, y), f"{price}      {size}", fill=(255, 0, 0), font=font_small)
    y += 20

img.save(filename3)

manifest.append({
    "image_path": filename3,
    "prompt": "This image contains a trading chart and an overlaid Level 2 Order Book on the right side. Please read the order book. What is the price of the largest Bid size? What is the price of the largest Ask size?",
    "category": "Edge Case: Information Overload"
})

with open("data/manifest.json", "w") as f:
    json.dump(manifest, f, indent=4)

print("Edge cases generated successfully!")
