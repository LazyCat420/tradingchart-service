import asyncio
import aiohttp
import time

async def make_req(s, i):
    start = time.time()
    try:
        async with s.post('http://127.0.0.1:3000/api/llm/stream', json={'model':'qwen','messages':[{'role':'user','content':'hello'}],'stream':True}) as r:
            await r.read()
            print(f'Req {i} done in {time.time()-start:.2f}s')
    except Exception as e:
        print(f'Req {i} failed: {e}')

async def main():
    c = aiohttp.TCPConnector(limit=100)
    async with aiohttp.ClientSession(connector=c) as s:
        print("Sending 9 concurrent LLM requests to bypass browser queue limit...")
        await asyncio.gather(*[make_req(s, i) for i in range(9)])

if __name__ == "__main__":
    asyncio.run(main())
