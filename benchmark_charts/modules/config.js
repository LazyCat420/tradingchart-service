/**
 * config.js — All application constants and configuration.
 * No logic, no I/O. Pure data definitions.
 */

// ── Model Registry ──
export const MODELS = [
  {
    id: '141',
    name: 'No Model (141)',
    endpoint: 'http://10.0.0.141:8000/v1/chat/completions',
    model: '',
    ready: false,
  },
  {
    id: '30',
    name: 'No Model (30)',
    endpoint: 'http://10.0.0.30:8000/v1/chat/completions',
    model: '',
    ready: false,
  },
];

export const MODEL_PROBE_INTERVAL_MS = 10_000;

export const CORS_PROXY = 'https://corsproxy.io/?url=';

// ── Timeframe Definitions ──
export const TIMEFRAMES = {
  short:  { id: 'short',  range: '3mo', interval: '1d',  label: '3M Daily',   promptLabel: 'SHORT-TERM (3 months, daily candles)' },
  medium: { id: 'medium', range: '1y',  interval: '1wk', label: '1Y Weekly',  promptLabel: 'MEDIUM-TERM (1 year, weekly candles)' },
  long:   { id: 'long',   range: '5y',  interval: '1mo', label: '5Y Monthly', promptLabel: 'LONG-TERM (5 years, monthly candles)' },
};

export const TF_ORDER = ['short', 'medium', 'long'];

// ── Strategy Lens Rotation ──
export const STRATEGY_LENSES = [
  {
    id: 'trend',
    name: 'Trend-Following',
    prompt: 'Focus EXCLUSIVELY on trend momentum. Do NOT draw horizontal support/resistance. You MUST map out the exact diagonal trajectory of the trend. Use the Expected Move σ bands to set probabilistic targets.',
    overlays: '1. Primary Diagonal Trendline (kind: "line")\n2. Moving Average trajectories (kind: "line")\n3. Expected move probability bands (kind: "probability_band")',
    toolChain: ['CALC_MACD', 'CALC_MACD_LEADER', 'CALC_WAVETREND', 'CALC_EXPECTED_MOVE'],
  },
  {
    id: 'mean_reversion',
    name: 'Mean-Reversion',
    prompt: 'Focus EXCLUSIVELY on statistical overextension. Analyze the pre-computed Bollinger, Z-Score, and Squeeze data below. Map out standard deviation extremes. Use Price Levels to identify precise buy/sell zones at pivot confluences.',
    overlays: '1. Upper & Lower Bollinger Band extremes (kind: "line")\n2. Mean / Fair Value targets (kind: "line")\n3. Buy zone at support confluence (kind: "buy_zone")\n4. Sell zone at resistance confluence (kind: "sell_zone")',
    toolChain: ['CALC_BOLLINGER', 'CALC_ZSCORE', 'CALC_SQUEEZE_MOMENTUM', 'CALC_PRICE_LEVELS'],
  },
  {
    id: 'structural',
    name: 'Structural/Liquidity',
    prompt: 'Focus EXCLUSIVELY on order block theory and liquidity gaps. Use the STRATEGY_LOOKUP results below for ICT/SMC concepts. Map institutional supply/demand zones and liquidity voids using the pre-computed VWAP and ATR data. Price Levels provide precise buy/sell zones at volume confluences.',
    overlays: '1. Major Supply / Demand Zones (kind: "zone")\n2. Liquidity Voids / Gaps (kind: "volume_void")\n3. Buy zone at demand confluence (kind: "buy_zone")\n4. Sell zone at supply confluence (kind: "sell_zone")',
    toolChain: ['STRATEGY_LOOKUP:order_block', 'STRATEGY_LOOKUP:liquidity_void', 'CALC_VWAP', 'CALC_ATR', 'CALC_VFI', 'CALC_PRICE_LEVELS'],
  },
  {
    id: 'momentum',
    name: 'Volatility Breakout',
    prompt: 'Focus EXCLUSIVELY on volatility expansion. Analyze the pre-computed ATR, Squeeze, and Bollinger data. Map only the exact breakout thresholds based on ATR multiples. Use Expected Move and Probability Cone to quantify breakout target probabilities.',
    overlays: '1. Breakout Trigger Levels (kind: "line")\n2. Volatility Expansion targets based on ATR (kind: "zone")\n3. Expected move probability bands (kind: "probability_band")',
    toolChain: ['CALC_ATR', 'CALC_SQUEEZE_MOMENTUM', 'CALC_BOLLINGER', 'CALC_EXPECTED_MOVE', 'CALC_PROBABILITY_CONE'],
  },
  {
    id: 'academic',
    name: 'Academic Quant',
    prompt: 'Act as a purely statistical academic researcher. You MUST call SEARCH_ARXIV for a specific quantitative finance or algorithmic trading paper to base your thesis on. Analyze the pre-computed statistical data including Monte Carlo simulation and probability cone. Ground your targets in distributional percentiles.',
    overlays: '1. Statistical anomaly bounds (kind: "line")\n2. Expected variance zones (kind: "zone")\n3. Monte Carlo percentile bands (kind: "probability_band")',
    toolChain: ['CALC_ZSCORE', 'CALC_FIBONACCI', 'CALC_RSI', 'CALC_MONTE_CARLO', 'CALC_PROBABILITY_CONE'],
  },
];

// ── Timing & Limits ──
export const TOOL_TIMEOUT_MS = 10_000;
export const TOOL_MAX_RESULT_CHARS = 3000;
export const MAX_TOOL_ROUNDS = 5;
export const LLM_TIMEOUT_MS = 240_000;
export const MAX_RETRIES_PER_ITER = 1;
export const FETCH_TIMEOUT_MS = 15_000;  // BUG FIX: original had NO timeout on Yahoo fetch

// ── Planner–Executor–Synthesizer Pipeline ──
export let ENABLE_PLANNER_EXECUTOR = true; // Deep mode (2 LLM calls) vs Quick mode (1 call)
export function setEnablePlannerExecutor(v) { ENABLE_PLANNER_EXECUTOR = v; }
export const PLANNER_MAX_TOOLS = 8;        // Max tools the planner can request per plan
export const SYNTH_TRACE_MAX_CHARS = 800;  // Per-tool result truncation in synthesizer prompt (raised for probability tools)
export const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute cache for /api/summary
