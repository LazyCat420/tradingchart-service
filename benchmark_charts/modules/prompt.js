/**
 * prompt.js — LLM prompt construction.
 * Pure functions that build message strings. No I/O, no DOM.
 */
import { STRATEGY_LENSES, MAX_TOOL_ROUNDS } from './config.js';
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

CRITICAL: Your output MUST include a "prediction" block with a directional call, target price, stop loss, and time horizon. This will be scored against future price action.

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
    {"kind":"volume_void","x0":"YYYY-MM-DD","x1":"YYYY-MM-DD","y0":float,"y1":float,"color":"purple","label":"str"}
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
    "horizon_days": 7 or 14 or 30
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

