"""
Minimal data proxy — the ONLY Python needed.
Fetches Yahoo Finance data and proxies LLM requests (CORS workaround).
Supports both streaming (SSE) and non-streaming LLM requests.
All logic lives in the browser.
"""
import os, json, http.server, urllib.parse, urllib.request
import yfinance as yf, pandas as pd

PORT = 3000
VLLM_ENDPOINT = "http://10.0.0.141:8000/v1/chat/completions"
STATIC_DIR = "benchmark_charts"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC_DIR, **kw)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-vllm-endpoint")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        if p.path == "/api/data":
            qs = urllib.parse.parse_qs(p.query)
            sym = qs.get("symbol", ["AAPL"])[0].upper()
            period = qs.get("period", ["3mo"])[0]
            interval = qs.get("interval", ["1d"])[0]
            try:
                df = yf.Ticker(sym).history(period=period, interval=interval)
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = df.columns.get_level_values(0)
                if df.index.tz is not None:
                    df.index = df.index.tz_localize(None)
                records = []
                for dt, row in df.iterrows():
                    records.append({
                        "date": dt.strftime("%Y-%m-%d"),
                        "open": round(row["Open"], 2),
                        "high": round(row["High"], 2),
                        "low": round(row["Low"], 2),
                        "close": round(row["Close"], 2),
                        "volume": int(row["Volume"])
                    })
                self._json({"symbol": sym, "period": period, "data": records})
            except Exception as e:
                self._json({"error": str(e)}, 500)
        else:
            if p.path == "/":
                self.path = "/index.html"
            elif p.path == "/api/llm/models":
                target = self.headers.get("x-vllm-endpoint", VLLM_ENDPOINT)
                base = target.replace("/chat/completions", "")
                req = urllib.request.Request(f"{base}/models")
                print(f"[DEBUG proxy] target: {target}, base: {base}, req: {req.full_url}")
                try:
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        self._raw(resp.read())
                except Exception as e:
                    self._json({"error": str(e)}, 502)
                return
            elif p.path == "/api/llm/health":
                target = self.headers.get("x-vllm-endpoint", VLLM_ENDPOINT)
                base = target.replace("/v1/chat/completions", "")
                req = urllib.request.Request(f"{base}/health")
                try:
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        self._raw(resp.read(), resp.status)
                except urllib.error.HTTPError as e:
                    self._raw(e.read() if hasattr(e, 'read') else b'', e.code)
                except Exception as e:
                    self._json({"error": str(e)}, 502)
            elif p.path == "/api/llm/metrics":
                target = self.headers.get("x-vllm-endpoint", VLLM_ENDPOINT)
                base = target.replace("/v1/chat/completions", "")
                req = urllib.request.Request(f"{base}/metrics")
                try:
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        self._raw(resp.read(), resp.status, content_type="text/plain")
                except urllib.error.HTTPError as e:
                    self._raw(e.read() if hasattr(e, 'read') else b'', e.code, content_type="text/plain")
                except Exception as e:
                    self._json({"error": str(e)}, 502)
                return
            super().do_GET()

    def do_POST(self):
        p = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        if p.path == "/api/llm":
            # Non-streaming proxy
            target = self.headers.get("x-vllm-endpoint", VLLM_ENDPOINT)
            req = urllib.request.Request(
                target, data=body,
                headers={"Content-Type": "application/json"}, method="POST"
            )
            try:
                with urllib.request.urlopen(req, timeout=300) as resp:
                    self._raw(resp.read())
            except Exception as e:
                self._json({"error": str(e)}, 502)

        elif p.path == "/api/llm/stream":
            # Streaming SSE proxy — pipe chunks from vLLM to browser
            target = self.headers.get("x-vllm-endpoint", VLLM_ENDPOINT)
            req = urllib.request.Request(
                target, data=body,
                headers={"Content-Type": "application/json"}, method="POST"
            )
            try:
                resp = urllib.request.urlopen(req, timeout=300)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, x-vllm-endpoint")
                http.server.SimpleHTTPRequestHandler.end_headers(self)

                while True:
                    chunk = resp.read(512)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
                resp.close()
            except urllib.error.HTTPError as e:
                err_body = e.read() if hasattr(e, 'read') else b''
                self._raw(err_body, e.code)
            except Exception as e:
                self._json({"error": str(e)}, 502)
        else:
            self._json({"error": "not found"}, 404)

    def _json(self, obj, code=200):
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(obj).encode())
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def _raw(self, data, code=200, content_type="application/json"):
        try:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.end_headers()
            self.wfile.write(data)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def log_message(self, fmt, *args):
        msg = args[0] if args else ""
        if "/api/" in str(msg):
            print(f"[PROXY] {msg}")


if __name__ == "__main__":
    os.makedirs(STATIC_DIR, exist_ok=True)
    print(f"{'='*50}")
    print(f"  AGENTIC QUANT LAB — Data Proxy")
    print(f"  http://localhost:{PORT}")
    print(f"  LLM relay  -> {VLLM_ENDPOINT}")
    print(f"  Static dir -> {os.path.abspath(STATIC_DIR)}")
    print(f"{'='*50}")
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
