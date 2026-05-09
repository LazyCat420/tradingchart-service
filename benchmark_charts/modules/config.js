/**
 * config.js — All application constants and configuration.
 * No logic, no I/O. Pure data definitions.
 */

// ── Model Registry ──
export const MODELS = [
  {
    id: 'qwen-122b-141',
    name: 'Qwen3.5-122B (141)',
    endpoint: 'http://10.0.0.141:8000/v1/chat/completions',
    model: 'Qwen/Qwen3.5-122B-A10B-FP8',
  },
  {
    id: 'model-30',
    name: 'Qwen3.5-35B (30)',
    endpoint: 'http://10.0.0.30:8000/v1/chat/completions',
    model: 'Kbenkhaled/Qwen3.5-35B-A3B-quantized.w4a16',
  },
];

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
    prompt: 'Focus EXCLUSIVELY on trend momentum. Do NOT draw horizontal support/resistance. You MUST map out the exact diagonal trajectory of the trend.',
    overlays: '1. Primary Diagonal Trendline (kind: "line")\n2. Moving Average trajectories (kind: "line")',
  },
  {
    id: 'mean_reversion',
    name: 'Mean-Reversion',
    prompt: 'Focus EXCLUSIVELY on statistical overextension. You MUST call CALC_BOLLINGER and CALC_ZSCORE. Map out standard deviation extremes.',
    overlays: '1. Upper & Lower Bollinger Band extremes (kind: "line")\n2. Mean / Fair Value targets (kind: "line")',
  },
  {
    id: 'structural',
    name: 'Structural/Liquidity',
    prompt: 'Focus EXCLUSIVELY on deep order block theory and liquidity gaps. You MUST call SEARCH_WIKIPEDIA for "liquidity void" or "order block" theory before mapping zones.',
    overlays: '1. Major Supply / Demand Zones (kind: "zone")\n2. Liquidity Voids / Gaps (kind: "volume_void")',
  },
  {
    id: 'momentum',
    name: 'Volatility Breakout',
    prompt: 'Focus EXCLUSIVELY on volatility expansion. You MUST call CALC_ATR. Do not map historical support; map only the exact breakout thresholds based on ATR multiples.',
    overlays: '1. Breakout Trigger Levels (kind: "line")\n2. Volatility Expansion targets based on ATR (kind: "zone")',
  },
  {
    id: 'academic',
    name: 'Academic Quant',
    prompt: 'Act as a purely statistical academic researcher. You MUST call SEARCH_ARXIV for a specific quantitative finance or algorithmic trading paper to base your thesis on.',
    overlays: '1. Statistical anomaly bounds (kind: "line")\n2. Expected variance zones (kind: "zone")',
  },
];

// ── Timing & Limits ──
export const TOOL_TIMEOUT_MS = 10_000;
export const TOOL_MAX_RESULT_CHARS = 2000;
export const MAX_TOOL_ROUNDS = 5;
export const LLM_TIMEOUT_MS = 120_000;
export const MAX_RETRIES_PER_ITER = 1;
export const FETCH_TIMEOUT_MS = 15_000;  // BUG FIX: original had NO timeout on Yahoo fetch
