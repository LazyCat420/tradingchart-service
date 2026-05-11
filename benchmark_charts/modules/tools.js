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

function calcWaveTrend(data) {
  if (!data || data.length < 25) return 'Not enough data for WaveTrend(10,21)';
  const n1 = 10;
  const n2 = 21;
  const hlc3 = data.map(d => (d.high + d.low + d.close) / 3);

  const calcEMA = (src, period) => {
    const k = 2 / (period + 1);
    const ema = [src[0]];
    for (let i = 1; i < src.length; i++) {
      ema.push(src[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  };

  const esa = calcEMA(hlc3, n1);
  const absDiff = hlc3.map((val, i) => Math.abs(val - esa[i]));
  const d = calcEMA(absDiff, n1);
  const ci = hlc3.map((val, i) => d[i] === 0 ? 0 : (val - esa[i]) / (0.015 * d[i]));
  
  const wt1 = calcEMA(ci, n2);
  
  const wt2 = [];
  const smaPeriod = 4;
  for (let i = 0; i < wt1.length; i++) {
    if (i < smaPeriod - 1) {
      wt2.push(wt1[i]);
    } else {
      let sum = 0;
      for(let j = 0; j < smaPeriod; j++) sum += wt1[i-j];
      wt2.push(sum / smaPeriod);
    }
  }

  const currentWT1 = +(wt1[wt1.length - 1]).toFixed(2);
  const currentWT2 = +(wt2[wt2.length - 1]).toFixed(2);
  
  let signal = 'Neutral';
  if (currentWT1 > 60) signal = 'OVERBOUGHT (Wait for WT1 to cross under WT2)';
  else if (currentWT1 < -60) signal = 'OVERSOLD (Wait for WT1 to cross over WT2)';
  
  if (currentWT1 > currentWT2 && wt1[wt1.length-2] <= wt2[wt2.length-2]) {
    signal += ' | BULLISH CROSSOVER';
  } else if (currentWT1 < currentWT2 && wt1[wt1.length-2] >= wt2[wt2.length-2]) {
    signal += ' | BEARISH CROSSOVER';
  }

  return `WaveTrend(10,21):\n  WT1 (Fast): ${currentWT1}\n  WT2 (Slow): ${currentWT2}\n  Signal: ${signal}`;
}

function calcMACD(data) {
  if (!data || data.length < 30) return 'Not enough data for MACD(12,26,9)';
  const closes = data.map(d => d.close);
  
  const calcEMA = (src, period) => {
    const k = 2 / (period + 1);
    const ema = [src[0]];
    for (let i = 1; i < src.length; i++) {
      ema.push(src[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  };
  
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((val, i) => val - ema26[i]);
  const signalLine = calcEMA(macdLine, 9);
  const histogram = macdLine.map((val, i) => val - signalLine[i]);
  
  const currentMacd = +(macdLine[macdLine.length - 1]).toFixed(3);
  const currentSignal = +(signalLine[signalLine.length - 1]).toFixed(3);
  const currentHist = +(histogram[histogram.length - 1]).toFixed(3);
  
  let signal = 'Neutral';
  if (currentMacd > currentSignal && macdLine[macdLine.length-2] <= signalLine[signalLine.length-2]) {
    signal = 'BULLISH CROSSOVER';
  } else if (currentMacd < currentSignal && macdLine[macdLine.length-2] >= signalLine[signalLine.length-2]) {
    signal = 'BEARISH CROSSOVER';
  }
  
  return `MACD(12,26,9):\n  MACD Line: ${currentMacd}\n  Signal Line: ${currentSignal}\n  Histogram: ${currentHist}\n  Signal: ${signal}`;
}

function calcMACDLeader(data) {
  if (!data || data.length < 30) return 'Not enough data for MACD Leader';
  const closes = data.map(d => d.close);
  
  const calcEMA = (src, period) => {
    const k = 2 / (period + 1);
    const ema = [src[0]];
    for (let i = 1; i < src.length; i++) {
      ema.push(src[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  };
  
  const shortEma = calcEMA(closes, 12);
  const longEma = calcEMA(closes, 26);
  
  const shortDiff = closes.map((val, i) => val - shortEma[i]);
  const longDiff = closes.map((val, i) => val - longEma[i]);
  
  const emaShortDiff = calcEMA(shortDiff, 12);
  const emaLongDiff = calcEMA(longDiff, 26);
  
  const ind1 = shortEma.map((val, i) => val + emaShortDiff[i]);
  const ind2 = longEma.map((val, i) => val + emaLongDiff[i]);
  
  const leaderLine = ind1.map((val, i) => val - ind2[i]);
  const signalLine = calcEMA(leaderLine, 9);
  
  const currentLeader = +(leaderLine[leaderLine.length - 1]).toFixed(3);
  const currentSignal = +(signalLine[signalLine.length - 1]).toFixed(3);
  
  let signal = 'Neutral';
  if (currentLeader > currentSignal && leaderLine[leaderLine.length-2] <= signalLine[signalLine.length-2]) {
    signal = 'BULLISH LEADER CROSSOVER (Zero-Lag Early Signal)';
  } else if (currentLeader < currentSignal && leaderLine[leaderLine.length-2] >= signalLine[signalLine.length-2]) {
    signal = 'BEARISH LEADER CROSSOVER (Zero-Lag Early Signal)';
  }
  
  return `MACD Leader (Zero-Lag MACD):\n  Leader Line: ${currentLeader}\n  Signal Line: ${currentSignal}\n  Signal: ${signal}`;
}

function calcVWAP(data) {
  if (!data || data.length < 1) return 'Not enough data for VWAP';
  let cumVol = 0;
  let cumVolPrice = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const typPrice = (d.high + d.low + d.close) / 3;
    cumVol += d.volume;
    cumVolPrice += typPrice * d.volume;
  }
  const vwap = +(cumVolPrice / cumVol).toFixed(2);
  const current = data[data.length - 1].close;
  
  let signal = 'Neutral';
  if (current > vwap) signal = 'BULLISH (Price above VWAP)';
  else if (current < vwap) signal = 'BEARISH (Price below VWAP)';
  
  return `VWAP (entire period): $${vwap}\n  Current Price: $${current}\n  Signal: ${signal}`;
}

function calcSqueezeMomentum(data) {
  if (!data || data.length < 40) return 'Not enough data for Squeeze Momentum(20)';
  
  const length = 20;
  const bbMult = 2.0;
  const kcMult = 1.5;
  
  const closes = data.map(d => d.close);
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  
  const trs = [highs[0] - lows[0]];
  for (let i = 1; i < data.length; i++) {
    const hl = highs[i] - lows[i];
    const hpc = Math.abs(highs[i] - closes[i - 1]);
    const lpc = Math.abs(lows[i] - closes[i - 1]);
    trs.push(Math.max(hl, hpc, lpc));
  }
  
  const sliceCloses = closes.slice(-length);
  const sliceTrs = trs.slice(-length);
  
  const sma = sliceCloses.reduce((a, b) => a + b, 0) / length;
  const std = Math.sqrt(sliceCloses.reduce((a, b) => a + (b - sma) ** 2, 0) / length);
  
  const bbUpper = sma + bbMult * std;
  const bbLower = sma - bbMult * std;
  
  const smaTr = sliceTrs.reduce((a, b) => a + b, 0) / length;
  const kcUpper = sma + kcMult * smaTr;
  const kcLower = sma - kcMult * smaTr;
  
  const squeezeOn = bbLower > kcLower && bbUpper < kcUpper;
  
  const deltas = [];
  for (let i = data.length - length; i < data.length; i++) {
    const winHighs = highs.slice(i - length + 1, i + 1);
    const winLows = lows.slice(i - length + 1, i + 1);
    const winCloses = closes.slice(i - length + 1, i + 1);
    
    const highestHigh = Math.max(...winHighs);
    const lowestLow = Math.min(...winLows);
    const winSma = winCloses.reduce((a, b) => a + b, 0) / length;
    
    const avgVal = ((highestHigh + lowestLow) / 2 + winSma) / 2;
    deltas.push(closes[i] - avgVal);
  }
  
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < length; i++) {
    sumX += i;
    sumY += deltas[i];
    sumXY += i * deltas[i];
    sumX2 += i * i;
  }
  const m = (length * sumXY - sumX * sumY) / (length * sumX2 - sumX * sumX);
  const b = (sumY - m * sumX) / length;
  const momentum = +(m * (length - 1) + b).toFixed(4);
  
  let state = squeezeOn ? "SQUEEZE ON (Consolidating, preparing to break out)" : "SQUEEZE OFF (Momentum Released / Active Trend)";
  let dir = momentum > 0 ? "BULLISH Momentum" : "BEARISH Momentum";
  
  return `Squeeze Momentum (20, BB:2.0, KC:1.5):\n  Squeeze State: ${state}\n  Momentum Histogram: ${momentum} (${dir})`;
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
  CALC_WAVETREND:   { desc: 'Calculate WaveTrend Oscillator (10,21).', icon: '🌊', execute: (p, d) => calcWaveTrend(d) },
  CALC_MACD:        { desc: 'Calculate MACD (12,26,9).',             icon: '📉', execute: (p, d) => calcMACD(d) },
  CALC_MACD_LEADER: { desc: 'Calculate MACD Leader (Zero-lag).',     icon: '⚡', execute: (p, d) => calcMACDLeader(d) },
  CALC_SQUEEZE_MOMENTUM: { desc: 'Calculate Squeeze Momentum.',      icon: '🗜️', execute: (p, d) => calcSqueezeMomentum(d) },
  CALC_VWAP:        { desc: 'Calculate Volume Weighted Avg Price.',  icon: '⚖️', execute: (p, d) => calcVWAP(d) },
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
