import urllib.request
import urllib.error

req = urllib.request.Request('http://localhost:3000/api/llm/models', headers={'x-vllm-endpoint': 'http://10.0.0.30:8000/v1/chat/completions'})
try:
    print(urllib.request.urlopen(req).read()[:100])
except urllib.error.HTTPError as e:
    print('Error code:', e.code)
    print(e.read()[:200])
