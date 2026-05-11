/**
 * prompt.js — LLM prompt construction.
 * Pure functions that build message strings. No I/O, no DOM.
 */
import { STRATEGY_LENSES, MAX_TOOL_ROUNDS, PLANNER_MAX_TOOLS, SYNTH_TRACE_MAX_CHARS } from './config.js';
import { TOOL_REGISTRY } from './tools.js';
import { getMemoryContext } from './memory.js';

/** Build tool definition string for system prompt. */
function buildToolDefs() {
  return Object.entries(TOOL_REGISTRY)
    .map(([name, t]) => `- ${name}: ${t.desc}`)
    .join('\n');
}

/** The system prompt — built once at module load. */
export const AGENTIC_SYSTEM_PROMPT = `You are an elite quantitative analyst with access to research tools and a curated strategy knowledge base.

PRE-COMPUTED DATA: Tool chain results for your assigned lens have been pre-computed and injected below. Use them immediately — do NOT re-call these tools.

AVAILABLE TOOLS:
${buildToolDefs()}

To call a tool, output a line EXACTLY like:
TOOL_CALL: TOOL_NAME(params)

Example: TOOL_CALL: STRATEGY_LOOKUP(order block)
Example: TOOL_CALL: CALC_RSI()
Example: TOOL_CALL: SUGGEST_STRATEGY(high volatility consolidation)

CUSTOM TOOL CHAINS: You can define and execute multiple tools at once by creating a custom chain:
CREATE_TOOL_CHAIN: ChainName(TOOL1|TOOL2|TOOL3)

Example: CREATE_TOOL_CHAIN: VWAP Squeeze Play(CALC_VWAP|CALC_SQUEEZE_MOMENTUM|CALC_BOLLINGER)
All tools in the chain execute in parallel and results are returned together. This saves rounds.
Custom chains are saved and scored — high-performing chains will be recommended in future analyses.

You will receive tool results and can call more tools (max ${MAX_TOOL_ROUNDS} rounds) or produce your final output.

STRATEGY KNOWLEDGE BASE: Use STRATEGY_LOOKUP to find proven trading strategies with entry/exit rules and recommended tool combinations. Use SUGGEST_STRATEGY to get recipe suggestions based on market conditions. Use GET_BEST_CHAINS to see which tool combos have historically performed best for this ticker.

CRITICAL: Your output MUST include a full "prediction" block with:
- Directional call, target price, stop loss, and time horizon
- buy_zone: { entry_low, entry_high, rationale } — grounded in pivot/volume confluence from CALC_PRICE_LEVELS
- sell_zone: { exit_low, exit_high, rationale } — grounded in resistance/volume confluence
- probability: { target_hit_pct, stop_hit_pct, risk_reward, expected_move_1sigma: [low, high], expected_move_2sigma: [low, high], confidence_basis } — grounded in CALC_EXPECTED_MOVE / CALC_PROBABILITY_CONE / CALC_MONTE_CARLO data

NEW OVERLAY TYPES:
- {"kind":"probability_band","y_upper":float,"y_lower":float,"sigma_level":1|2,"probability_pct":68|95,"color":"#9333ea"} — forward σ band
- {"kind":"buy_zone","y_low":float,"y_high":float,"label":"str","rationale":"str"} — entry range
- {"kind":"sell_zone","y_low":float,"y_high":float,"label":"str","rationale":"str"} — exit range

This will be scored against future price action.

When you are ready, output your final analysis as ONLY raw JSON — no markdown.`;

/**
 * Build the user prompt for a specific analysis iteration.
 * @param {string} symbol - Ticker symbol.
 * @param {Array} data - OHLCV data array.
 * @param {number} iter - Current iteration number (1-based).
 * @param {Array} prev - Previous strategy specs for deduplication.
 * @param {object} tfConfig - Timeframe configuration object.
 * @param {string} macroContext - Higher-timeframe context string.
 * @param {string} preComputedResults - Pre-computed tool chain results (optional).
 * @returns {string} Complete user prompt.
 */
export function buildPrompt(symbol, data, iter, prev, tfConfig, macroContext, preComputedResults) {
  const tailN = tfConfig.id === 'long' ? 60 : tfConfig.id === 'medium' ? 52 : 30;
  const recent = data.slice(-tailN);

  // Format OHLCV table
  let table = 'Date | Open | High | Low | Close | Volume\n';
  recent.forEach(r => {
    table += `${r.date} | ${r.open} | ${r.high} | ${r.low} | ${r.close} | ${r.volume}\n`;
  });

  // Determine lens for this iteration
  const lensIdx = (iter - 1) % STRATEGY_LENSES.length;
  const lens = STRATEGY_LENSES[lensIdx];
  const intervalLabel = tfConfig.interval === '1d' ? 'daily' : tfConfig.interval === '1wk' ? 'weekly' : 'monthly';

  let p = `Analyze the ${tfConfig.promptLabel} OHLCV data for ${symbol}.
This is ${recent.length} candles of ${intervalLabel} data spanning ${tfConfig.range}.

ANALYTICAL LENS: ${lens.name.toUpperCase()}
${lens.prompt}
`;

  // Inject pre-computed tool chain results
  if (preComputedResults) {
    p += `\n--- PRE-COMPUTED TOOL CHAIN RESULTS (${lens.name}) ---\n${preComputedResults}--- END PRE-COMPUTED ---\n\nThe above tool results have been auto-executed for your lens. Use them in your analysis. You may call additional tools for deeper investigation.\n\n`;
  }

  // Inject macro context from higher timeframes
  if (macroContext) {
    p += `\n--- MACRO CONTEXT (HIGHER TIMEFRAMES) ---\n${macroContext}Ensure your micro-level analysis accounts for this macro bias.\n--- END MACRO ---\n\n`;
  }

  p += `You may call additional tools to enhance your analysis, or create a custom tool chain with CREATE_TOOL_CHAIN.

Produce ONLY these specific overlays to fit your lens (do not use generic support/resistance):
${lens.overlays}

Final output MUST be ONLY raw JSON:
{
  "overlays": [
    {"kind":"line","x0":"YYYY-MM-DD","y0":float,"x1":"YYYY-MM-DD","y1":float,"color":"green","label":"str"},
    {"kind":"zone","x0":"YYYY-MM-DD","x1":"YYYY-MM-DD","y0":float,"y1":float,"color":"blue","label":"str"},
    {"kind":"volume_void","x0":"YYYY-MM-DD","x1":"YYYY-MM-DD","y0":float,"y1":float,"color":"purple","label":"str"},
    {"kind":"probability_band","y_upper":float,"y_lower":float,"sigma_level":1,"probability_pct":68,"color":"#9333ea"},
    {"kind":"buy_zone","y_low":float,"y_high":float,"label":"str","rationale":"str"},
    {"kind":"sell_zone","y_low":float,"y_high":float,"label":"str","rationale":"str"}
  ],
  "strategy_name": "short name",
  "analysis": "2-3 sentences.",
  "confidence": 0.0-1.0,
  "tools_used": ["TOOL1", "TOOL2"],
  "tool_chain_name": "name of the chain recipe used (or 'custom')",
  "prediction": {
    "direction": "LONG" or "SHORT" or "NEUTRAL",
    "target_price": float,
    "stop_loss": float,
    "horizon_days": 7 or 14 or 30,
    "buy_zone": { "entry_low": float, "entry_high": float, "rationale": "grounded in tool data" },
    "sell_zone": { "exit_low": float, "exit_high": float, "rationale": "grounded in tool data" },
    "probability": {
      "target_hit_pct": int 0-100,
      "stop_hit_pct": int 0-100,
      "risk_reward": float,
      "expected_move_1sigma": [low_float, high_float],
      "expected_move_2sigma": [low_float, high_float],
      "confidence_basis": "cite specific tool numbers"
    }
  }
}`;

  // Add memory context
  const memCtx = getMemoryContext(symbol);
  if (memCtx) p += '\n' + memCtx;

  // Add previous strategies for deduplication
  if (iter > 1 && prev.length) {
    p += '\n\n--- PREVIOUS STRATEGIES (use a DIFFERENT approach) ---\n';
    prev.forEach(x => {
      p += `\nStrategy ${x.iteration} — ${x.lens || 'unknown'} lens: "${x.strategy_name}" (conf: ${x.confidence}):\n`;
      p += `  Analysis: ${x.analysis}\n  Direction: ${x.prediction?.direction || '?'}\n`;
    });
    p += '--- END ---\nYou MUST use the ' + lens.name + ' lens. Do NOT repeat previous strategies.\n';
  }

  p += '\nData:\n' + table;
  return p;
}

// ══════════════════════════════════════════════════════════════
// PLANNER–EXECUTOR–SYNTHESIZER PROMPTS (Deep Mode)
// ══════════════════════════════════════════════════════════════

/** Planner system prompt — asks LLM to emit a plan, not a final analysis. */
export const PLANNER_SYSTEM_PROMPT = `You are an elite quantitative analyst planning a research workflow.

Your job is to SELECT which tools to run (not to produce a final analysis yet).
You will be given OHLCV price data and a strategy lens. Some tools have already been pre-computed for you.

AVAILABLE TOOLS:
${buildToolDefs()}

Output ONLY a JSON object with your tool plan. No markdown, no explanation outside the JSON.

{
  "plan": [
    {"tool": "TOOL_NAME", "args": "optional params"}
  ],
  "high_level_goal": "1 sentence describing your analytical thesis."
}

Rules:
- Maximum ${PLANNER_MAX_TOOLS} tools per plan.
- Do NOT request tools that were already pre-computed (listed below).
- You may request RESEARCH_SYMBOL for macro/earnings/sector context.
- You may request STRATEGY_LOOKUP or SUGGEST_STRATEGY for strategy recipes.
- You may request any CALC_* tool not already pre-computed.
- Prioritize tools that ADD information beyond what is already available.`;

/**
 * Build the planner user prompt.
 * @param {string} symbol - Ticker symbol.
 * @param {Array} data - OHLCV data array.
 * @param {number} iter - Current iteration number (1-based).
 * @param {Array} prev - Previous strategy specs for deduplication.
 * @param {object} tfConfig - Timeframe configuration object.
 * @param {string} preComputedResults - Pre-computed tool chain results.
 * @returns {string} Planner user prompt.
 */
export function buildPlannerPrompt(symbol, data, iter, prev, tfConfig, preComputedResults) {
  const tailN = tfConfig.id === 'long' ? 60 : tfConfig.id === 'medium' ? 52 : 30;
  const recent = data.slice(-tailN);

  // Compact OHLCV summary (planner doesn't need full table, just recent context)
  const last5 = recent.slice(-5);
  let summary = `${symbol} ${tfConfig.promptLabel} — ${recent.length} candles.\n`;
  summary += `Price range: $${Math.min(...recent.map(r => r.low)).toFixed(2)} – $${Math.max(...recent.map(r => r.high)).toFixed(2)}\n`;
  summary += `Latest close: $${last5[last5.length - 1]?.close || '?'}\n`;
  summary += `Recent 5 closes: ${last5.map(r => '$' + r.close).join(', ')}\n`;

  const lensIdx = (iter - 1) % STRATEGY_LENSES.length;
  const lens = STRATEGY_LENSES[lensIdx];

  let p = `Plan tool execution for ${symbol} using the ${lens.name.toUpperCase()} lens.\n`;
  p += `${lens.prompt}\n\n`;
  p += `Data summary:\n${summary}\n`;

  if (preComputedResults) {
    p += `--- ALREADY PRE-COMPUTED (do NOT re-request these) ---\n${preComputedResults}--- END PRE-COMPUTED ---\n\n`;
  }

  if (iter > 1 && prev.length) {
    p += '--- PREVIOUS STRATEGIES (try a DIFFERENT approach) ---\n';
    prev.forEach(x => {
      p += `  Iter ${x.iteration}: "${x.strategy_name}" (${x.lens || '?'} lens, conf: ${x.confidence})\n`;
    });
    p += '--- END ---\n\n';
  }

  const memCtx = getMemoryContext(symbol);
  if (memCtx) p += memCtx + '\n';

  p += `Output ONLY the plan JSON. Max ${PLANNER_MAX_TOOLS} tools.`;
  return p;
}

/** Synthesizer system prompt — receives tool results, produces final overlay spec. */
export const SYNTHESIZER_SYSTEM_PROMPT = `You are an elite quantitative analyst producing a final chart analysis.

You have been given:
1. OHLCV price data
2. Pre-computed tool results (indicators, patterns, research)
3. A strategy lens to focus on

CRITICAL RULES:
- You MUST base your overlays and analysis on the tool results provided. Do NOT hallucinate indicator values.
- Quote specific numbers from the tool results (RSI values, ATR levels, etc.) in your analysis.
- Do NOT call any tools. Your only job is to synthesize the data into a final overlay specification.
- You MUST include buy_zone, sell_zone, and probability data in your prediction, grounded in the tool results.
- If CALC_PRICE_LEVELS was run, use its pivot/volume confluence for buy/sell zones.
- If CALC_EXPECTED_MOVE or CALC_PROBABILITY_CONE was run, use their σ bands for probability data.
- If CALC_MONTE_CARLO was run, cite percentile data for target probability.

NEW OVERLAY TYPES AVAILABLE:
- {"kind":"probability_band","y_upper":float,"y_lower":float,"sigma_level":1|2,"probability_pct":68|95,"color":"#9333ea"} — forward σ band
- {"kind":"buy_zone","y_low":float,"y_high":float,"label":"str","rationale":"str"} — entry range
- {"kind":"sell_zone","y_low":float,"y_high":float,"label":"str","rationale":"str"} — exit range

Output ONLY raw JSON matching this schema — no markdown, no explanation outside the JSON:
{
  "overlays": [
    {"kind":"line","x0":"YYYY-MM-DD","y0":float,"x1":"YYYY-MM-DD","y1":float,"color":"green","label":"str"},
    {"kind":"zone","x0":"YYYY-MM-DD","x1":"YYYY-MM-DD","y0":float,"y1":float,"color":"blue","label":"str"},
    {"kind":"volume_void","x0":"YYYY-MM-DD","x1":"YYYY-MM-DD","y0":float,"y1":float,"color":"purple","label":"str"},
    {"kind":"probability_band","y_upper":float,"y_lower":float,"sigma_level":1,"probability_pct":68,"color":"#9333ea"},
    {"kind":"buy_zone","y_low":float,"y_high":float,"label":"str","rationale":"str"},
    {"kind":"sell_zone","y_low":float,"y_high":float,"label":"str","rationale":"str"}
  ],
  "strategy_name": "short name",
  "analysis": "2-3 sentences grounded in tool data.",
  "confidence": 0.0-1.0,
  "tools_used": ["TOOL1", "TOOL2"],
  "tool_chain_name": "name of the chain recipe used (or 'custom')",
  "prediction": {
    "direction": "LONG" or "SHORT" or "NEUTRAL",
    "target_price": float,
    "stop_loss": float,
    "horizon_days": 7 or 14 or 30,
    "buy_zone": { "entry_low": float, "entry_high": float, "rationale": "grounded in tool data" },
    "sell_zone": { "exit_low": float, "exit_high": float, "rationale": "grounded in tool data" },
    "probability": {
      "target_hit_pct": int 0-100,
      "stop_hit_pct": int 0-100,
      "risk_reward": float,
      "expected_move_1sigma": [low_float, high_float],
      "expected_move_2sigma": [low_float, high_float],
      "confidence_basis": "cite specific tool numbers"
    }
  }
}`;

/**
 * Build the synthesizer user prompt.
 * @param {string} symbol - Ticker symbol.
 * @param {Array} data - OHLCV data array.
 * @param {Array} toolsTrace - Array of {tool, args, status, result, elapsed_ms}.
 * @param {number} iter - Current iteration number.
 * @param {Array} prev - Previous strategy specs.
 * @param {object} tfConfig - Timeframe configuration.
 * @param {string} macroContext - Higher-timeframe context.
 * @returns {string} Synthesizer user prompt.
 */
export function buildSynthesizerPrompt(symbol, data, toolsTrace, iter, prev, tfConfig, macroContext) {
  const tailN = tfConfig.id === 'long' ? 60 : tfConfig.id === 'medium' ? 52 : 30;
  const recent = data.slice(-tailN);

  let table = 'Date | Open | High | Low | Close | Volume\n';
  recent.forEach(r => {
    table += `${r.date} | ${r.open} | ${r.high} | ${r.low} | ${r.close} | ${r.volume}\n`;
  });

  const lensIdx = (iter - 1) % STRATEGY_LENSES.length;
  const lens = STRATEGY_LENSES[lensIdx];

  let p = `Synthesize your final analysis for ${symbol} using the ${lens.name.toUpperCase()} lens.\n`;
  p += `${lens.prompt}\n\n`;

  // Inject tools trace
  if (toolsTrace && toolsTrace.length) {
    p += '--- TOOL RESULTS (base your analysis on these) ---\n';
    for (const t of toolsTrace) {
      const resultStr = (t.result || '').slice(0, SYNTH_TRACE_MAX_CHARS);
      const statusIcon = t.status === 'done' ? '✓' : t.status === 'error' ? '✗' : '?';
      p += `\n[${statusIcon} ${t.tool}${t.args ? '(' + t.args + ')' : ''}] (${t.elapsed_ms || 0}ms):\n${resultStr}\n`;
    }
    p += '--- END TOOL RESULTS ---\n\n';
  }

  if (macroContext) {
    p += `--- MACRO CONTEXT ---\n${macroContext}--- END MACRO ---\n\n`;
  }

  p += `Produce ONLY these specific overlays to fit your lens:\n${lens.overlays}\n\n`;

  if (iter > 1 && prev.length) {
    p += '--- PREVIOUS STRATEGIES (use a DIFFERENT approach) ---\n';
    prev.forEach(x => {
      p += `  Iter ${x.iteration} — ${x.lens || '?'} lens: "${x.strategy_name}" (conf: ${x.confidence})\n`;
    });
    p += '--- END ---\nYou MUST use the ' + lens.name + ' lens. Do NOT repeat previous strategies.\n\n';
  }

  const memCtx = getMemoryContext(symbol);
  if (memCtx) p += memCtx + '\n';

  p += 'Data:\n' + table;
  return p;
}

