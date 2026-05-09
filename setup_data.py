import os
import json
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw, ImageFont

# Create directories
os.makedirs("data/images", exist_ok=True)

# 1. Generate Trading Chart
def create_trading_chart():
    filename = "data/images/trading_chart_1.png"
    np.random.seed(42)
    dates = pd.date_range("2025-01-01", periods=50)
    prices = 150 + np.random.randn(50).cumsum()
    
    plt.figure(figsize=(8, 5))
    plt.plot(dates, prices, label='NVDA Price', color='blue')
    plt.title("NVIDIA (NVDA) Stock Price")
    plt.xlabel("Date")
    plt.ylabel("Price ($)")
    plt.axhline(y=prices.max(), color='red', linestyle='--', label=f'High: {prices.max():.2f}')
    plt.axhline(y=prices.min(), color='green', linestyle='--', label=f'Low: {prices.min():.2f}')
    plt.legend()
    plt.grid(True)
    plt.savefig(filename)
    plt.close()
    return filename

# 2. Generate Small Text Doc
def create_small_text_doc():
    filename = "data/images/small_text_doc.png"
    img = Image.new('RGB', (800, 600), color=(255, 255, 255))
    d = ImageDraw.Draw(img)
    
    # Try to load a default font, otherwise use default
    try:
        font_large = ImageFont.truetype("arial.ttf", 30)
        font_small = ImageFont.truetype("arial.ttf", 8)
    except IOError:
        font_large = ImageFont.load_default()
        font_small = ImageFont.load_default()
        
    d.text((50, 50), "RECEIPT", fill=(0, 0, 0), font=font_large)
    d.text((50, 100), "Store: SuperMart", fill=(0, 0, 0), font=font_large)
    
    # Small text items
    small_text = """
Item 1: Apple ......... $1.50
Item 2: Banana ........ $0.75
Item 3: Milk .......... $3.25
Item 4: Bread ......... $2.50
Item 5: Cheese ........ $5.00
-----------------------------
Subtotal .............. $13.00
Tax (8%) .............. $1.04
TOTAL ................. $14.04
    """
    
    # Draw small text multiple times to simulate a dense document
    d.text((50, 150), small_text, fill=(50, 50, 50), font=font_small)
    d.text((400, 150), small_text.replace("Apple", "Orange"), fill=(100, 100, 100), font=font_small)
    d.text((50, 400), "TERMS AND CONDITIONS APPLY. NO REFUNDS AFTER 30 DAYS.", fill=(0, 0, 0), font=font_small)
    
    img.save(filename)
    return filename

# 3. Generate Complex Scene (Shapes and Colors)
def create_complex_scene():
    filename = "data/images/complex_scene.png"
    img = Image.new('RGB', (800, 800), color=(20, 20, 30))
    d = ImageDraw.Draw(img)
    
    # Draw some random colored shapes
    np.random.seed(99)
    for _ in range(50):
        x1, y1 = np.random.randint(0, 800), np.random.randint(0, 800)
        x2, y2 = x1 + np.random.randint(20, 150), y1 + np.random.randint(20, 150)
        color = tuple(np.random.randint(50, 255, 3))
        d.rectangle([x1, y1, x2, y2], fill=color, outline=(255, 255, 255))
        
    # Add text on top
    try:
        font = ImageFont.truetype("arial.ttf", 40)
    except IOError:
        font = ImageFont.load_default()
        
    d.text((100, 100), "DANGER ZONE", fill=(255, 0, 0), font=font)
    d.text((400, 600), "SAFE AREA", fill=(0, 255, 0), font=font)
    
    img.save(filename)
    return filename

print("Generating test images locally...")

manifest = [
    {
        "image_path": create_trading_chart(),
        "prompt": "This is a trading chart. Please extract the highest price and the lowest price shown in this chart. Also describe the overall trend.",
        "category": "Trading Charts"
    },
    {
        "image_path": create_small_text_doc(),
        "prompt": "This is a receipt. Can you read the total amount and identify any specific items and their prices? Please list all the small text you can read.",
        "category": "Small Details"
    },
    {
        "image_path": create_complex_scene(),
        "prompt": "Describe this complex scene in detail. What are the main objects and colors? Can you read the large text visible?",
        "category": "General Description"
    }
]

# Save manifest
manifest_path = "data/manifest.json"
with open(manifest_path, "w") as f:
    json.dump(manifest, f, indent=4)

print(f"Setup complete. {len(manifest)} images generated and ready for benchmarking.")
