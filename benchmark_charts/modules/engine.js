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
import { executeToolCall, parseToolCallDirective, parseToolChainDirective, TOOL_REGISTRY, saveCustomChain } from './tools.js';
import { lookupStrategy } from './strategy_kb.js';
import { parseResponse, tryParsePartial } from './json-utils.js';
import { addMemoryEntry } from './memory.js';
import { renderChart, renderEmptyChart } from './chart.js';
import {
  $, renderList, updateSpinner, updateProgressBar, updatePills, updateBottom,
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
/**
 * Pre-execute a lens's tool chain and return formatted results.
 * Handles special STRATEGY_LOOKUP:param syntax for parameterized tools.
 */
async function preExecuteToolChain(toolChain, data, symbol, toolLog, tickerIdx, tfConfig, specRef) {
  if (!toolChain || !toolChain.length) return '';
  const tfd = state.tickers[tickerIdx].tf[tfConfig.id];

  specRef.analysis = `⚙️ Pre-executing ${toolChain.length} tools for lens...`;
  if (isCurrentView(tickerIdx, tfConfig.id) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
    $('analysis-text').textContent = specRef.analysis;
  }

  const results = [];
  const promises = toolChain.map(async (toolSpec) => {
    // Handle parameterized tools like STRATEGY_LOOKUP:order_block
    let toolName, toolParams = '';
    if (toolSpec.includes(':')) {
      const [name, ...paramParts] = toolSpec.split(':');
      toolName = name;
      toolParams = paramParts.join(':');
    } else {
      toolName = toolSpec;
    }

    const logEntry = { round: -1, tool: toolName, params: toolParams || '(auto)', status: 'calling', result: '', elapsed: 0, isPreComputed: true };
    toolLog.push(logEntry);

    const startMs = Date.now();
    try {
      // Special handling for STRATEGY_LOOKUP — use direct function for parameterized calls
      if (toolName === 'STRATEGY_LOOKUP' && toolParams) {
        logEntry.result = lookupStrategy(toolParams);
      } else {
        logEntry.result = await executeToolCall(toolName, toolParams, data, symbol);
      }
      logEntry.status = 'done';
    } catch (e) {
      logEntry.result = 'Error: ' + e.message;
      logEntry.status = 'error';
    }
    logEntry.elapsed = Date.now() - startMs;
    console.log(`[PRE-EXEC] ${symbol}/${tfConfig.id}: ${toolName}(${toolParams}) → ${logEntry.status} (${logEntry.elapsed}ms)`);
    return { toolName, params: toolParams, result: logEntry.result };
  });

  const settled = await Promise.allSettled(promises);
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(s.value);
  }

  if (isCurrentView(tickerIdx, tfConfig.id) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
    updateAgentLogPanel(toolLog);
  }

  // Format results for prompt injection
  return results.map(r => `[${r.toolName}${r.params ? '(' + r.params + ')' : ''}]:\n${r.result}`).join('\n\n') + '\n';
}

async function agenticLLMLoop(tickerIdx, symbol, data, iter, prev, tfConfig, macroContext, specRef) {
  const t = state.tickers[tickerIdx];
  const tfd = t.tf[tfConfig.id];
  
  const toolLog = [];
  specRef.toolLog = toolLog;
  specRef.analysis = '⏳ Starting agentic analysis...';

  // Only push the initial empty state to the panel if this spec is actively being viewed
  if (isCurrentView(tickerIdx, tfConfig.id)) {
    const activeSpec = tfd.prevSpecs[state.activeStratIdx];
    if (activeSpec === specRef) {
      $('analysis-text').textContent = specRef.analysis;
      updateAgentLogPanel(toolLog);
    }
  }

  // Auto-execute lens tool chain BEFORE LLM streaming
  const lens = STRATEGY_LENSES[(iter - 1) % STRATEGY_LENSES.length];
  const preComputedResults = await preExecuteToolChain(
    lens.toolChain, data, symbol, toolLog, tickerIdx, tfConfig, specRef
  );

  const messages = [
    { role: 'system', content: AGENTIC_SYSTEM_PROMPT },
    { role: 'user', content: buildPrompt(symbol, data, iter, prev, tfConfig, macroContext, preComputedResults) },
  ];

  let lastContent = '';
  let lastReasoning = '';

  // ── Tool-calling rounds ──
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const onChunk = ({ content, reasoning }) => {
      specRef.analysis = content;
      if (!isCurrentView(tickerIdx, tfConfig.id)) return;
      const activeSpec = tfd.prevSpecs[state.activeStratIdx];
      if (activeSpec !== specRef) return;

      $('analysis-text').textContent = content;
      $('analysis-text').scrollTop = $('analysis-text').scrollHeight;
      // Progressive chart rendering
      if (content.endsWith('}') || content.endsWith(']')) {
        const partial = tryParsePartial(content);
        if (partial && partial.overlays) {
          const overlaysStr = JSON.stringify(partial.overlays);
          if (specRef._lastOverlays !== overlaysStr) {
            specRef._lastOverlays = overlaysStr;
            renderChart(tfd.data, partial, symbol, tfConfig.label);
          }
        }
      }

      // 🛑 Abort stream immediately if a tool call or chain directive is fully typed out
      if (parseToolCallDirective(content) || (reasoning && parseToolCallDirective(reasoning))) return true;
      if (parseToolChainDirective(content) || (reasoning && parseToolChainDirective(reasoning))) return true;
    };

    const { content, reasoning } = await singleStreamLLM(messages, onChunk);
    lastContent = content;
    lastReasoning = reasoning;

    // Check for CREATE_TOOL_CHAIN directive first (custom multi-tool combo)
    let chainCall = parseToolChainDirective(content);
    if (!chainCall && reasoning) chainCall = parseToolChainDirective(reasoning);
    if (chainCall) {
      console.log(`[CHAIN] ${symbol}/${tfConfig.id} iter${iter}: LLM created chain "${chainCall.name}" with [${chainCall.tools.join(', ')}]`);
      specRef.analysis = `⚡ Executing custom chain: ${chainCall.name} (${chainCall.tools.length} tools)...`;
      if (isCurrentView(tickerIdx, tfConfig.id) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
        $('analysis-text').textContent = specRef.analysis;
      }

      // Execute all tools in the chain in parallel
      const chainResults = [];
      const chainPromises = chainCall.tools.map(async (toolName) => {
        const logEntry = { round, tool: toolName, params: '(chain)', status: 'calling', result: '', elapsed: 0, chainName: chainCall.name };
        toolLog.push(logEntry);
        const startMs = Date.now();
        try {
          logEntry.result = await executeToolCall(toolName, '', data, symbol);
          logEntry.status = 'done';
        } catch (e) {
          logEntry.result = 'Error: ' + e.message;
          logEntry.status = 'error';
        }
        logEntry.elapsed = Date.now() - startMs;
        return { tool: toolName, result: logEntry.result };
      });

      const settled = await Promise.allSettled(chainPromises);
      for (const s of settled) {
        if (s.status === 'fulfilled') chainResults.push(s.value);
      }

      // Save custom chain to persistent storage
      saveCustomChain({ name: chainCall.name, tools: chainCall.tools });
      specRef.toolChainName = chainCall.name;
      specRef.toolChainHash = chainCall.tools.slice().sort().join('+');

      console.log(`[CHAIN] ${symbol}/${tfConfig.id}: chain "${chainCall.name}" complete. ${chainResults.length}/${chainCall.tools.length} succeeded.`);
      if (isCurrentView(tickerIdx, tfConfig.id) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
        updateAgentLogPanel(toolLog);
      }

      // Inject combined chain results
      const combinedResult = chainResults.map(r => `[${r.tool}]:\n${r.result}`).join('\n\n');
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: `TOOL_CHAIN_RESULT for "${chainCall.name}" (${chainCall.tools.join(', ')}):\n${combinedResult}\n\nContinue your analysis. Call another tool, create another chain, or output your final JSON.` });

      specRef.analysis = `🔄 Round ${round + 2}/${MAX_TOOL_ROUNDS} — chain "${chainCall.name}" complete...`;
      if (isCurrentView(tickerIdx, tfConfig.id) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
        $('analysis-text').textContent = specRef.analysis;
      }
      continue;
    }

    // Check for single tool call
    let call = parseToolCallDirective(content);
    if (!call && reasoning) call = parseToolCallDirective(reasoning);
    if (!call) break; // No tool call — this is the final answer

    // Execute the tool
    const logEntry = { round, tool: call.tool, params: call.params, status: 'calling', result: '', elapsed: 0 };
    toolLog.push(logEntry);
    if (isCurrentView(tickerIdx, tfConfig.id) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
      updateAgentLogPanel(toolLog);
    }

    const startMs = Date.now();
    try {
      logEntry.result = await executeToolCall(call.tool, call.params, data, symbol);
      logEntry.status = 'done';
    } catch (e) {
      logEntry.result = 'Error: ' + e.message;
      logEntry.status = 'error';
    }
    logEntry.elapsed = Date.now() - startMs;
    console.log(`[TOOL] ${symbol}/${tfConfig.id} iter${iter}: ${call.tool} → ${logEntry.status} (${logEntry.elapsed}ms). toolLog.length=${toolLog.length}`);
    if (isCurrentView(tickerIdx, tfConfig.id) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
      updateAgentLogPanel(toolLog);
    }

    // Inject tool result back into conversation
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: `TOOL_RESULT for ${call.tool}:\n${logEntry.result}\n\nContinue your analysis. Call another tool, create a custom chain, or output your final JSON.` });

    specRef.analysis = `🔄 Round ${round + 2}/${MAX_TOOL_ROUNDS} — ${toolLog.length} tool(s) called...`;
    if (isCurrentView(tickerIdx, tfConfig.id) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
      $('analysis-text').textContent = specRef.analysis;
    }
  }

  // Try to parse final response, with one JSON-forcing retry
  try {
    return parseResponse(lastContent, lastReasoning, symbol);
  } catch (parseErr) {
    console.warn(`[${symbol}] Parse failed: ${parseErr.message}. JSON-forcing retry...`);
    specRef.analysis = '🔧 Fixing output format...';
    if (isCurrentView(tickerIdx, tfConfig.id) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
      $('analysis-text').textContent = specRef.analysis;
    }

    messages.push({ role: 'assistant', content: lastContent });
    messages.push({ role: 'user', content: 'Your previous output was not valid JSON. Output ONLY the raw JSON object now — no text, no markdown. Start with { and end with }.' });
    const retry = await singleStreamLLM(messages, null);
    return parseResponse(retry.content, retry.reasoning, symbol);
  }
}

// ── Save one iteration result to ticker state + memory ──
function saveIterationResult(t, tfd, tfKey, iter, spec, reasoning, specRef) {
  const lens = STRATEGY_LENSES[(iter - 1) % STRATEGY_LENSES.length];
  tfd.spec = spec;
  tfd.reasoning = reasoning;
  tfd.analysis = spec.analysis || '';
  tfd.strategy_name = spec.strategy_name || '';
  tfd.confidence = spec.confidence || 0;
  tfd.iterations = iter;

  // Build tool chain metadata
  const toolsUsed = spec.tools_used || (specRef.toolLog || []).map(tl => tl.tool);
  const chainName = specRef.toolChainName || spec.tool_chain_name || lens.name + ' (auto)';
  const chainHash = specRef.toolChainHash || toolsUsed.slice().sort().join('+');

  specRef.status = 'success';
  specRef.strategy_name = tfd.strategy_name;
  specRef.confidence = tfd.confidence;
  specRef.analysis = tfd.analysis;
  specRef.overlays = spec.overlays || [];
  specRef.prediction = spec.prediction || null;
  specRef.created_at = new Date().toISOString();
  specRef.snapshot_close = tfd.data[tfd.data.length - 1]?.close || 0;
  specRef.snapshot_date = tfd.data[tfd.data.length - 1]?.date || '';
  specRef.tools_used = toolsUsed;
  specRef.tool_chain_name = chainName;
  specRef.tool_chain_hash = chainHash;
  specRef.forward_result = null;

  addMemoryEntry(t.symbol, {
    timestamp: new Date().toISOString(),
    timeframe: tfKey,
    iteration: iter,
    strategy_name: tfd.strategy_name,
    confidence: tfd.confidence,
    lens: lens.id,
    overlays_count: (spec.overlays || []).length,
    tools_used: toolsUsed,
    tool_chain_name: chainName,
    tool_chain_hash: chainHash,
    prediction: spec.prediction || null,
    analysis_summary: tfd.analysis.slice(0, 200),
    model: getMODEL(),
  });
}

// ── Modular Timeframe Execution Blocks ──

async function ensureTimeframeData(t, tfKey, tfConfig) {
  const tfd = t.tf[tfKey];
  if (tfd.data) return true;
  
  $('status-msg').textContent = `${t.symbol} · fetching ${tfConfig.label}... (${state.runningCount} active)`;
  try {
    tfd.data = await fetchData(t.symbol, tfConfig.range, tfConfig.interval);
    return true;
  } catch (fetchErr) {
    console.warn(`[${t.symbol}] Failed to fetch ${tfConfig.label}:`, fetchErr.message);
    tfd.status = 'error';
    tfd.analysis = '⚠ Data fetch failed: ' + fetchErr.message;
    return false;
  }
}

function activateTimeframeTab(tickerIdx, t, tfKey, tfConfig) {
  if (state.activeIdx !== tickerIdx) return;
  const tfd = t.tf[tfKey];
  
  // BUG FIX: Prevent parallel timeframes from fighting for activeTF.
  // If the user hasn't locked the tab, default to 'short' to prevent the last parallel promise ('long') from hijacking the view.
  if (!state.userLockedTF && state.activeTF !== 'short') {
    state.activeTF = 'short';
    document.querySelectorAll('.tf-tab').forEach(b => b.classList.toggle('active', b.dataset.tf === 'short'));
  }

  if (state.activeTF === tfKey && tfd.data) {
    renderChart(tfd.data, { overlays: [] }, t.symbol, tfConfig.label);
  }
}

async function executeSingleIteration(tickerIdx, t, tfKey, it, macroContext) {
  const tfConfig = TIMEFRAMES[tfKey];
  const tfd = t.tf[tfKey];
  let lastErr = null;
  let succeeded = false;

  // Stub the strategy so the user can select it in the UI while it's running
  tfd.prevSpecs = tfd.prevSpecs || [];
  let specRef = tfd.prevSpecs.find(s => s.iteration === it);
  if (!specRef) {
    specRef = {
      iteration: it,
      status: 'running',
      analysis: '⏳ Starting agentic analysis...',
      overlays: [],
      toolLog: [],
      lens: STRATEGY_LENSES[(it - 1) % STRATEGY_LENSES.length].id,
      strategy_name: 'Analyzing...'
    };
    tfd.prevSpecs.push(specRef);
  } else {
    specRef.status = 'running';
    specRef.analysis = '🔄 Retrying...';
    specRef.toolLog = [];
  }

  // Auto-focus carousel to a running spec so its tool log is visible
  if (isCurrentView(tickerIdx, tfKey)) {
    const idx = tfd.prevSpecs.indexOf(specRef);
    const currentSpec = tfd.prevSpecs[state.activeStratIdx];
    // Auto-switch if current view is not actively running (idle/done/error)
    if (!currentSpec || currentSpec.status !== 'running') {
      state.activeStratIdx = idx;
      updateStrategyCarousel(t, tfKey);
      showTimeframe(t, tfKey);
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_ITER; attempt++) {
    try {
      const label = attempt > 0 ? ` (retry ${attempt})` : '';
      const lensName = STRATEGY_LENSES[(it - 1) % STRATEGY_LENSES.length].name;
      
      if (isCurrentView(tickerIdx, tfKey)) {
        $('status-msg').textContent = `${t.symbol} · ${tfConfig.label} · strategy ${it} (${lensName})${label} (${state.runningCount} active)`;
      }
      if (attempt > 0) {
        console.log(`[${t.symbol}/${tfKey}] Retrying iter ${it}...`);
        specRef.analysis = `🔄 Retrying iter ${it}...`;
        if (isCurrentView(tickerIdx, tfKey) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
           $('analysis-text').textContent = specRef.analysis;
        }
      }

      const { spec, reasoning } = await agenticLLMLoop(tickerIdx, t.symbol, tfd.data, it, tfd.prevSpecs, tfConfig, macroContext, specRef);
      saveIterationResult(t, tfd, tfKey, it, spec, reasoning, specRef);

      if (isCurrentView(tickerIdx, tfKey) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
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
    specRef.status = 'error';
    specRef.analysis = `⚠ iter ${it} failed: ${lastErr?.message || 'unknown'}`;
    if (isCurrentView(tickerIdx, tfKey) && tfd.prevSpecs[state.activeStratIdx] === specRef) {
      $('analysis-text').textContent = specRef.analysis;
    }
  }

  // Update progress bar
  state.progressDone++;
  updateProgressBar();
}

async function processTimeframe(tickerIdx, t, tfKey, iters, macroContext) {
  const tfConfig = TIMEFRAMES[tfKey];
  const tfd = t.tf[tfKey];
  
  if (iters <= 0) {
    tfd.status = 'skipped';
    tfd.analysis = 'Skipped by user config (0 iterations).';
    if (isCurrentView(tickerIdx, tfKey)) {
      $('analysis-text').textContent = tfd.analysis;
      renderEmptyChart(t.symbol, tfConfig.label);
      updateAgentLogPanel([]);
      $('ov-tag').textContent = '—';
    }
    return null;
  }

  tfd.status = 'running';
  tfd.prevSpecs = tfd.prevSpecs || [];

  const hasData = await ensureTimeframeData(t, tfKey, tfConfig);
  if (!hasData) return null;

  activateTimeframeTab(tickerIdx, t, tfKey, tfConfig);

  state.runningCount += iters;
  state.progressTotal += iters;
  updateSpinner();
  updateProgressBar();
  
  try {
    const iterPromises = [];
    const baseLen = tfd.prevSpecs?.length || 0;
    for (let i = 0; i < iters; i++) {
      const it = baseLen + i + 1;
      iterPromises.push(executeSingleIteration(tickerIdx, t, tfKey, it, macroContext));
    }
    await Promise.allSettled(iterPromises);

    tfd.status = tfd.spec ? 'success' : 'error';
    if (!tfd.spec) tfd.analysis = '⚠ All iterations failed for ' + tfConfig.label;

    if (tfd.data) saveTickerData(t.symbol, tfKey, tfd.data);
    saveState();
    updateTfTabs(t);
    renderList();

    // BUG FIX: Immediately render data on the frontend for this timeframe if we're looking at it.
    if (isCurrentView(tickerIdx, tfKey)) {
        state.activeStratIdx = Math.max(0, (tfd.prevSpecs?.length || 1) - 1);
        updateStrategyCarousel(t, tfKey);
        showTimeframe(t, tfKey);
    }

    if (tfd.spec) {
      const dir = tfd.spec.prediction?.direction || 'UNKNOWN';
      const tgt = tfd.spec.prediction?.target_price || '?';
      return `[${tfConfig.label} Bias]: ${dir} (Target: $${tgt})\nRationale: ${tfd.spec.analysis}\n\n`;
    }
    return null;
  } finally {
    state.runningCount -= iters;
    updateSpinner();
    updateProgressBar();
  }
}

// ── Process a full ticker (all timeframes, hierarchical) ──
export async function processTicker(idx, itersConfig) {
  const t = state.tickers[idx];
  t.status = 'running';
  initTickerTF(t);
  renderList();

  try {
    // Process timeframes in parallel for maximum speed
    const tfPromises = TF_ORDER.map(tfKey => {
      const itersForTF = itersConfig[tfKey] || 0;
      return processTimeframe(idx, t, tfKey, itersForTF, '');
    });

    await Promise.allSettled(tfPromises);

    const anySuccess = TF_ORDER.some(tf => t.tf[tf].status === 'success');
    t.status = anySuccess ? 'success' : 'error';
    if (!anySuccess) t.error = 'All timeframes failed';
  } catch (e) {
    t.status = 'error';
    t.error = e.message;
    console.error(`[${t.symbol}]`, e);
  } finally {
    // BUG FIX: guaranteed cleanup
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
  const itersConfig = {
    short: parseInt($('iter-short').value) || 0,
    medium: parseInt($('iter-medium').value) || 0,
    long: parseInt($('iter-long').value) || 0
  };
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
    if (i !== -1) return processTicker(i, itersConfig);
  });
  const firstIdx = state.tickers.findIndex(t => t.symbol === syms[0]);
  if (firstIdx !== -1) selectItem(firstIdx);

  await Promise.allSettled(promises);
  $('status-msg').textContent = `Batch done — ${syms.length} tickers × 3 timeframes.`;
}

// ── Generate Specific (add configured iterations per timeframe) ──
export async function generateSpecific(tfKey) {
  if (state.activeIdx < 0) return;
  const t = state.tickers[state.activeIdx];
  const tfConfig = TIMEFRAMES[tfKey];
  const tfd = t.tf[tfKey];

  if (tfd.status === 'running') {
    if (isCurrentView(state.activeIdx, tfKey)) {
      $('status-msg').textContent = '⚠ Already generating for ' + tfConfig.label;
    }
    return;
  }

  const uiValue = parseInt($('iter-' + tfKey)?.value) || 0;
  const itersToRun = uiValue > 0 ? uiValue : 1; // Default to at least 1 if manually clicked

  t.status = 'running';
  tfd.status = 'running';
  state.runningCount += itersToRun; // Increment by exact parallel requests for UI transparency
  state.progressTotal += itersToRun;
  updateSpinner();
  updateProgressBar();
  renderList();

  try {
    const hasData = await ensureTimeframeData(t, tfKey, tfConfig);
    if (!hasData) return;
    
    saveTickerData(t.symbol, tfKey, tfd.data);

    const iterPromises = [];
    const baseLen = tfd.prevSpecs?.length || 0;
    for (let i = 0; i < itersToRun; i++) {
      const it = baseLen + i + 1;
      iterPromises.push(executeSingleIteration(state.activeIdx, t, tfKey, it, ''));
    }
    await Promise.allSettled(iterPromises);

    const anySuccess = TF_ORDER.some(tf => t.tf[tf].status === 'success');
    t.status = anySuccess ? 'success' : 'error';
    tfd.status = tfd.spec ? 'success' : 'error';
    
    if (isCurrentView(state.activeIdx, tfKey)) {
       state.activeStratIdx = Math.max(0, (tfd.prevSpecs?.length || 1) - 1);
       updateStrategyCarousel(t, tfKey);
    }
  } finally {
    state.runningCount -= itersToRun;
    updateSpinner();
    updateProgressBar();
    renderList();
    updatePills();
    updateTfTabs(t);
    saveState();
  }
}

// ── Generate All ──
export async function generateAll() {
  if (state.activeIdx < 0) return;
  const promises = TF_ORDER.map(tfKey => generateSpecific(tfKey));
  await Promise.allSettled(promises);
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
