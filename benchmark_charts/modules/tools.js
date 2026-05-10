/**
 * tools.js — Tool registry and execution.
 * Each tool is a pure async function that returns a string result.
 */
import { CORS_PROXY, TOOL_TIMEOUT_MS, TOOL_MAX_RESULT_CHARS } from './config.js';
import { loadMemory } from './memory.js';

// ── Individual Tool Implementations ──

async function searchWikipedia(params) {
  const q = (params || '').trim();
  if (!q) return 'Error: empty query';
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TOOL_TIMEOUT_MS);
  try {
    let res;
    try { res = await fetch(url, { signal: ctrl.signal }); }
    catch { res = await fetch(CORS_PROXY + encodeURIComponent(url), { signal: ctrl.signal }); }
    clearTimeout(t);
    if (!res.ok) return `Wikipedia: no article found for "${q}"`;
    const j = await res.json();
    return `Wikipedia — ${j.title}:\n${j.extract || 'No summary available.'}`;
  } catch (e) { clearTimeout(t); return `Wikipedia error: ${e.message}`; }
}

async function searchArxiv(params) {
  const q = (params || '').trim();
  if (!q) return 'Error: empty query';
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=3&sortBy=relevance`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TOOL_TIMEOUT_MS);
  try {
    let res;
    try { res = await fetch(url, { signal: ctrl.signal }); }
    catch { res = await fetch(CORS_PROXY + encodeURIComponent(url), { signal: ctrl.signal }); }
    clearTimeout(t);
    const text = await res.text();
    const entries = [...text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    if (!entries.length) return `ArXiv: no papers found for "${q}"`;
    return entries.map((m, i) => {
      const title = m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || 'Untitled';
      const summary = m[1].match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || '';
      return `[${i + 1}] ${title}\n   ${summary.slice(0, 300)}`;
    }).join('\n\n');
  } catch (e) { clearTimeout(t); return `ArXiv error: ${e.message}`; }
}

function calcRSI(data) {
  if (!data || data.length < 15) return 'Not enough data for RSI(14)';
  const closes = data.map(d => d.close);
  const period = 14;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsiValues = [];
  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      const diff = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push({ date: data[i].date, rsi: +(100 - 100 / (1 + rs)).toFixed(2) });
  }
  const last5 = rsiValues.slice(-5);
  const current = last5[last5.length - 1];
  let signal = 'Neutral';
  if (current.rsi > 70) signal = 'OVERBOUGHT';
  else if (current.rsi < 30) signal = 'OVERSOLD';
  return `RSI(14) Current: ${current.rsi} — ${signal}\nRecent: ${last5.map(r => `${r.date}: ${r.rsi}`).join(' | ')}`;
}

function calcZScore(data) {
  if (!data || data.length < 20) return 'Not enough data for Z-Score';
  const closes = data.map(d => d.close);
  const n = Math.min(50, closes.length);
  const slice = closes.slice(-n);
  const mean = slice.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const current = closes[closes.length - 1];
  const z = std === 0 ? 0 : +((current - mean) / std).toFixed(3);
  let signal = 'Normal range';
  if (z > 2) signal = 'EXTREMELY OVEREXTENDED — mean reversion likely';
  else if (z > 1) signal = 'Extended above mean';
  else if (z < -2) signal = 'EXTREMELY OVERSOLD — bounce likely';
  else if (z < -1) signal = 'Below mean';
  return `Z-Score(${n}): ${z} — ${signal}\nCurrent: $${current.toFixed(2)} | Mean: $${mean.toFixed(2)} | StdDev: $${std.toFixed(2)}`;
}

function calcBollinger(data) {
  if (!data || data.length < 20) return 'Not enough data for Bollinger Bands';
  const closes = data.map(d => d.close);
  const n = 20;
  const slice = closes.slice(-n);
  const sma = slice.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - sma) ** 2, 0) / n);
  const upper = +(sma + 2 * std).toFixed(2);
  const lower = +(sma - 2 * std).toFixed(2);
  const current = closes[closes.length - 1];
  const pctB = std === 0 ? 0.5 : +((current - lower) / (upper - lower)).toFixed(3);
  let signal = 'Within bands';
  if (current > upper) signal = 'ABOVE upper band — potential reversal/breakout';
  else if (current < lower) signal = 'BELOW lower band — potential bounce/breakdown';
  return `Bollinger(20,2σ):\n  Upper: $${upper} | SMA: $${sma.toFixed(2)} | Lower: $${lower}\n  Current: $${current.toFixed(2)} | %B: ${pctB}\n  Signal: ${signal}`;
}

function calcATR(data) {
  if (!data || data.length < 15) return 'Not enough data for ATR(14)';
  const trs = [];
  for (let i = 1; i < data.length; i++) {
    const h = data[i].high, l = data[i].low, pc = data[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const period = 14;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  const current = data[data.length - 1].close;
  const pct = +((atr / current) * 100).toFixed(2);
  return `ATR(14): $${atr.toFixed(2)} (${pct}% of price)\nCurrent Price: $${current.toFixed(2)}\nDaily volatility range: ±$${atr.toFixed(2)}`;
}

function calcFibonacci(data) {
  if (!data || data.length < 10) return 'Not enough data for Fibonacci';
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  const swingHigh = Math.max(...highs);
  const swingLow = Math.min(...lows);
  const diff = swingHigh - swingLow;
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
  const current = data[data.length - 1].close;
  const lines = levels.map(l => {
    const price = +(swingHigh - diff * l).toFixed(2);
    const tag = current > price - diff * 0.02 && current < price + diff * 0.02 ? ' ◀ NEAR' : '';
    return `  ${(l * 100).toFixed(1)}%: $${price}${tag}`;
  });
  return `Fibonacci Retracement:\n  Swing High: $${swingHigh.toFixed(2)} | Swing Low: $${swingLow.toFixed(2)}\n${lines.join('\n')}\n  Current: $${current.toFixed(2)}`;
}

function getMemoryTool(symbol) {
  const mem = loadMemory();
  const entries = mem[symbol]?.entries || [];
  if (!entries.length) return `No past memory for ${symbol}. This is a fresh analysis.`;
  const recent = entries.slice(-5);
  const scored = entries.filter(e => e.forward_score != null);
  const highPerf = scored.filter(e => e.forward_score >= 0.7);
  const lowPerf = scored.filter(e => e.forward_score < 0.4);
  let out = `Memory for ${symbol} (${entries.length} total entries, ${scored.length} scored):\n`;
  if (highPerf.length) {
    out += `  High performers:\n`;
    highPerf.slice(-3).forEach(e => {
      out += `    "${e.strategy_name}" (${e.lens || '?'} lens) score: ${e.forward_score.toFixed(2)}\n`;
    });
  }
  if (lowPerf.length) {
    out += `  Low performers (AVOID these approaches):\n`;
    lowPerf.slice(-3).forEach(e => {
      out += `    "${e.strategy_name}" (${e.lens || '?'} lens) score: ${e.forward_score.toFixed(2)}\n`;
    });
  }
  out += `  Recent strategies:\n`;
  recent.forEach((e, i) => {
    const score = e.forward_score != null ? ' score:' + e.forward_score.toFixed(2) : '';
    out += `    ${i + 1}. [${e.timestamp?.slice(0, 10) || '?'}] ${e.timeframe}: "${e.strategy_name}" (${e.lens || '?'}) conf:${e.confidence}${score}\n`;
  });
  return out;
}

// ── Tool Registry ──
export const TOOL_REGISTRY = {
  SEARCH_WIKIPEDIA: { desc: 'Search Wikipedia for a quant concept.', icon: '🔍', execute: (p) => searchWikipedia(p) },
  SEARCH_ARXIV:     { desc: 'Search ArXiv for research papers.',     icon: '📄', execute: (p) => searchArxiv(p) },
  CALC_RSI:         { desc: 'Calculate RSI(14).',                    icon: '📊', execute: (p, d) => calcRSI(d) },
  CALC_ZSCORE:      { desc: 'Calculate Z-Score vs N-period mean.',   icon: '📈', execute: (p, d) => calcZScore(d) },
  CALC_BOLLINGER:   { desc: 'Calculate Bollinger Bands (20,2σ).',    icon: '📉', execute: (p, d) => calcBollinger(d) },
  CALC_ATR:         { desc: 'Calculate ATR(14).',                    icon: '⚡', execute: (p, d) => calcATR(d) },
  CALC_FIBONACCI:   { desc: 'Calculate Fibonacci retracement.',      icon: '🔢', execute: (p, d) => calcFibonacci(d) },
  GET_MEMORY:       { desc: 'Retrieve past strategy performance.',   icon: '🧠', execute: (p, d, s) => getMemoryTool(s) },
};

/**
 * Execute a named tool safely, with result truncation.
 * @param {string} toolName - Registry key.
 * @param {string} params - Raw params string from LLM.
 * @param {Array} data - OHLCV data array.
 * @param {string} symbol - Ticker symbol.
 * @returns {Promise<string>} Tool result string.
 */
export async function executeToolCall(toolName, params, data, symbol) {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) return `Unknown tool: ${toolName}`;
  try {
    const result = await tool.execute(params, data, symbol);
    return (result || '').slice(0, TOOL_MAX_RESULT_CHARS);
  } catch (e) {
    return `Tool error (${toolName}): ${e.message}`;
  }
}

/** Parse TOOL_CALL directive from LLM output text. */
export function parseToolCallDirective(text) {
  // Handles standard, full-width colon, full-width parens, and markdown formatting
  const match = text.match(/TOOL_CALL(?:[:：])?\s*\*?\*?\s*`?(\w+)`?[(\uff08]([^)\uff09]*)[)\uff09]/);
  if (!match) return null;
  return { tool: match[1], params: match[2].trim() };
}
