import re
from playwright.sync_api import Page, expect
import pytest

URL = "http://127.0.0.1:3000"

@pytest.fixture(scope="session")
def browser_context_args(browser_context_args):
    return {
        **browser_context_args,
        "viewport": {
            "width": 1280,
            "height": 720,
        }
    }

def test_dashboard_loads_and_displays_initial_ui(page: Page):
    """Smoke test to ensure the dashboard loads and UI elements are visible."""
    page.goto(URL)
    expect(page.locator(".logo")).to_contain_text("Agentic Quant Lab")
    expect(page.locator("#clock")).to_be_visible()
    expect(page.locator("#ticker-input")).to_be_visible()
    expect(page.locator(".run-btn")).to_be_visible()

def test_model_switching(page: Page):
    """Test switching models updates the active model."""
    page.goto(URL)
    
    # Open the dropdown first
    page.locator("#model-toggle").click()
    
    model_opts = page.locator(".model-opt")
    expect(model_opts).to_have_count(2)
    
    # Click the second model
    model_opts.nth(1).click()
    
    # Check that it's active
    expect(model_opts.nth(1)).to_have_class(re.compile(r"active"))
    
    # Check the model name updated (e.g. Qwen3.5-35B (30))
    expect(page.locator("#model-name")).to_contain_text("Qwen")

def test_add_ticker_and_run(page: Page):
    """Test adding a ticker sets the state."""
    page.goto(URL)
    
    # Clear localStorage to start fresh
    page.evaluate("window.localStorage.clear();")
    page.reload()
    
    # We mock out runAnalysis to just see if the ticker gets added to the UI list
    # because actually running analysis against LLM takes time.
    page.locator("#ticker-input").fill("TSLA")
    # Actually wait, we can't easily mock `runAnalysis` because it's in a module, 
    # but we can intercept the API calls.
    page.route("**/api/data*", lambda route: route.fulfill(
        status=200,
        json={"symbol": "TSLA", "period": "3mo", "data": [
            {"date":"2026-05-01","open":100,"high":110,"low":90,"close":105,"volume":1000}
        ]}
    ))
    
    # Route for LLM stream
    page.route("**/api/llm/stream", lambda route: route.fulfill(
        status=200,
        body="data: {\"choices\":[{\"message\":{\"content\":\"```json\\n{\\\"overlays\\\":[], \\\"analysis\\\":\\\"Test\\\"}\\n```\"}}]}\n\n"
    ))
    
    page.locator(".run-btn").click()
    
    # Check if ticker is in the list
    expect(page.locator(".sym").first).to_have_text("TSLA")
    
    # The status should change to analyzing or pass/fail eventually
    expect(page.locator(".inf").first).not_to_be_empty()

def test_timeframe_tabs(page: Page):
    """Test switching between timeframes."""
    page.goto(URL)
    
    tabs = page.locator(".tf-tab")
    expect(tabs).to_have_count(3)
    
    # Click Medium Term
    tabs.nth(1).click()
    expect(tabs.nth(1)).to_have_class(re.compile(r"active"))
    expect(tabs.nth(0)).not_to_have_class(re.compile(r"active"))
    
    # Click Long Term
    tabs.nth(2).click()
    expect(tabs.nth(2)).to_have_class(re.compile(r"active"))

def test_carousel_navigation(page: Page):
    """Test strategy carousel prev/next buttons."""
    page.goto(URL)
    
    # We just ensure the buttons are present and don't throw errors when clicked without data
    prev_btn = page.locator("button[onclick='prevStrategy()']").first
    next_btn = page.locator("button[onclick='nextStrategy()']").first
    
    expect(prev_btn).to_be_visible()
    expect(next_btn).to_be_visible()
    
    prev_btn.click()
    next_btn.click()

def test_agentic_tool_loop(page: Page):
    """Test that the agentic tool loop successfully executes tool calls, updates the log panel, and then renders the chart without getting stuck."""
    page.goto(URL)
    page.evaluate("window.localStorage.clear();")
    page.reload()
    
    page.route("**/api/data*", lambda route: route.fulfill(
        status=200,
        json={"symbol": "NVDA", "period": "3mo", "data": [
            {"date":"2026-05-01","open":100,"high":110,"low":90,"close":105,"volume":1000}
        ]}
    ))
    
    # We will simulate 2 chunks of stream data.
    # Chunk 1: A tool call formatted similarly to Qwen (with markdown)
    # Chunk 2: The final JSON output
    # Playwright's `route.fulfill` doesn't easily do chunked streaming out of the box,
    # so we will simulate it by returning the full response immediately but we must
    # include the markdown tool call to ensure the regex catches it.
    
    call_count = [0]
    
    def handle_llm_stream(route):
        if call_count[0] == 0:
            call_count[0] += 1
            route.fulfill(
                status=200,
                headers={"Content-Type": "text/event-stream"},
                body='data: {"choices":[{"delta":{"content":"**TOOL_CALL: CALC_RSI()**\\n"}}]}\n\n'
            )
        else:
            route.fulfill(
                status=200,
                headers={"Content-Type": "text/event-stream"},
                body='data: {"choices":[{"delta":{"content":"```json\\n{\\"overlays\\\":[{\\"kind\\\":\\"line\\",\\"x0\\\":\\"2026-05-01\\",\\"y0\\\":100,\\"x1\\\":\\"2026-05-10\\",\\"y1\\\":100,\\"color\\\":\\"green\\",\\"label\\\":\\"test\\"}]}\\n```"}}]}\n\n'
            )

    page.route("**/api/llm/stream", handle_llm_stream)
    
    page.locator("#ticker-input").fill("NVDA")
    # Only run 1 iteration total to prevent parallel requests from stealing the mock counter
    page.locator("#iter-short").fill("1")
    page.locator("#iter-medium").fill("0")
    page.locator("#iter-long").fill("0")
    page.locator(".run-btn").click()
    
    # Wait for the iteration to complete
    expect(page.locator(".sym").first).to_have_text("NVDA")
    
    # Verify the tool log says 1 CALL
    expect(page.locator("#tool-count-tag")).to_have_text(re.compile(r"1 CALL"))
    
    # Verify the chart has been rendered (the tag updates with overlay count)
    expect(page.locator("#ov-tag")).to_contain_text("strat")
