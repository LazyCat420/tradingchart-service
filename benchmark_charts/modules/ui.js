/**
 * ui.js — All DOM manipulation and UI rendering.
 * No network I/O. Reads from state, writes to DOM.
 */
import { TIMEFRAMES, TF_ORDER, STRATEGY_LENSES, MODELS } from './config.js';
import { state, saveState, saveTickerData, isCurrentView } from './state.js';
import { renderChart, renderEmptyChart } from './chart.js';
import { fetchData } from './api.js';
import { TOOL_REGISTRY } from './tools.js';

// ── DOM Helper ──
export function $(id) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`[UI] Element #${id} not found`);
    return {
      textContent: '', innerHTML: '', style: {},
      scrollTop: 0, scrollHeight: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      dataset: {}, addEventListener() {},
    };
  }
  return el;
}

// ── Agent Tool Log Panel ──
export function updateAgentLogPanel(toolLog) {
  const el = $('agent-log');
  if (!toolLog || !toolLog.length) {
    el.innerHTML = '<div class="tool-empty">⚡ Tools: Wikipedia · ArXiv · RSI · Z-Score · Bollinger · ATR · Fibonacci · Memory</div>';
    $('tool-count-tag').textContent = '0 CALLS';
    return;
  }
  el.innerHTML = toolLog.map(t => {
    const cls = t.status === 'calling' ? 'calling' : t.status === 'error' ? 'error' : 'done';
    const icon = TOOL_REGISTRY[t.tool]?.icon || '🔧';
    const statusText = t.status === 'calling' ? '⏳ Calling...' : t.status === 'error' ? '✗ Error' : `✓ Done (${t.elapsed || 0}ms)`;
    const resultHtml = t.result ? `<div class="tool-result">${t.result.replace(/</g, '&lt;').slice(0, 300)}</div>` : '';
    return `<div class="tool-entry ${cls}"><div class="tool-name">${icon} ${t.tool}(${(t.params || '').slice(0, 40)})</div><div class="tool-status">${statusText}</div>${resultHtml}</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
  $('tool-count-tag').textContent = toolLog.length + ' CALL' + (toolLog.length !== 1 ? 'S' : '');
}

// ── Spinner ──
export function updateSpinner() {
  $('spinner').style.display = state.runningCount > 0 ? 'inline-block' : 'none';
}

// ── Pills (pass/fail/rate) ──
export function updatePills() {
  const s = state.tickers.filter(t => t.status === 'success').length;
  const f = state.tickers.filter(t => t.status === 'error').length;
  $('pill-pass').textContent = s + ' PASS';
  $('pill-fail').textContent = f + ' FAIL';
  $('pill-rate').textContent = state.tickers.length ? (s / state.tickers.length * 100).toFixed(0) + '%' : '—';
}

// ── Timeframe Tab Indicators ──
export function updateTfTabs(t) {
  document.querySelectorAll('.tf-tab').forEach(btn => {
    const tf = btn.dataset.tf;
    btn.classList.remove('has-data', 'has-error');
    if (t && t.tf?.[tf]) {
      if (t.tf[tf].status === 'success') btn.classList.add('has-data');
      else if (t.tf[tf].status === 'error') btn.classList.add('has-error');
    }
  });
}

// ── Strategy Carousel ──
export function updateStrategyCarousel(t, tfKey) {
  const specs = t?.tf?.[tfKey]?.prevSpecs || [];
  const counterEl = $('strat-counter');
  if (!specs.length) { counterEl.textContent = '—'; return; }

  if (state.activeStratIdx < 0) state.activeStratIdx = 0;
  if (state.activeStratIdx >= specs.length) state.activeStratIdx = specs.length - 1;

  const s = specs[state.activeStratIdx];
  const lensLabel = STRATEGY_LENSES.find(l => l.id === s.lens)?.name || s.lens || '?';
  const scoreText = s.forward_result ? ` | ${(s.forward_result.score * 100).toFixed(0)}%` : '';
  counterEl.innerHTML = `<b>${state.activeStratIdx + 1}</b>/${specs.length} · ${lensLabel}${scoreText}`;
}

// ── Bottom Panels (Analysis + Log) ──
export function updateBottom(t) {
  const tfd = t.tf?.[state.activeTF];
  if (!tfd) {
    $('analysis-text').textContent = t.error || 'No analysis yet.';
    updateAgentLogPanel([]);
    $('ov-tag').textContent = '—';
    return;
  }
  const specs = tfd.prevSpecs || [];
  const viewSpec = specs[state.activeStratIdx];
  if (viewSpec) {
    let text = viewSpec.analysis || '';
    if (viewSpec.prediction) {
      const p = viewSpec.prediction;
      text += `\n\n🎯 Prediction: ${p.direction} | Target: $${p.target_price} | Stop: $${p.stop_loss} | Horizon: ${p.horizon_days}d`;
    }
    if (viewSpec.forward_result) {
      const fr = viewSpec.forward_result;
      text += `\n📊 Score: ${(fr.score * 100).toFixed(0)}% | Dir: ${fr.direction_correct ? '✓' : '✗'} | Target: ${fr.target_hit ? '✓' : '✗'} | Move: ${fr.actual_move_pct}%`;
    }
    $('analysis-text').textContent = text;
  } else {
    $('analysis-text').textContent = tfd.analysis || tfd.error || t.error || 'No analysis yet.';
  }
  updateAgentLogPanel(tfd.toolLog || []);
  const stratCount = specs.length;
  $('ov-tag').textContent = stratCount ? stratCount + ' strat' + (stratCount > 1 ? 's' : '') : '—';
}

// ── Ticker List ──
export function renderList() {
  const el = $('ticker-list');
  el.innerHTML = '';
  state.tickers.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'tk' + (i === state.activeIdx ? ' active' : '');
    d.dataset.idx = i;
    d.onclick = () => selectItem(i);

    const dot = document.createElement('div');
    const dotClass = t.status === 'success' ? 'ok' : t.status === 'error' ? 'err' : t.status === 'running' ? 'run' : '';
    dot.className = 'dot ' + dotClass;

    const sym = document.createElement('span');
    sym.className = 'sym';
    sym.textContent = t.symbol;

    const inf = document.createElement('span');
    inf.className = 'inf';
    const tfDone = TF_ORDER.filter(tf => t.tf?.[tf]?.status === 'success').length;
    const tfInfo = t.tf?.[state.activeTF];
    if (t.status === 'success') {
      inf.textContent = `${tfDone}/3 TF · ${(tfInfo?.strategy_name || tfInfo?.analysis || '').slice(0, 25)}`;
    } else if (t.status === 'error') {
      inf.textContent = tfDone > 0 ? `${tfDone}/3 TF · partial` : 'ERROR';
    } else if (t.status === 'running') {
      const runningTF = TF_ORDER.find(tf => t.tf?.[tf]?.status === 'running');
      const runLabel = runningTF ? TIMEFRAMES[runningTF].label : '';
      inf.textContent = `${tfDone}/3 TF · ${runLabel || 'analyzing...'}`;
    } else {
      inf.textContent = 'pending';
    }

    d.appendChild(dot);
    d.appendChild(sym);
    d.appendChild(inf);

    const totalIters = TF_ORDER.reduce((sum, tf) => sum + (t.tf?.[tf]?.iterations || 0), 0);
    if (totalIters > 1) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'x' + totalIters;
      d.appendChild(b);
    }

    const delBtn = document.createElement('span');
    delBtn.className = 'del-btn';
    delBtn.innerHTML = '✕';
    delBtn.title = 'Delete Ticker';
    delBtn.onclick = (e) => window.deleteTicker(i, e);
    d.appendChild(delBtn);

    el.appendChild(d);
  });
}

// ── Show a timeframe's data/chart/analysis ──
export function showTimeframe(t, tfKey) {
  const tfd = t.tf?.[tfKey];
  if (!tfd) return;

  const specs = tfd.prevSpecs || [];
  const viewSpec = specs[state.activeStratIdx] || null;
  const tfConfig = TIMEFRAMES[tfKey];

  // Update bar info
  $('bar-strat').textContent = viewSpec ? '· ' + viewSpec.strategy_name + ' (' + (viewSpec.lens || '?') + ')' : '';
  $('bar-conf').textContent = viewSpec?.confidence ? '· conf: ' + (viewSpec.confidence * 100).toFixed(0) + '%' : '';

  if (tfd.data && viewSpec) {
    renderChart(tfd.data, viewSpec, t.symbol, tfConfig.label);
  } else if (tfd.data && !viewSpec) {
    renderChart(tfd.data, { overlays: [] }, t.symbol, tfConfig.label);
  } else if (!tfd.data && viewSpec) {
    $('status-msg').textContent = `Re-fetching ${t.symbol} ${tfConfig.label} data...`;
    fetchData(t.symbol, tfConfig.range, tfConfig.interval).then(d => {
      tfd.data = d;
      saveTickerData(t.symbol, tfKey, d);
      renderChart(d, viewSpec, t.symbol, tfConfig.label);
      $('status-msg').textContent = 'Chart restored for ' + t.symbol + ' ' + tfConfig.label;
    }).catch(e => {
      $('status-msg').textContent = '⚠ Re-fetch failed: ' + e.message;
    });
  } else {
    renderEmptyChart(t.symbol, tfConfig.label);
    $('analysis-text').textContent = `No ${tfConfig.label} data yet. Analysis will appear when this timeframe is processed.`;
    updateAgentLogPanel([]);
    $('ov-tag').textContent = '—';
    return;
  }

  // Show text panels
  if (tfd.status === 'running') {
    $('analysis-text').textContent = tfd.liveContent || '⏳ Processing...';
    updateAgentLogPanel(tfd.toolLog || []);
    $('ov-tag').textContent = tfd.iterations ? tfd.iterations + ' strat' : 'streaming...';
  } else {
    updateBottom(t);
  }
}

// ── Select a ticker ──
export function selectItem(i) {
  state.activeIdx = i;
  state.userLockedTF = false;
  const t = state.tickers[i];
  const specs = t.tf?.[state.activeTF]?.prevSpecs || [];
  state.activeStratIdx = Math.max(0, specs.length - 1);

  document.querySelectorAll('.tk').forEach(e => e.classList.remove('active'));
  const el = document.querySelector(`.tk[data-idx="${i}"]`);
  if (el) el.classList.add('active');

  $('bar-sym').textContent = t.symbol;
  updateTfTabs(t);
  updateStrategyCarousel(t, state.activeTF);
  showTimeframe(t, state.activeTF);

  try { localStorage.setItem('aql_activeIdx', String(i)); } catch { /* ignore */ }
}

// ── Switch timeframe tab ──
export function switchTimeframe(tfKey) {
  state.activeTF = tfKey;
  state.userLockedTF = true;
  document.querySelectorAll('.tf-tab').forEach(b => b.classList.toggle('active', b.dataset.tf === tfKey));
  if (state.activeIdx >= 0) {
    const t = state.tickers[state.activeIdx];
    const specs = t.tf?.[tfKey]?.prevSpecs || [];
    state.activeStratIdx = Math.max(0, specs.length - 1);
    updateStrategyCarousel(t, tfKey);
    showTimeframe(t, tfKey);
  }
  try { localStorage.setItem('aql_activeTF', tfKey); } catch { /* ignore */ }
}

// ── Strategy navigation ──
export function prevStrategy() {
  if (state.activeIdx < 0) return;
  const t = state.tickers[state.activeIdx];
  const specs = t.tf?.[state.activeTF]?.prevSpecs || [];
  if (!specs.length) return;
  state.activeStratIdx = (state.activeStratIdx - 1 + specs.length) % specs.length;
  updateStrategyCarousel(t, state.activeTF);
  showTimeframe(t, state.activeTF);
}

export function nextStrategy() {
  if (state.activeIdx < 0) return;
  const t = state.tickers[state.activeIdx];
  const specs = t.tf?.[state.activeTF]?.prevSpecs || [];
  if (!specs.length) return;
  state.activeStratIdx = (state.activeStratIdx + 1) % specs.length;
  updateStrategyCarousel(t, state.activeTF);
  showTimeframe(t, state.activeTF);
}

// ── Model Switcher ──
export function switchModel(idx) {
  state.activeModelIdx = idx;
  localStorage.setItem('aql_model_idx', String(idx));
  const m = MODELS[idx];
  const mEl = $('model-name');
  const eEl = $('endpoint-name');
  const readyDot = m.ready ? '🟢' : '🔴';
  mEl.innerHTML = `${readyDot} <b>${m.name}</b>`;
  eEl.innerHTML = '<b>' + m.endpoint.replace('/v1/chat/completions', '') + '</b>';
  document.querySelectorAll('.model-opt').forEach((el, i) => el.classList.toggle('active', i === idx));
  console.log('[MODEL] Switched to', m.name, m.ready ? '(ready)' : '(not ready)');
}
