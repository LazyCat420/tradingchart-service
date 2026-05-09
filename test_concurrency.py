import asyncio
import aiohttp
import time
import json

PROXY_URL = "http://127.0.0.1:3000/api/llm/health" # fast endpoint just to test proxy concurrency

async def make_req(session, i):
    start = time.time()
    try:
        async with session.get(PROXY_URL) as response:
            await response.read()
            elapsed = time.time() - start
            print(f"Request {i} finished in {elapsed:.2f}s (Status: {response.status})")
    except Exception as e:
        print(f"Request {i} failed: {e}")

async def main():
    print("Testing backend proxy concurrency (bypassing browser limits)...")
    print("Sending 15 simultaneous requests...")
    
    # We use a large connector limit to ensure Python doesn't throttle it
    connector = aiohttp.TCPConnector(limit=100)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [make_req(session, i) for i in range(15)]
        await asyncio.gather(*tasks)

if __name__ == "__main__":
    asyncio.run(main())
