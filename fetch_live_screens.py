import os
import json
import asyncio
from playwright.async_api import async_playwright

async def capture_screens():
    os.makedirs("data/images", exist_ok=True)
    
    # Check if manifest exists, if so load it
    manifest_path = "data/manifest.json"
    if os.path.exists(manifest_path):
        with open(manifest_path, "r") as f:
            manifest = json.load(f)
    else:
        manifest = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={'width': 1920, 'height': 1080})
        page = await context.new_page()

        print("Fetching Finviz...")
        try:
            await page.goto("https://finviz.com/", timeout=15000, wait_until="domcontentloaded")
            # Wait a moment for ads/popups or dynamic charts
            await page.wait_for_timeout(3000)
            finviz_path = "data/images/finviz_live.png"
            await page.screenshot(path=finviz_path, full_page=False)
            
            manifest.append({
                "image_path": finviz_path,
                "prompt": "This is a screenshot of the Finviz homepage. Can you identify the top gainer stock ticker and its percentage change? What is the general color trend (red vs green) of the heatmap squares on the right side?",
                "category": "Live Screenshot: Finviz"
            })
            print("Saved Finviz screenshot.")
        except Exception as e:
            print(f"Failed Finviz: {e}")

        print("Fetching Yahoo Finance...")
        try:
            await page.goto("https://finance.yahoo.com/", timeout=15000, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)
            yahoo_path = "data/images/yahoo_live.png"
            await page.screenshot(path=yahoo_path, full_page=False)
            
            manifest.append({
                "image_path": yahoo_path,
                "prompt": "This is a screenshot of the Yahoo Finance homepage. Please extract the value of the S&P 500 index from the top ticker tape. Also, what is the main headline news article visible?",
                "category": "Live Screenshot: Yahoo Finance"
            })
            print("Saved Yahoo Finance screenshot.")
        except Exception as e:
            print(f"Failed Yahoo Finance: {e}")

        await browser.close()

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=4)
        
    print("Live screenshots added to manifest!")

if __name__ == "__main__":
    asyncio.run(capture_screens())
