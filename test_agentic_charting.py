import pytest
import pandas as pd
import json
import os
from agentic_chart_benchmark import render_chart, fetch_data

# ── Fixtures ──

@pytest.fixture
def mock_df():
    dates = pd.date_range(start="2026-04-01", periods=10, freq="D")
    return pd.DataFrame({
        "Open": [100]*10, "High": [105]*10, "Low": [95]*10,
        "Close": [102]*10, "Volume": [1000]*10,
        "EMA_20": [101]*10, "EMA_50": [100]*10
    }, index=dates)

# ── Rendering Tests ──

def test_render_chart_with_geometric_line(mock_df, tmp_path):
    """A geometric line overlay produces a Plotly line shape in the HTML."""
    spec = {
        "overlays": [{"kind":"line","x0":"2026-04-01","y0":95,"x1":"2026-04-10","y1":95,"color":"green","label":"Support Trendline"}],
        "analysis": "Geometric line test"
    }
    import agentic_chart_benchmark
    old = agentic_chart_benchmark.OUTPUT_DIR
    agentic_chart_benchmark.OUTPUT_DIR = str(tmp_path)
    out = render_chart(mock_df, spec, "TEST_GEO", "Test Timeframe")
    assert os.path.exists(out)
    html = open(out, encoding='utf-8').read()
    assert '"type":"line"' in html
    assert "Support Trendline" in html
    agentic_chart_benchmark.OUTPUT_DIR = old

def test_render_chart_with_liquidity_void(mock_df, tmp_path):
    """A volume_void overlay produces a rect with correct opacity."""
    spec = {
        "overlays": [{"kind":"volume_void","x0":"2026-04-03","x1":"2026-04-06","y0":98,"y1":102,"color":"purple","label":"Liquidity Void"}],
        "analysis": "Void test"
    }
    import agentic_chart_benchmark
    old = agentic_chart_benchmark.OUTPUT_DIR
    agentic_chart_benchmark.OUTPUT_DIR = str(tmp_path)
    out = render_chart(mock_df, spec, "TEST_VOID", "Test Timeframe")
    html = open(out, encoding='utf-8').read()
    assert '"type":"rect"' in html
    assert '"fillcolor":"purple"' in html
    assert '"opacity":0.3' in html
    assert "Liquidity Void" in html
    agentic_chart_benchmark.OUTPUT_DIR = old

def test_render_chart_with_zone_overlay(mock_df, tmp_path):
    """A zone overlay produces a rect with 0.2 opacity."""
    spec = {
        "overlays": [{"kind":"zone","x0":"2026-04-02","x1":"2026-04-08","y0":99,"y1":103,"color":"blue","label":"Demand Zone"}],
        "analysis": "Zone test"
    }
    import agentic_chart_benchmark
    old = agentic_chart_benchmark.OUTPUT_DIR
    agentic_chart_benchmark.OUTPUT_DIR = str(tmp_path)
    out = render_chart(mock_df, spec, "TEST_ZONE", "Test Timeframe")
    html = open(out, encoding='utf-8').read()
    assert '"type":"rect"' in html
    assert '"fillcolor":"blue"' in html
    assert '"opacity":0.2' in html
    agentic_chart_benchmark.OUTPUT_DIR = old

def test_render_chart_empty_overlays(mock_df, tmp_path):
    """An empty overlay list still renders a valid chart."""
    spec = {"overlays": [], "analysis": "No overlays"}
    import agentic_chart_benchmark
    old = agentic_chart_benchmark.OUTPUT_DIR
    agentic_chart_benchmark.OUTPUT_DIR = str(tmp_path)
    out = render_chart(mock_df, spec, "TEST_EMPTY", "Test Timeframe")
    assert os.path.exists(out)
    assert os.path.getsize(out) > 1000  # Valid HTML is > 1KB
    agentic_chart_benchmark.OUTPUT_DIR = old

# ── Data Pipeline Tests ──

def test_fetch_data_columns():
    """Smoke test: yfinance returns all required columns."""
    df = fetch_data("AAPL", period="1mo")
    assert not df.empty
    for col in ["Open", "High", "Low", "Close", "Volume", "EMA_20", "EMA_50"]:
        assert col in df.columns

def test_fetch_data_ema_values():
    """EMA values should be close to Close price, not NaN."""
    df = fetch_data("MSFT", period="1mo")
    assert not df['EMA_20'].isna().all()
    assert not df['EMA_50'].isna().all()

# ── LLM Response Parsing Tests ──

from agentic_chart_benchmark import ask_llm_for_overlays

class MockResponse:
    def __init__(self, data):
        self.status = 200
        self._data = data
    async def json(self):
        return self._data
    async def __aenter__(self):
        return self
    async def __aexit__(self, *a):
        pass

class MockSession:
    def __init__(self, data):
        self._data = data
    def post(self, *a, **kw):
        return MockResponse(self._data)

@pytest.mark.asyncio
async def test_parse_think_tags(mock_df):
    """Reasoning is extracted from <think> tags and excluded from JSON."""
    payload = {"choices":[{"message":{"content":"<think>\nRSI is at 65.\n</think>\n{\"overlays\":[],\"analysis\":\"test\"}"}}]}
    spec, reasoning = await ask_llm_for_overlays(MockSession(payload), mock_df, "T", {"tail": 10, "prompt_label": "Test"})
    assert spec["analysis"] == "test"
    assert "RSI is at 65" in reasoning
    assert "<think>" not in reasoning

@pytest.mark.asyncio
async def test_parse_reasoning_field(mock_df):
    """reasoning_content field takes priority over <think> tags."""
    payload = {"choices":[{"message":{"reasoning_content":"Field reasoning.","content":"{\"overlays\":[],\"analysis\":\"test2\"}"}}]}
    spec, reasoning = await ask_llm_for_overlays(MockSession(payload), mock_df, "T", {"tail": 10, "prompt_label": "Test"})
    assert spec["analysis"] == "test2"
    assert reasoning == "Field reasoning."

@pytest.mark.asyncio
async def test_parse_code_fenced_json(mock_df):
    """JSON wrapped in ```json fences is still parsed correctly."""
    payload = {"choices":[{"message":{"content":"```json\n{\"overlays\":[],\"analysis\":\"fenced\"}\n```"}}]}
    spec, _ = await ask_llm_for_overlays(MockSession(payload), mock_df, "T", {"tail": 10, "prompt_label": "Test"})
    assert spec["analysis"] == "fenced"

# ── Iterative Prompt Tests ──

from server import build_iteration_prompt

def test_iteration_prompt_base():
    """First iteration prompt should NOT contain previous iteration history."""
    prompt = build_iteration_prompt("AAPL", "mock data", 1, [])
    assert "PREVIOUS ITERATIONS" not in prompt
    assert "AAPL" in prompt

def test_iteration_prompt_with_history():
    """Subsequent iterations should include previous specs for self-improvement."""
    prev = [{"iteration": 1, "strategy_name": "EMA Crossover", "confidence": 0.7,
             "analysis": "Bullish crossover.", "overlays": []}]
    prompt = build_iteration_prompt("NVDA", "mock data", 2, prev)
    assert "PREVIOUS ITERATIONS" in prompt
    assert "EMA Crossover" in prompt
    assert "IMPROVE" in prompt
    assert "DIFFERENT" in prompt

def test_iteration_prompt_includes_all_history():
    """All previous iterations should be visible to the LLM."""
    prev = [
        {"iteration": 1, "strategy_name": "Fib Retracement", "confidence": 0.5, "analysis": "a", "overlays": []},
        {"iteration": 2, "strategy_name": "VWAP Analysis", "confidence": 0.6, "analysis": "b", "overlays": []},
    ]
    prompt = build_iteration_prompt("SPY", "mock data", 3, prev)
    assert "Fib Retracement" in prompt
    assert "VWAP Analysis" in prompt
    assert "iteration 3" in prompt.lower() or "Iteration 3" in prompt

# ── Dashboard Build Test ──

def test_dashboard_builds_without_crash(tmp_path):
    """Dashboard HTML is generated without errors, even with no results."""
    import build_dashboard
    old = build_dashboard.OUTPUT_DIR
    build_dashboard.OUTPUT_DIR = str(tmp_path)
    # Create empty results
    with open(os.path.join(str(tmp_path), "results.json"), "w") as f:
        json.dump([], f)
    build_dashboard.build_dashboard()
    assert os.path.exists(os.path.join(str(tmp_path), "index.html"))
    html = open(os.path.join(str(tmp_path), "index.html"), encoding='utf-8').read()
    assert "Agentic Quant Lab" in html
    build_dashboard.OUTPUT_DIR = old
