import os
import json
import base64
import asyncio
import aiohttp
import time

# vLLM Endpoints
ENDPOINTS = [
    "http://10.0.0.141:8000/v1",
    "http://10.0.0.30:8000/v1"
]

def encode_image(image_path):
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode('utf-8')

async def fetch_models(session, endpoint):
    try:
        async with session.get(f"{endpoint}/models", timeout=10) as response:
            if response.status == 200:
                data = await response.json()
                models = [model["id"] for model in data.get("data", [])]
                print(f"Found models at {endpoint}: {models}")
                return endpoint, models
            else:
                print(f"Failed to fetch models from {endpoint}: HTTP {response.status}")
                return endpoint, []
    except Exception as e:
        print(f"Error connecting to {endpoint}: {e}")
        return endpoint, []

async def test_vision_model(session, endpoint, model_name, image_data):
    image_path = image_data["image_path"]
    prompt = image_data["prompt"]
    category = image_data["category"]
    
    # Encode image
    base64_image = encode_image(image_path)
    
    payload = {
        "model": model_name,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": prompt
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/png;base64,{base64_image}"
                        }
                    }
                ]
            }
        ],
        "max_tokens": 4000,
        "temperature": 0.2
    }
    
    start_time = time.time()
    try:
        async with session.post(f"{endpoint}/chat/completions", json=payload, timeout=300) as response:
            latency = time.time() - start_time
            if response.status == 200:
                data = await response.json()
                msg = data["choices"][0]["message"]
                
                content = msg.get("content") or ""
                reasoning = msg.get("reasoning") or ""
                
                # Combine reasoning and content for the report if reasoning exists
                if reasoning:
                    result_text = f"<details><summary>Reasoning Trace</summary>\n\n{reasoning}\n\n</details>\n\n**Final Answer:**\n{content}"
                else:
                    result_text = content
                    
                if not result_text.strip():
                    result_text = f"API returned no content or reasoning. Raw message: {json.dumps(msg)}"
                    
                return {
                    "endpoint": endpoint,
                    "model": model_name,
                    "image": image_path,
                    "category": category,
                    "prompt": prompt,
                    "result": result_text,
                    "latency": f"{latency:.2f}s",
                    "status": "Success"
                }
            else:
                error_text = await response.text()
                return {
                    "endpoint": endpoint,
                    "model": model_name,
                    "image": image_path,
                    "category": category,
                    "prompt": prompt,
                    "result": f"HTTP {response.status}: {error_text}",
                    "latency": f"{latency:.2f}s",
                    "status": "Failed"
                }
    except Exception as e:
        latency = time.time() - start_time
        return {
            "endpoint": endpoint,
            "model": model_name,
            "image": image_path,
            "category": category,
            "prompt": prompt,
            "result": f"Exception: {str(e)}",
            "latency": f"{latency:.2f}s",
            "status": "Error"
        }

def generate_report(results):
    report_lines = []
    report_lines.append("# Vision Model Benchmark Report\n")
    report_lines.append("This report contains the raw outputs from the vLLM vision models to evaluate their capabilities in describing images, recognizing small details, and reading trading charts.\n")
    
    # Group by category
    categories = {}
    for res in results:
        cat = res["category"]
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(res)
        
    for cat, items in categories.items():
        report_lines.append(f"## Category: {cat}\n")
        
        # Group by image within category
        images = {}
        for item in items:
            img = item["image"]
            if img not in images:
                images[img] = []
            images[img].append(item)
            
        for img, tests in images.items():
            report_lines.append(f"### Image: `{img}`")
            report_lines.append(f"**Prompt:** {tests[0]['prompt']}\n")
            
            for test in tests:
                report_lines.append(f"#### Model: `{test['model']}` (Endpoint: {test['endpoint']})")
                report_lines.append(f"- **Status:** {test['status']}")
                report_lines.append(f"- **Latency:** {test['latency']}")
                report_lines.append(f"\n**Output:**\n")
                report_lines.append(f"{test['result']}\n\n")
                
            report_lines.append("---\n")
            
    with open("report.md", "w", encoding="utf-8") as f:
        f.write("\n".join(report_lines))
    print("Report generated at report.md")

async def main():
    if not os.path.exists("data/manifest.json"):
        print("Manifest not found. Please run setup_data.py first.")
        return
        
    with open("data/manifest.json", "r") as f:
        manifest = json.load(f)
        
    # ONLY RUN LIVE SCREENSHOTS TO SAVE TIME
    manifest = [m for m in manifest if "Live Screenshot" in m["category"]]
    
    print(f"Loaded {len(manifest)} images from manifest.")
    
    # Create an aiohttp session with a larger connection pool to handle concurrency
    conn = aiohttp.TCPConnector(limit_per_host=10)
    async with aiohttp.ClientSession(connector=conn) as session:
        # Discover models
        discovery_tasks = [fetch_models(session, ep) for ep in ENDPOINTS]
        discovery_results = await asyncio.gather(*discovery_tasks)
        
        endpoint_models = {ep: models for ep, models in discovery_results if models}
        
        if not endpoint_models:
            print("No models found on any endpoints. Exiting.")
            return
            
        # Build tasks list
        tasks = []
        for ep, models in endpoint_models.items():
            for model in models:
                for image_data in manifest:
                    print(f"Queueing test for {model} on {image_data['image_path']}")
                    tasks.append(test_vision_model(session, ep, model, image_data))
                    
        print(f"\nStarting {len(tasks)} benchmark tests concurrently...")
        
        # Run tests concurrently
        sem = asyncio.Semaphore(10)
        
        async def sem_task(task):
            async with sem:
                return await task
                
        results = await asyncio.gather(*(sem_task(t) for t in tasks))
        
        print("\nAll tests completed. Generating report...")
        generate_report(results)

if __name__ == "__main__":
    asyncio.run(main())
