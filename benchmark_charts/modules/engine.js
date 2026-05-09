/**
 * engine.js — Core orchestration: processTicker, streamLLM, scoring.
 * Coordinates API, UI, and state. All bugs from the original are fixed here.
 *
 * BUG FIXES:
 * 1. fetchData had NO timeout → could hang forever (now 15s in api.js)
 * 2. `return;` in fetch catch exited processTicker entirely, skipping
 *    runningCount-- → permanently corrupted UI (now uses `continue`)
 * 3. singleStreamLLM referenced undefined `symbol` → now uses onChunk callback
 * 4. `lastErr = iterErr` was never declared → now properly scoped with `let`
 * 5. No `finally` block for cleanup → now guaranteed via try/finally
 */
import { TIMEFRAMES, TF_ORDER, STRATEGY_LENSES, MAX_TOOL_ROUNDS, MAX_RETRIES_PER_ITER } from './config.js';
import { state, initTickerTF, createTicker, saveState, saveTickerData, isCurrentView, getMODEL } from './state.js';
import { fetchData, singleStreamLLM } from './api.js';
import { AGENTIC_SYSTEM_PROMPT, buildPrompt } from './prompt.js';
import { executeToolCall, parseToolCallDirective, TOOL_REGISTRY } from './tools.js';
import { parseResponse, tryParsePartial } from './json-utils.js';
import { addMemoryEntry } from './memory.js';
import { renderChart } from './chart.js';
import {
  $, renderList, updateSpinner, updatePills, updateBottom,
  updateTfTabs, updateAgentLogPanel, updateStrategyCarousel,
  selectItem, showTimeframe,
} from './ui.js';

// ── Agentic LLM Loop (tool calling + streaming) ──

/**
 * Run the full agentic LLM loop for one analysis iteration.
 * Handles tool-call rounds, streaming, and JSON retry.
 *
 * @param {number} tickerIdx - Index into state.tickers.
 * @param {string} symbol - Ticker symbol.
 * @param {Array} data - OHLCV data.
 * @param {number} iter - Iteration number (1-based).
 * @param {Array} prev - Previous specs for deduplication.
 * @param {object} tfConfig - Timeframe config.
 * @param {string} macroContext - Higher-timeframe context.
 * @returns {Promise<{ spec: object, reasoning: string }>}
 */
async function agenticLLMLoop(tickerIdx, symbol, data, iter, prev, tfConfig, macroContext) {
  const t = state.tickers[tickerIdx];
  const tfd = t.tf[tfConfig.id];
  tfd.liveContent = '⏳ Starting agentic analysis...';
  const toolLog = [];
  tfd.toolLog = toolLog;

  if (isCurrentView(tickerIdx, tfConfig.id)) {
    $('analysis-text').textContent = tfd.liveContent;
    updateAgentLogPanel(toolLog);
  }

  const messages = [
    { role: 'system', content: AGENTIC_SYSTEM_PROMPT },
    { role: 'user', content: buildPrompt(symbol, data, iter, prev, tfConfig, macroContext) },
  ];

  let lastContent = '';
  let lastReasoning = '';

  // ── Tool-calling rounds ──
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const onChunk = ({ content, reasoning }) => {
      tfd.liveContent = content;
      if (!isCurrentView(tickerIdx, tfConfig.id)) return;
      $('analysis-text').textContent = content;
      $('analysis-text').scrollTop = $('analysis-text').scrollHeight;
      // Progressive chart rendering
      if (content.endsWith('}') || content.endsWith(']')) {
        const partial = tryParsePartial(content);
        if (partial && partial.overlays) {
          const overlaysStr = JSON.stringify(partial.overlays);
          if (tfd._lastOverlays !== overlaysStr) {
            tfd._lastOverlays = overlaysStr;
            renderChart(tfd.data, partial, symbol, tfConfig.label);
          }
        }
      }
    };

    const { content, reasoning } = await singleStreamLLM(messages, onChunk);
    lastContent = content;
    lastReasoning = reasoning;

    // Check for tool call
    const call = parseToolCallDirective(content);
    if (!call) break; // No tool call — this is the final answer

    // Execute the tool
    const logEntry = { round, tool: call.tool, params: call.params, status: 'calling', result: '', elapsed: 0 };
    toolLog.push(logEntry);
    if (isCurrentView(tickerIdx, tfConfig.id)) updateAgentLogPanel(toolLog);

    const startMs = Date.now();
    try {
      logEntry.result = await executeToolCall(call.tool, call.params, data, symbol);
      logEntry.status = 'done';
    } catch (e) {
      logEntry.result = 'Error: ' + e.message;
      logEntry.status = 'error';
    }
    logEntry.elapsed = Date.now() - startMs;
    if (isCurrentView(tickerIdx, tfConfig.id)) updateAgentLogPanel(toolLog);

    // Inject tool result back into conversation
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: `TOOL_RESULT for ${call.tool}:\n${logEntry.result}\n\nContinue your analysis. Call another tool or output your final JSON.` });

    tfd.liveContent = `🔄 Round ${round + 2}/${MAX_TOOL_ROUNDS} — ${toolLog.length} tool(s) called...`;
    if (isCurrentView(tickerIdx, tfConfig.id)) {
      $('analysis-text').textContent = tfd.liveContent;
    }
  }

  tfd.toolLog = toolLog;

  // Try to parse final response, with one JSON-forcing retry
  try {
    return parseResponse(lastContent, lastReasoning, symbol);
  } catch (parseErr) {
    console.warn(`[${symbol}] Parse failed: ${parseErr.message}. JSON-forcing retry...`);
    tfd.liveContent = '🔧 Fixing output format...';
    if (isCurrentView(tickerIdx, tfConfig.id)) $('analysis-text').textContent = tfd.liveContent;

    messages.push({ role: 'assistant', content: lastContent });
    messages.push({ role: 'user', content: 'Your previous output was not valid JSON. Output ONLY the raw JSON object now — no text, no markdown. Start with { and end with }.' });
    const retry = await singleStreamLLM(messages, null);
    return parseResponse(retry.content, retry.reasoning, symbol);
  }
}

// ── Save one iteration result to ticker state + memory ──
function saveIterationResult(t, tfd, tfKey, iter, spec, reasoning) {
  const lens = STRATEGY_LENSES[(iter - 1) % STRATEGY_LENSES.length];
  tfd.spec = spec;
  tfd.reasoning = reasoning;
  tfd.analysis = spec.analysis || '';
  tfd.strategy_name = spec.strategy_name || '';
  tfd.confidence = spec.confidence || 0;
  tfd.iterations = iter;
  tfd.liveContent = tfd.analysis;
  tfd.liveReasoning = reasoning;

  tfd.prevSpecs.push({
    iteration: iter,
    strategy_name: tfd.strategy_name,
    confidence: tfd.confidence,
    analysis: tfd.analysis,
    overlays: spec.overlays || [],
    lens: lens.id,
    prediction: spec.prediction || null,
    created_at: new Date().toISOString(),
    snapshot_close: tfd.data[tfd.data.length - 1]?.close || 0,
    snapshot_date: tfd.data[tfd.data.length - 1]?.date || '',
    tools_used: spec.tools_used || (tfd.toolLog || []).map(tl => tl.tool),
    forward_result: null,
  });

  addMemoryEntry(t.symbol, {
    timestamp: new Date().toISOString(),
    timeframe: tfKey,
    iteration: iter,
    strategy_name: tfd.strategy_name,
    confidence: tfd.confidence,
    lens: lens.id,
    overlays_count: (spec.overlays || []).length,
    tools_used: spec.tools_used || (tfd.toolLog || []).map(tl => tl.tool),
    prediction: spec.prediction || null,
    analysis_summary: tfd.analysis.slice(0, 200),
    model: getMODEL(),
  });
}

// ── Process one timeframe for a ticker ──
async function processTimeframe(tickerIdx, t, tfKey, iters, macroContext) {
  const tfConfig = TIMEFRAMES[tfKey];
  const tfd = t.tf[tfKey];
  tfd.status = 'running';
  tfd.prevSpecs = tfd.prevSpecs || [];

  // Fetch data only if missing
  if (!tfd.data) {
    $('status-msg').textContent = `${t.symbol} · fetching ${tfConfig.label}... (${state.runningCount} active)`;
    try {
      tfd.data = await fetchData(t.symbol, tfConfig.range, tfConfig.interval);
    } catch (fetchErr) {
      console.warn(`[${t.symbol}] Failed to fetch ${tfConfig.label}:`, fetchErr.message);
      tfd.status = 'error';
      tfd.analysis = '⚠ Data fetch failed: ' + fetchErr.message;
      return null; // Return null = no macro context contribution
    }
  }

  // Show chart immediately
  if (state.activeIdx === tickerIdx) {
    if (!state.userLockedTF && state.activeTF !== tfKey) {
      state.activeTF = tfKey;
      document.querySelectorAll('.tf-tab').forEach(b => b.classList.toggle('active', b.dataset.tf === tfKey));
    }
    if (state.activeTF === tfKey && tfd.data) {
      renderChart(tfd.data, { overlays: [] }, t.symbol, tfConfig.label);
    }
  }

  // Run LLM iterations
  for (let i = 0; i < iters; i++) {
    const it = tfd.prevSpecs.length + 1;
    let lastErr = null;  // BUG FIX: was undeclared (implicit global)
    let succeeded = false;

    for (let attempt = 0; attempt <= MAX_RETRIES_PER_ITER; attempt++) {
      try {
        const label = attempt > 0 ? ` (retry ${attempt})` : '';
        const lensName = STRATEGY_LENSES[(it - 1) % STRATEGY_LENSES.length].name;
        if (isCurrentView(tickerIdx, tfKey)) {
          $('status-msg').textContent = `${t.symbol} · ${tfConfig.label} · strategy ${it} (${lensName})${label} (${state.runningCount} active)`;
        }
        if (attempt > 0) {
          console.log(`[${t.symbol}/${tfKey}] Retrying iter ${it}...`);
          tfd.liveContent = `🔄 Retrying iter ${it}...`;
          if (isCurrentView(tickerIdx, tfKey)) $('analysis-text').textContent = tfd.liveContent;
        }

        const { spec, reasoning } = await agenticLLMLoop(tickerIdx, t.symbol, tfd.data, it, tfd.prevSpecs, tfConfig, macroContext);
        saveIterationResult(t, tfd, tfKey, it, spec, reasoning);

        if (isCurrentView(tickerIdx, tfKey)) {
          renderChart(tfd.data, spec, t.symbol, tfConfig.label);
          updateBottom(t);
        }
        renderList();
        succeeded = true;
        break;
      } catch (iterErr) {
        lastErr = iterErr;
        console.warn(`[${t.symbol}/${tfKey}] iter ${it} attempt ${attempt + 1} failed:`, iterErr.message);
      }
    }

    if (!succeeded) {
      console.error(`[${t.symbol}/${tfKey}] iter ${it} failed after retries.`);
      tfd.liveContent = `⚠ iter ${it} failed: ${lastErr?.message || 'unknown'}`;
      if (isCurrentView(tickerIdx, tfKey)) $('analysis-text').textContent = tfd.liveContent;
    }
  }

  tfd.status = tfd.spec ? 'success' : 'error';
  if (!tfd.spec) tfd.analysis = '⚠ All iterations failed for ' + tfConfig.label;

  if (tfd.data) saveTickerData(t.symbol, tfKey, tfd.data);
  saveState();
  updateTfTabs(t);
  renderList();

  // Return macro context for next smaller timeframe
  if (tfd.spec) {
    const dir = tfd.spec.prediction?.direction || 'UNKNOWN';
    const target = tfd.spec.prediction?.target_price || '?';
    return `[${tfConfig.label} Bias]: ${dir} (Target: $${target})\nRationale: ${tfd.spec.analysis}\n\n`;
  }
  return null;
}

// ── Process a full ticker (all timeframes, hierarchical) ──
export async function processTicker(idx, iters) {
  const t = state.tickers[idx];
  t.status = 'running';
  initTickerTF(t);
  state.runningCount++;
  updateSpinner();
  renderList();

  try {
    // Process timeframes hierarchically: Macro → Micro
    const hierarchicalOrder = [...TF_ORDER].reverse(); // ['long', 'medium', 'short']
    let macroContext = '';

    for (const tfKey of hierarchicalOrder) {
      const result = await processTimeframe(idx, t, tfKey, iters, macroContext);
      if (result) macroContext += result;
      // BUG FIX: original used `return;` here on fetch failure, which skipped cleanup.
      // Now processTimeframe returns null on failure and we just continue.
    }

    const anySuccess = TF_ORDER.some(tf => t.tf[tf].status === 'success');
    t.status = anySuccess ? 'success' : 'error';
    if (!anySuccess) t.error = 'All timeframes failed';
  } catch (e) {
    t.status = 'error';
    t.error = e.message;
    console.error(`[${t.symbol}]`, e);
  } finally {
    // BUG FIX: guaranteed cleanup — original had no finally block,
    // so any unhandled throw would permanently corrupt runningCount.
    state.runningCount--;
    updateSpinner();
    renderList();
    updatePills();
    saveState();
  }
}

// ── Run analysis (entry point from button click) ──
export async function runAnalysis() {
  const raw = $('ticker-input').value;
  if (!raw.trim()) return;
  const syms = raw.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const iters = parseInt($('iter-select').value);
  $('ticker-input').value = '';

  // Add new symbols
  syms.forEach(s => {
    if (!state.tickers.find(t => t.symbol === s)) {
      state.tickers.push(createTicker(s));
    }
  });
  renderList();
  saveState();

  // Fire ALL in parallel (non-blocking)
  const promises = syms.map(s => {
    const i = state.tickers.findIndex(t => t.symbol === s);
    if (i !== -1) return processTicker(i, iters);
  });
  const firstIdx = state.tickers.findIndex(t => t.symbol === syms[0]);
  if (firstIdx !== -1) selectItem(firstIdx);

  await Promise.allSettled(promises);
  $('status-msg').textContent = `Batch done — ${syms.length} tickers × 3 timeframes.`;
}

// ── Generate More (add one more strategy per timeframe) ──
export async function generateMore() {
  if (state.activeIdx < 0) return;
  const t = state.tickers[state.activeIdx];
  const tfKey = state.activeTF; // ONLY generate for the currently viewed timeframe
  const tfConfig = TIMEFRAMES[tfKey];
  const tfd = t.tf[tfKey];

  if (tfd.status === 'running') {
    $('status-msg').textContent = '⚠ Already generating for ' + tfConfig.label;
    return;
  }

  t.status = 'running';
  tfd.status = 'running';
  state.runningCount++;
  updateSpinner();
  renderList();

  try {
    // Fetch data if missing
    if (!tfd.data) {
      $('status-msg').textContent = `${t.symbol} · ${tfConfig.label} · fetching data...`;
      try {
        tfd.data = await fetchData(t.symbol, tfConfig.range, tfConfig.interval);
        saveTickerData(t.symbol, tfKey, tfd.data);
      } catch (fetchErr) {
        console.error(`[generateMore] Fetch failed for ${t.symbol}/${tfKey}:`, fetchErr);
        tfd.status = 'error';
        tfd.analysis = '⚠ Data fetch failed — ' + fetchErr.message;
        return;
      }
    }

    const it = (tfd.prevSpecs?.length || 0) + 1;
    const lens = STRATEGY_LENSES[(it - 1) % STRATEGY_LENSES.length];

    $('status-msg').textContent = `${t.symbol} · ${tfConfig.label} · generating ${lens.name} strategy...`;
    $('analysis-text').textContent = `🔄 Generating strategy #${it} (${lens.name} lens)...`;

    try {
      const macroContext = ''; // We skip macro context injection for single on-demand generation to keep it fast
      const { spec, reasoning } = await agenticLLMLoop(state.activeIdx, t.symbol, tfd.data, it, tfd.prevSpecs || [], tfConfig, macroContext);
      saveIterationResult(t, tfd, tfKey, it, spec, reasoning);
      tfd.status = 'success';

      state.activeStratIdx = tfd.prevSpecs.length - 1;
      renderChart(tfd.data, spec, t.symbol, tfConfig.label);
      updateBottom(t);
      updateStrategyCarousel(t, tfKey);
      $('status-msg').textContent = `${t.symbol} · ${tfConfig.label} · strategy #${it} complete (${lens.name})`;
    } catch (e) {
      tfd.status = 'error';
      tfd.analysis = '⚠ ' + e.message;
      updateBottom(t);
      $('status-msg').textContent = `⚠ ${t.symbol} ${tfConfig.label} generation failed: ${e.message}`;
    }

    const anySuccess = TF_ORDER.some(tf => t.tf[tf].status === 'success');
    t.status = anySuccess ? 'success' : 'error';
  } finally {
    state.runningCount--;
    updateSpinner();
    renderList();
    updatePills();
    updateTfTabs(t);
    saveState();
  }
}

// ── Forward-Testing Scoring ──

function scoreOneStrategy(spec, currentData) {
  const pred = spec.prediction;
  if (!pred || !pred.direction || !pred.target_price) return { score: 0, detail: 'No valid prediction' };
  if (!spec.snapshot_date || !spec.snapshot_close) return { score: 0, detail: 'Missing snapshot data' };

  const afterData = currentData.filter(d => d.date > spec.snapshot_date);
  if (!afterData.length) return { score: 0, detail: 'No post-snapshot data yet' };

  const horizonData = afterData.slice(0, pred.horizon_days || 14);
  if (!horizonData.length) return { score: 0, detail: 'No data within horizon' };

  const latestClose = horizonData[horizonData.length - 1].close;
  const actualMove = latestClose - spec.snapshot_close;
  const actualMovePct = (actualMove / spec.snapshot_close) * 100;
  const highs = horizonData.map(d => d.high);
  const lows = horizonData.map(d => d.low);

  // Direction (40%)
  let dirScore = 0;
  if (pred.direction === 'LONG' && actualMove > 0) dirScore = 1;
  else if (pred.direction === 'SHORT' && actualMove < 0) dirScore = 1;
  else if (pred.direction === 'NEUTRAL' && Math.abs(actualMovePct) < 2) dirScore = 1;

  // Target (25%)
  let targetScore = 0;
  if (pred.direction === 'LONG' && Math.max(...highs) >= pred.target_price) targetScore = 1;
  else if (pred.direction === 'SHORT' && Math.min(...lows) <= pred.target_price) targetScore = 1;

  // Stop (15%)
  let stopScore = 1;
  if (pred.stop_loss) {
    if (pred.direction === 'LONG' && Math.min(...lows) <= pred.stop_loss) stopScore = 0;
    else if (pred.direction === 'SHORT' && Math.max(...highs) >= pred.stop_loss) stopScore = 0;
  }

  // Magnitude (10%)
  const predictedMove = Math.abs(pred.target_price - spec.snapshot_close);
  const actualMoveAbs = Math.abs(actualMove);
  const magScore = predictedMove > 0 ? Math.max(0, 1 - Math.abs(actualMoveAbs - predictedMove) / predictedMove) : 0;

  // Overlay relevance (10%)
  let ovScore = 0;
  const overlayLevels = (spec.overlays || []).filter(o => o.kind === 'line').map(o => o.y1 || o.y0);
  if (overlayLevels.length) {
    const allPrices = horizonData.flatMap(d => [d.high, d.low]);
    const tolerance = spec.snapshot_close * 0.01;
    if (overlayLevels.some(level => allPrices.some(price => Math.abs(price - level) < tolerance))) ovScore = 1;
  }

  const composite = dirScore * 0.4 + targetScore * 0.25 + stopScore * 0.15 + magScore * 0.1 + ovScore * 0.1;
  return {
    score: +composite.toFixed(3), direction_correct: dirScore === 1,
    target_hit: targetScore === 1, stop_avoided: stopScore === 1,
    magnitude_accuracy: +magScore.toFixed(3), overlay_tested: ovScore === 1,
    actual_move_pct: +actualMovePct.toFixed(2), days_evaluated: horizonData.length,
    scored_at: new Date().toISOString(),
  };
}

export async function scoreStrategies() {
  const MIN_AGE_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const toScore = [];

  for (const t of state.tickers) {
    for (const tfKey of TF_ORDER) {
      const tfd = t.tf?.[tfKey];
      if (!tfd?.prevSpecs?.length) continue;
      for (const spec of tfd.prevSpecs) {
        if (!spec.prediction || spec.forward_result) continue;
        const age = spec.created_at ? now - new Date(spec.created_at).getTime() : Infinity;
        if (age < MIN_AGE_MS) continue;
        toScore.push({ symbol: t.symbol, tfKey, spec, tfd });
      }
    }
  }

  if (!toScore.length) {
    const totalStrats = state.tickers.reduce((n, t) =>
      n + TF_ORDER.reduce((m, tf) => m + (t.tf?.[tf]?.prevSpecs?.length || 0), 0), 0);
    $('status-msg').textContent = `No strategies old enough to score (min 24h). ${totalStrats} total in bank.`;
    return;
  }

  $('status-msg').textContent = `Scoring ${toScore.length} strategies...`;
  $('spinner').style.display = 'inline-block';

  // Group by symbol to minimize fetches
  const bySymbol = {};
  for (const item of toScore) {
    if (!bySymbol[item.symbol]) bySymbol[item.symbol] = [];
    bySymbol[item.symbol].push(item);
  }

  let scored = 0;
  let failed = 0;
  for (const [symbol, items] of Object.entries(bySymbol)) {
    try {
      const currentData = await fetchData(symbol, '3mo', '1d');
      for (const item of items) {
        item.spec.forward_result = scoreOneStrategy(item.spec, currentData);
        // Update agent memory
        const { loadMemory, saveMemory } = await import('./memory.js');
        const mem = loadMemory();
        const entries = mem[symbol]?.entries || [];
        const match = entries.find(e => e.strategy_name === item.spec.strategy_name && e.timeframe === item.tfKey);
        if (match) { match.forward_score = item.spec.forward_result.score; saveMemory(mem); }
        scored++;
      }
    } catch (e) {
      console.warn(`[SCORE] Failed for ${symbol}:`, e.message);
      failed += items.length;
    }
  }

  saveState();
  $('spinner').style.display = 'none';
  const avgScore = toScore.filter(i => i.spec.forward_result)
    .reduce((s, i) => s + i.spec.forward_result.score, 0) / Math.max(1, scored) * 100;
  $('status-msg').textContent = `Scored ${scored} strategies` +
    (failed ? ` (${failed} failed)` : '') + '. Avg: ' + avgScore.toFixed(0) + '%';

  if (state.activeIdx >= 0) {
    updateStrategyCarousel(state.tickers[state.activeIdx], state.activeTF);
    updateBottom(state.tickers[state.activeIdx]);
  }
  renderList();
}
