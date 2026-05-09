import asyncio
import aiohttp
import base64
import json

def encode_image(image_path):
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode('utf-8')

async def get_model_name(session, endpoint):
    try:
        async with session.get(f"{endpoint}/models", timeout=5) as response:
            data = await response.json()
            if data and "data" in data and len(data["data"]) > 0:
                return data["data"][0]["id"]
    except Exception as e:
        print(f"Warning: Failed to fetch dynamic model from {endpoint}: {e}")
    return "Qwen/Qwen3.5-122B-A10B-FP8"

async def test_single():
    endpoint = "http://10.0.0.141:8000/v1"
    async with aiohttp.ClientSession() as session:
        model = await get_model_name(session, endpoint)
    image_path = "data/images/small_text_doc.png"
    prompt = "This is a receipt. Can you read the total amount and identify any specific items and their prices? Please list all the small text you can read."
    
    base64_image = encode_image(image_path)
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64_image}"}}
                ]
            }
        ],
        "max_tokens": 100,
        "temperature": 0.2
    }
    
        async with session.post(f"{endpoint}/chat/completions", json=payload) as response:
            data = await response.json()
            print(json.dumps(data, indent=2))

if __name__ == "__main__":
    asyncio.run(test_single())
