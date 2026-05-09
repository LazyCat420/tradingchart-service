import os, json, datetime

OUTPUT_DIR = "benchmark_charts"

def build_dashboard():
    rp = os.path.join(OUTPUT_DIR, "results.json")
    if os.path.exists(rp):
        with open(rp) as f:
            results = json.load(f)
    else:
        results = []

    total = len(results)
    success = sum(1 for r in results if r.get("status") == "success")
    failed = total - success
    rate = (success / total * 100) if total > 0 else 0
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rj = json.dumps(results)

    html = f"""<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agentic Quant Lab</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
:root{{--bg:#080c14;--s1:#0d1117;--s2:#161b22;--s3:#1c2333;--bd:#21262d;--bd2:#30363d;
--tx:#e6edf3;--txd:#8b949e;--txf:#484f58;--cy:#58a6ff;--gn:#3fb950;--rd:#f85149;
--am:#d29922;--pu:#bc8cff;--tl:#39d2c0;--gcn:rgba(88,166,255,.12);--ggn:rgba(63,185,80,.12)}}
body{{font-family:'Inter',sans-serif;background:var(--bg);color:var(--tx);height:100vh;display:flex;flex-direction:column;overflow:hidden}}

.top{{height:44px;background:var(--s1);border-bottom:1px solid var(--bd);display:flex;align-items:center;padding:0 16px;gap:16px;flex-shrink:0}}
.top .logo{{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13px;color:var(--cy);letter-spacing:1px;text-transform:uppercase}}
.top .sep{{width:1px;height:22px;background:var(--bd)}}
.top .m{{font-size:11px;color:var(--txd);font-family:'JetBrains Mono',monospace}}
.top .m b{{color:var(--tx)}}
.pills{{display:flex;gap:6px;margin-left:auto}}
.pill{{padding:3px 8px;border-radius:3px;font-size:10px;font-weight:700;font-family:'JetBrains Mono',monospace}}
.pill.g{{background:var(--ggn);color:var(--gn);border:1px solid rgba(63,185,80,.3)}}
.pill.r{{background:rgba(248,81,73,.1);color:var(--rd);border:1px solid rgba(248,81,73,.3)}}
.pill.b{{background:var(--gcn);color:var(--cy);border:1px solid rgba(88,166,255,.3)}}

.body{{flex:1;display:flex;overflow:hidden}}

/* SIDEBAR */
.side{{width:300px;background:var(--s1);border-right:1px solid var(--bd);display:flex;flex-direction:column;flex-shrink:0}}
.side-head{{padding:12px;border-bottom:1px solid var(--bd)}}
.side-head h2{{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--txd);font-weight:600;margin-bottom:8px}}

/* TICKER INPUT */
.input-row{{display:flex;gap:6px}}
.input-row input{{flex:1;background:var(--s3);border:1px solid var(--bd);border-radius:4px;padding:6px 8px;color:var(--tx);font-size:12px;font-family:'JetBrains Mono',monospace;outline:none}}
.input-row input:focus{{border-color:var(--cy)}}
.input-row input::placeholder{{color:var(--txf)}}
.input-row button{{padding:6px 10px;background:var(--cy);color:#000;border:none;border-radius:4px;font-weight:700;font-size:11px;cursor:pointer;white-space:nowrap}}
.input-row button:hover{{filter:brightness(1.15)}}
.input-row button:disabled{{opacity:.4;cursor:not-allowed}}

.iter-row{{display:flex;align-items:center;gap:8px;margin-top:8px}}
.iter-row label{{font-size:10px;color:var(--txd);text-transform:uppercase;letter-spacing:1px}}
.iter-row select{{background:var(--s3);border:1px solid var(--bd);color:var(--tx);padding:4px 6px;border-radius:4px;font-size:11px;font-family:'JetBrains Mono',monospace}}

.tklist{{flex:1;overflow-y:auto;padding:6px}}
.tk{{padding:8px 10px;border-radius:5px;cursor:pointer;display:flex;align-items:center;gap:8px;margin-bottom:3px;transition:all .12s;border:1px solid transparent;position:relative}}
.tk:hover{{background:var(--s2);border-color:var(--bd)}}
.tk.active{{background:var(--s3);border-color:var(--cy)}}
.tk .dot{{width:7px;height:7px;border-radius:50%;flex-shrink:0}}
.tk .dot.ok{{background:var(--gn);box-shadow:0 0 5px var(--gn)}}
.tk .dot.err{{background:var(--rd);box-shadow:0 0 5px var(--rd)}}
.tk .sym{{font-weight:700;font-size:13px;font-family:'JetBrains Mono',monospace;min-width:48px}}
.tk .inf{{font-size:10px;color:var(--txd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}}
.tk .iter-badge{{font-size:9px;background:var(--gcn);color:var(--cy);padding:1px 5px;border-radius:3px;font-family:'JetBrains Mono',monospace}}

/* CENTER */
.center{{flex:1;display:flex;flex-direction:column;overflow:hidden}}
.chart-bar{{height:32px;background:var(--s2);border-bottom:1px solid var(--bd);display:flex;align-items:center;padding:0 12px;gap:12px;flex-shrink:0}}
.chart-bar span{{font-size:11px;font-family:'JetBrains Mono',monospace;color:var(--txf)}}
.chart-bar .active-sym{{color:var(--cy);font-weight:700}}
.chart-bar .strat{{color:var(--pu)}}
.chart-bar .conf{{color:var(--gn)}}
.chart-wrap{{flex:1;position:relative}}
.chart-wrap iframe{{width:100%;height:100%;border:none;background:transparent}}

/* BOTTOM */
.bottom{{height:210px;display:flex;border-top:1px solid var(--bd);flex-shrink:0}}
.pan{{flex:1;display:flex;flex-direction:column;background:var(--s1);overflow:hidden}}
.pan+.pan{{border-left:1px solid var(--bd)}}
.pan-h{{padding:8px 14px;border-bottom:1px solid var(--bd);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}}
.pan-h h3{{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:var(--txd);font-weight:600}}
.pan-h .tag{{font-size:9px;padding:2px 6px;border-radius:3px;font-family:'JetBrains Mono',monospace}}
.pan-b{{flex:1;overflow-y:auto;padding:10px 14px;font-size:12px;line-height:1.65}}
.pan-b.mono{{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--tl);white-space:pre-wrap}}
.pan-b.summ{{color:var(--tx)}}

/* ACTION COL */
.act{{width:180px;background:var(--s2);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;flex-shrink:0;border-left:1px solid var(--bd)}}
.act .lb{{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:var(--txf)}}
.ab{{width:100%;padding:10px;border:none;border-radius:5px;font-weight:700;font-size:12px;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s}}
.ab.ap{{background:var(--gn);color:#000}}
.ab.ap:hover{{filter:brightness(1.2)}}
.ab.rj{{background:var(--s3);color:var(--txd);border:1px solid var(--bd)}}
.ab.rj:hover{{border-color:var(--rd);color:var(--rd)}}
.ab.re{{background:var(--gcn);color:var(--cy);border:1px solid rgba(88,166,255,.3);font-size:11px}}
.ab.re:hover{{filter:brightness(1.2)}}
.ab.sk{{background:transparent;color:var(--txf);font-size:10px;padding:6px}}
.ab.sk:hover{{color:var(--cy)}}

/* STATUS BAR */
.stat{{height:22px;background:var(--s1);border-top:1px solid var(--bd);display:flex;align-items:center;padding:0 14px;gap:14px;flex-shrink:0}}
.stat span{{font-size:9px;font-family:'JetBrains Mono',monospace;color:var(--txf)}}
.stat .live{{color:var(--gn)}}
.stat #status-msg{{color:var(--am);margin-left:auto}}

/* SPINNER */
@keyframes spin{{to{{transform:rotate(360deg)}}}}
.spinner{{width:14px;height:14px;border:2px solid var(--bd);border-top-color:var(--cy);border-radius:50%;animation:spin .6s linear infinite;display:none}}
.spinner.on{{display:inline-block}}

::-webkit-scrollbar{{width:5px}}::-webkit-scrollbar-track{{background:transparent}}
::-webkit-scrollbar-thumb{{background:var(--bd);border-radius:3px}}::-webkit-scrollbar-thumb:hover{{background:var(--bd2)}}
</style></head>
<body>

<div class="top">
<div class="logo">◈ Agentic Quant Lab</div><div class="sep"></div>
<div class="m">MODEL: <b>Qwen3.5-122B</b></div><div class="sep"></div>
<div class="m">RUN: <b>{ts}</b></div>
<div class="spinner" id="spinner"></div>
<div class="pills">
<div class="pill g" id="pill-pass">{success} PASS</div>
<div class="pill r" id="pill-fail">{failed} FAIL</div>
<div class="pill b" id="pill-rate">{rate:.0f}%</div>
</div>
</div>

<div class="body">
<div class="side">
<div class="side-head">
<h2>Add Tickers</h2>
<div class="input-row">
<input id="ticker-input" placeholder="AAPL, TSLA, NVDA..." />
<button id="run-btn" onclick="submitTickers()">▶ RUN</button>
</div>
<div class="iter-row">
<label>Iterations:</label>
<select id="iter-select"><option value="1">1 (single pass)</option><option value="2">2 (refine)</option><option value="3" selected>3 (deep)</option></select>
</div>
</div>
<div class="tklist" id="ticker-list"></div>
</div>
<div class="center">
<div class="chart-bar">
<span class="active-sym" id="bar-sym">—</span>
<span class="strat" id="bar-strat"></span>
<span class="conf" id="bar-conf"></span>
</div>
<div class="chart-wrap"><iframe id="chart-frame" src="about:blank"></iframe></div>
</div>
</div>

<div class="bottom">
<div class="pan"><div class="pan-h"><h3>LLM Analysis</h3><div class="tag" style="background:var(--gcn);color:var(--cy)" id="ov-tag">—</div></div>
<div class="pan-b summ" id="analysis-text">Submit tickers above to begin analysis.</div></div>
<div class="pan"><div class="pan-h"><h3>Chain-of-Thought</h3><div class="tag" style="background:rgba(188,140,255,.12);color:var(--pu)">REASONING</div></div>
<div class="pan-b mono" id="reasoning-text">Waiting...</div></div>
<div class="act">
<div class="lb">Agent Decision</div>
<button class="ab re" onclick="reIterate()">↻ Re-Iterate</button>
<button class="ab ap" onclick="handleAction('APPROVE')">✓ Approve</button>
<button class="ab rj" onclick="handleAction('REJECT')">✗ Reject</button>
<button class="ab sk" onclick="handleAction('SKIP')">Skip →</button>
</div>
</div>

<div class="stat">
<span class="live">● ONLINE</span>
<span>CONCURRENCY: 5</span><span>PERIOD: 3mo</span>
<span>OVERLAYS: line · zone · void</span>
<span id="status-msg"></span>
</div>

<script>
let results = {rj};
const POLL_MS = 3000;
let activeIdx = -1;
let polling = false;

const $ = id => document.getElementById(id);

function renderList() {{
  const el = $('ticker-list');
  el.innerHTML = '';
  results.forEach((r, i) => {{
    const d = document.createElement('div');
    d.className = 'tk' + (i === activeIdx ? ' active' : '');
    d.dataset.idx = i;
    d.onclick = () => selectItem(i);

    const dot = document.createElement('div');
    dot.className = 'dot ' + (r.status === 'success' ? 'ok' : 'err');

    const sym = document.createElement('span');
    sym.className = 'sym';
    sym.textContent = r.symbol;

    const inf = document.createElement('span');
    inf.className = 'inf';
    inf.textContent = r.status === 'success' ? (r.strategy_name || r.analysis || '').substring(0, 40) : 'ERROR';

    d.appendChild(dot);
    d.appendChild(sym);
    d.appendChild(inf);

    if (r.iterations && r.iterations > 1) {{
      const badge = document.createElement('span');
      badge.className = 'iter-badge';
      badge.textContent = 'x' + r.iterations;
      d.appendChild(badge);
    }}

    el.appendChild(d);
  }});
  if (results.length > 0 && activeIdx < 0) selectItem(0);
}}

function selectItem(i) {{
  activeIdx = i;
  const r = results[i];
  document.querySelectorAll('.tk').forEach(e => e.classList.remove('active'));
  const t = document.querySelector('.tk[data-idx="'+i+'"]');
  if (t) t.classList.add('active');

  $('bar-sym').textContent = r.symbol;
  $('bar-strat').textContent = r.strategy_name ? '· ' + r.strategy_name : '';
  $('bar-conf').textContent = r.confidence ? '· conf: ' + (r.confidence * 100).toFixed(0) + '%' : '';

  if (r.status === 'success') {{
    $('chart-frame').src = r.symbol + '.html';
    $('analysis-text').textContent = r.analysis || 'No analysis.';
    $('reasoning-text').textContent = r.reasoning || 'No trace captured.';
    $('ov-tag').textContent = (r.iterations || 1) + ' iter';
  }} else {{
    $('chart-frame').src = 'about:blank';
    $('analysis-text').textContent = '⚠ ' + (r.error || 'Unknown error');
    $('reasoning-text').textContent = r.reasoning || 'Failed.';
    $('ov-tag').textContent = 'ERR';
  }}
}}

function submitTickers() {{
  const raw = $('ticker-input').value;
  if (!raw.trim()) return;
  const tickers = raw.split(/[,\\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
  const iters = parseInt($('iter-select').value);

  $('run-btn').disabled = true;
  $('spinner').classList.add('on');
  $('status-msg').textContent = 'Analyzing ' + tickers.join(', ') + '...';

  fetch('/api/analyze', {{
    method: 'POST',
    headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify({{tickers, iterations: iters}})
  }}).then(r => r.json()).then(d => {{
    console.log('[API]', d);
    startPolling();
  }}).catch(e => {{
    $('status-msg').textContent = 'Error: ' + e.message;
    $('run-btn').disabled = false;
    $('spinner').classList.remove('on');
  }});
}}

function startPolling() {{
  if (polling) return;
  polling = true;
  const iv = setInterval(() => {{
    fetch('/api/results').then(r => r.json()).then(data => {{
      const oldLen = results.length;
      results = data;
      updatePills();
      renderList();
      if (results.length > oldLen) selectItem(results.length - 1);
    }}).catch(() => {{}});

    // Check if still running by looking for status changes
    fetch('/api/status').then(r => r.json()).then(s => {{
      const total = s.tickers_loaded;
      $('status-msg').textContent = total + ' tickers loaded · ' + s.total_iterations + ' total iterations';
    }}).catch(() => {{}});
  }}, POLL_MS);

  // Stop after 10 min max
  setTimeout(() => {{
    clearInterval(iv);
    polling = false;
    $('run-btn').disabled = false;
    $('spinner').classList.remove('on');
    $('status-msg').textContent = 'Polling stopped.';
  }}, 600000);

  // Also stop when we detect completion (check every poll)
  const checker = setInterval(() => {{
    // Simple heuristic: if button is still disabled but we've been idle, re-enable
    fetch('/api/results').then(r => r.json()).then(data => {{
      if (data.length >= results.length && data.length > 0) {{
        // Might be done — re-enable after a grace period
        setTimeout(() => {{
          $('run-btn').disabled = false;
          $('spinner').classList.remove('on');
        }}, 5000);
      }}
      results = data;
      updatePills();
      renderList();
    }}).catch(() => {{}});
  }}, 8000);
}}

function updatePills() {{
  const s = results.filter(r => r.status === 'success').length;
  const f = results.length - s;
  const pct = results.length ? (s / results.length * 100).toFixed(0) : 0;
  $('pill-pass').textContent = s + ' PASS';
  $('pill-fail').textContent = f + ' FAIL';
  $('pill-rate').textContent = pct + '%';
}}

function reIterate() {{
  if (activeIdx < 0) return;
  const sym = results[activeIdx].symbol;
  $('spinner').classList.add('on');
  $('status-msg').textContent = 'Re-iterating ' + sym + '...';
  fetch('/api/analyze', {{
    method: 'POST',
    headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify({{tickers: [sym], iterations: 1}})
  }}).then(r => r.json()).then(() => startPolling());
}}

function handleAction(action) {{
  if (activeIdx < 0) return;
  console.log('[DECISION]', action, results[activeIdx].symbol);
  const btn = action === 'APPROVE' ? $('run-btn') : null;
  if (activeIdx < results.length - 1) setTimeout(() => selectItem(activeIdx + 1), 400);
}}

renderList();
</script>
</body></html>"""

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(os.path.join(OUTPUT_DIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Dashboard built: {os.path.abspath(os.path.join(OUTPUT_DIR, 'index.html'))}")

if __name__ == "__main__":
    build_dashboard()
