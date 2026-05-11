/**
 * tools.js — Tool registry and execution.
 * Each tool is a pure async function that returns a string result.
 */
import { CORS_PROXY, TOOL_TIMEOUT_MS, TOOL_MAX_RESULT_CHARS, SUMMARY_CACHE_TTL_MS } from './config.js';
import { loadMemory } from './memory.js';
import { lookupStrategy, suggestStrategy } from './strategy_kb.js';

// ── Individual Tool Implementations ──

async function searchWikipedia(params) {
  const q = (params || '').trim();
  if (!q) return 'Error: empty query';

  // Domain keyword enrichment — append finance context to trading queries
  const financeTerms = ['trading', 'finance', 'market', 'stock', 'indicator', 'technical analysis'];
  const hasFinanceContext = financeTerms.some(t => q.toLowerCase().includes(t));
  const enrichedQuery = hasFinanceContext ? q : `${q} trading finance`;

  // Use CirrusSearch full-text API (fuzzy matching) instead of exact-title REST API
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(enrichedQuery)}&srwhat=text&srlimit=3&format=json&origin=*`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TOOL_TIMEOUT_MS);
  try {
    let res;
    try { res = await fetch(url, { signal: ctrl.signal }); }
    catch { res = await fetch(CORS_PROXY + encodeURIComponent(url), { signal: ctrl.signal }); }
    clearTimeout(t);
    if (!res.ok) return `Wikipedia search failed for "${q}"`;
    const j = await res.json();
    const results = j?.query?.search || [];
    if (!results.length) return `Wikipedia: no results for "${q}" (searched: "${enrichedQuery}")`;
    return results.map((r, i) => {
      // Strip HTML tags from snippet
      const snippet = (r.snippet || '').replace(/<[^>]+>/g, '').trim();
      return `[${i + 1}] ${r.title}:\n   ${snippet}`;
    }).join('\n\n');
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

// ── Volume Flow Indicator (LazyBear) ──

function calcVFI(data) {
  if (!data || data.length < 30) return 'Not enough data for VFI(130)';
  const period = Math.min(130, data.length - 1);
  const coef = 0.2;
  const vcoef = 2.5;

  // Calculate typical price and inter-bar changes
  const tp = data.map(d => (d.high + d.low + d.close) / 3);
  const inter = [];
  for (let i = 1; i < data.length; i++) {
    inter.push(Math.log(tp[i]) - Math.log(tp[i - 1]));
  }

  // Standard deviation of log changes for cutoff
  const slice = inter.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
  const cutoff = coef * std;

  // Volume average for capping
  const vols = data.slice(-period).map(d => d.volume);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const maxVol = avgVol * vcoef;

  // Calculate VFI
  let vfi = 0;
  const startIdx = Math.max(1, data.length - period);
  for (let i = startIdx; i < data.length; i++) {
    const change = Math.log(tp[i]) - Math.log(tp[i - 1]);
    const cappedVol = Math.min(data[i].volume, maxVol);
    if (change > cutoff) vfi += cappedVol;
    else if (change < -cutoff) vfi -= cappedVol;
  }

  // Normalize to percentage of total volume
  const totalVol = vols.reduce((a, b) => a + b, 0);
  const vfiPct = +((vfi / totalVol) * 100).toFixed(2);

  let signal = 'Neutral';
  if (vfiPct > 10) signal = 'STRONG ACCUMULATION (Institutional buying pressure)';
  else if (vfiPct > 0) signal = 'Mild accumulation';
  else if (vfiPct < -10) signal = 'STRONG DISTRIBUTION (Institutional selling pressure)';
  else if (vfiPct < 0) signal = 'Mild distribution';

  // Check for divergence
  const priceDir = data[data.length - 1].close > data[startIdx].close ? 'rising' : 'falling';
  const vfiDir = vfiPct > 0 ? 'positive' : 'negative';
  const divergence = (priceDir === 'rising' && vfiPct < 0) ? '⚠ BEARISH DIVERGENCE: Price rising but volume distributing!'
    : (priceDir === 'falling' && vfiPct > 0) ? '⚠ BULLISH DIVERGENCE: Price falling but volume accumulating!'
    : 'No divergence';

  return `VFI(${period}): ${vfiPct}% — ${signal}\n  Price: ${priceDir} | VFI: ${vfiDir}\n  ${divergence}`;
}

// ── Custom Chain Storage (localStorage persistence) ──

function loadCustomChains() {
  try { return JSON.parse(localStorage.getItem('aql_custom_chains') || '[]'); }
  catch { return []; }
}

function saveCustomChain(chain) {
  const chains = loadCustomChains();
  // Deduplicate by tool combo hash
  const hash = chain.tools.slice().sort().join('+');
  const existing = chains.findIndex(c => c.hash === hash);
  if (existing >= 0) {
    chains[existing].uses = (chains[existing].uses || 0) + 1;
    chains[existing].lastUsed = new Date().toISOString();
  } else {
    chains.push({ ...chain, hash, uses: 1, created: new Date().toISOString(), lastUsed: new Date().toISOString(), scores: [] });
  }
  // Keep max 50 custom chains
  if (chains.length > 50) chains.splice(0, chains.length - 50);
  try { localStorage.setItem('aql_custom_chains', JSON.stringify(chains)); } catch { /* quota */ }
}

function getBestChains(symbol) {
  const mem = loadMemory();
  const entries = mem[symbol]?.entries || [];
  const scored = entries.filter(e => e.forward_score != null && e.tool_chain_hash);

  if (!scored.length) {
    // Fall back to custom chains
    const custom = loadCustomChains();
    if (!custom.length) return `No chain performance data yet for ${symbol}. Run analyses and score them to build the chain leaderboard.`;
    return `No scored chains for ${symbol} yet. ${custom.length} custom chains available globally.\n` +
      custom.slice(-5).map(c => `  • ${c.name} [${c.tools.join(', ')}] (${c.uses} uses)`).join('\n');
  }

  // Aggregate by chain hash
  const byHash = {};
  for (const e of scored) {
    if (!byHash[e.tool_chain_hash]) byHash[e.tool_chain_hash] = { name: e.tool_chain_name || e.tool_chain_hash, scores: [], tools: e.tools_used || [] };
    byHash[e.tool_chain_hash].scores.push(e.forward_score);
  }

  const ranked = Object.values(byHash).map(h => ({
    ...h,
    avg: h.scores.reduce((a, b) => a + b, 0) / h.scores.length,
    count: h.scores.length,
  })).sort((a, b) => b.avg - a.avg);

  let out = `Chain Performance for ${symbol} (${scored.length} scored strategies):\n\n`;
  out += '— TOP PERFORMERS —\n';
  ranked.slice(0, 5).forEach((r, i) => {
    out += `${i + 1}. ${r.name} (avg: ${r.avg.toFixed(2)}, ${r.count} uses) [${r.tools.join(', ')}]\n`;
  });

  const worst = ranked.filter(r => r.avg < 0.4);
  if (worst.length) {
    out += '\n— AVOID (low scores) —\n';
    worst.slice(0, 3).forEach(r => {
      out += `  ✗ ${r.name} (avg: ${r.avg.toFixed(2)}) — underperformed\n`;
    });
  }

  return out;
}

// ── RESEARCH_SYMBOL: Composite Research Hub ──

const _summaryCache = new Map();

/**
 * Fetch fundamental summary from the data proxy's /api/summary endpoint.
 * Results are cached for SUMMARY_CACHE_TTL_MS to avoid repeated slow calls.
 * @param {string} symbol - Ticker symbol.
 * @returns {Promise<string>} Formatted summary string.
 */
async function fetchSymbolSummary(symbol) {
  const cacheKey = symbol.toUpperCase();
  const cached = _summaryCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SUMMARY_CACHE_TTL_MS) return cached.result;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TOOL_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/summary?symbol=${encodeURIComponent(symbol)}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return `Summary unavailable for ${symbol} (${res.status})`;
    const j = await res.json();
    if (j.error) return `Summary error: ${j.error}`;
    const lines = [
      `${j.name || symbol} (${j.sector || '?'} / ${j.industry || '?'})`,
      `Market Cap: $${j.market_cap ? (j.market_cap / 1e9).toFixed(1) + 'B' : '?'}`,
      `P/E: ${j.pe_ratio || '?'} | Fwd P/E: ${j.forward_pe || '?'}`,
      `52wk: $${j['52wk_low'] || '?'} – $${j['52wk_high'] || '?'}`,
      `Avg Volume: ${j.avg_volume ? (j.avg_volume / 1e6).toFixed(1) + 'M' : '?'}`,
      j.dividend_yield ? `Div Yield: ${(j.dividend_yield * 100).toFixed(2)}%` : null,
      j.analyst_target ? `Analyst Target: $${j.analyst_target}` : null,
      j.earnings_date ? `Next Earnings: ${j.earnings_date}` : null,
    ].filter(Boolean).join('\n  ');
    const result = `Fundamentals:\n  ${lines}`;
    _summaryCache.set(cacheKey, { result, ts: Date.now() });
    return result;
  } catch (e) { clearTimeout(t); return `Summary fetch error: ${e.message}`; }
}

/**
 * Composite research tool: Wikipedia + Yahoo Finance summary.
 * @param {string} params - Query string (may include symbol context).
 * @param {Array} data - OHLCV data (unused).
 * @param {string} symbol - Ticker symbol.
 * @returns {Promise<string>} Combined research results.
 */
async function researchSymbol(params, data, symbol) {
  const query = (params || '').trim() || `${symbol} stock market analysis`;

  // Run Wikipedia search + Yahoo summary in parallel
  const [wikiResult, summaryResult] = await Promise.allSettled([
    searchWikipedia(`${symbol} ${query}`),
    fetchSymbolSummary(symbol),
  ]);

  let out = `Research for ${symbol}: "${query}"\n\n`;

  if (summaryResult.status === 'fulfilled') {
    out += `── Yahoo Finance ──\n${summaryResult.value}\n\n`;
  }

  if (wikiResult.status === 'fulfilled') {
    out += `── Wikipedia ──\n${wikiResult.value}\n`;
  }

  return out;
}

// ── Price Levels: Pivot Points + Volume Profile ──

function calcPriceLevels(data) {
  if (!data || data.length < 20) return 'Not enough data for Price Levels';
  const recent = data.slice(-20);
  const last = data[data.length - 1];
  const current = last.close;

  // Classic Floor Pivot Points from recent swing
  const periodHigh = Math.max(...recent.map(d => d.high));
  const periodLow = Math.min(...recent.map(d => d.low));
  const PP = +((periodHigh + periodLow + current) / 3).toFixed(2);
  const R1 = +(2 * PP - periodLow).toFixed(2);
  const S1 = +(2 * PP - periodHigh).toFixed(2);
  const R2 = +(PP + (periodHigh - periodLow)).toFixed(2);
  const S2 = +(PP - (periodHigh - periodLow)).toFixed(2);
  const R3 = +(periodHigh + 2 * (PP - periodLow)).toFixed(2);
  const S3 = +(periodLow - 2 * (periodHigh - PP)).toFixed(2);

  // Volume Profile — bin prices to find POC, VAH, VAL
  const allPrices = data.map(d => d.close);
  const priceMin = Math.min(...data.map(d => d.low));
  const priceMax = Math.max(...data.map(d => d.high));
  const numBins = 30;
  const binSize = (priceMax - priceMin) / numBins || 1;
  const bins = new Array(numBins).fill(0);

  for (const d of data) {
    const typPrice = (d.high + d.low + d.close) / 3;
    const binIdx = Math.min(numBins - 1, Math.floor((typPrice - priceMin) / binSize));
    bins[binIdx] += d.volume;
  }

  // POC = bin with highest volume
  let pocIdx = 0;
  for (let i = 1; i < numBins; i++) {
    if (bins[i] > bins[pocIdx]) pocIdx = i;
  }
  const POC = +(priceMin + (pocIdx + 0.5) * binSize).toFixed(2);

  // Value Area (70% of total volume around POC)
  const totalVol = bins.reduce((a, b) => a + b, 0);
  const targetVol = totalVol * 0.7;
  let vaVol = bins[pocIdx];
  let vaLow = pocIdx, vaHigh = pocIdx;
  while (vaVol < targetVol && (vaLow > 0 || vaHigh < numBins - 1)) {
    const downVol = vaLow > 0 ? bins[vaLow - 1] : 0;
    const upVol = vaHigh < numBins - 1 ? bins[vaHigh + 1] : 0;
    if (downVol >= upVol && vaLow > 0) { vaLow--; vaVol += bins[vaLow]; }
    else if (vaHigh < numBins - 1) { vaHigh++; vaVol += bins[vaHigh]; }
    else if (vaLow > 0) { vaLow--; vaVol += bins[vaLow]; }
    else break;
  }
  const VAL = +(priceMin + vaLow * binSize).toFixed(2);
  const VAH = +(priceMin + (vaHigh + 1) * binSize).toFixed(2);

  // Historical bounce rate at S1/R1 (simplified: count times price touched zone and reversed)
  let s1Bounces = 0, r1Bounces = 0, s1Tests = 0, r1Tests = 0;
  const tolerance = (periodHigh - periodLow) * 0.02;
  for (let i = 1; i < data.length; i++) {
    if (Math.abs(data[i].low - S1) < tolerance * 2) {
      s1Tests++;
      if (data[i].close > data[i].open) s1Bounces++;
    }
    if (Math.abs(data[i].high - R1) < tolerance * 2) {
      r1Tests++;
      if (data[i].close < data[i].open) r1Bounces++;
    }
  }
  const s1BounceRate = s1Tests > 0 ? Math.round((s1Bounces / s1Tests) * 100) : 50;
  const r1BounceRate = r1Tests > 0 ? Math.round((r1Bounces / r1Tests) * 100) : 50;

  // Determine buy/sell zones with confluence
  const buyLow = Math.min(S1, VAL);
  const buyHigh = Math.max(S1, VAL);
  const sellLow = Math.min(R1, VAH);
  const sellHigh = Math.max(R1, VAH);

  return `Price Levels (Floor Pivots + Volume Profile):
  Pivot Point: $${PP}
  R3: $${R3} | R2: $${R2} | R1: $${R1}
  S1: $${S1} | S2: $${S2} | S3: $${S3}
  POC (Volume): $${POC} | VAH: $${VAH} | VAL: $${VAL}
  Current: $${current.toFixed(2)}
  BUY ZONE: $${buyLow.toFixed(2)} – $${buyHigh.toFixed(2)} (S1+VAL confluence, ~${s1BounceRate}% hist bounce rate)
  SELL ZONE: $${sellLow.toFixed(2)} – $${sellHigh.toFixed(2)} (R1+VAH confluence, ~${r1BounceRate}% hist rejection rate)`;
}

// ── Expected Move: Volatility-Based σ Bands ──

function calcExpectedMove(data) {
  if (!data || data.length < 25) return 'Not enough data for Expected Move';
  const closes = data.map(d => d.close);
  const current = closes[closes.length - 1];

  // Daily log returns
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }

  // Historical Volatility (20-day lookback)
  const lookback = Math.min(20, logReturns.length);
  const recentReturns = logReturns.slice(-lookback);
  const meanReturn = recentReturns.reduce((a, b) => a + b, 0) / lookback;
  const variance = recentReturns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / (lookback - 1);
  const dailyVol = Math.sqrt(variance);
  const annualVol = +(dailyVol * Math.sqrt(252) * 100).toFixed(1);

  // HV percentile vs 1-year range of rolling 20-day HV
  const hvValues = [];
  for (let i = 20; i < logReturns.length; i++) {
    const window = logReturns.slice(i - 20, i);
    const m = window.reduce((a, b) => a + b, 0) / 20;
    const v = window.reduce((a, r) => a + (r - m) ** 2, 0) / 19;
    hvValues.push(Math.sqrt(v));
  }
  let hvPercentile = 50;
  if (hvValues.length > 5) {
    const sorted = [...hvValues].sort((a, b) => a - b);
    const rank = sorted.findIndex(v => v >= dailyVol);
    hvPercentile = Math.round((rank / sorted.length) * 100);
  }

  // Expected Move for each horizon
  const horizons = [7, 14, 30];
  const lines = horizons.map(h => {
    const em = current * dailyVol * Math.sqrt(h);
    const em1 = +em.toFixed(2);
    const em2 = +(2 * em).toFixed(2);
    const em3 = +(3 * em).toFixed(2);
    const pct = +((em / current) * 100).toFixed(1);
    return `  ${h}-Day Expected Move: ±$${em1} (±${pct}%)
    68% range: [$${(current - em1).toFixed(2)} – $${(current + em1).toFixed(2)}]
    95% range: [$${(current - em2).toFixed(2)} – $${(current + em2).toFixed(2)}]
    99% range: [$${(current - em3).toFixed(2)} – $${(current + em3).toFixed(2)}]`;
  });

  return `Expected Move (Volatility-Based σ Bands):
  Current: $${current.toFixed(2)} | HV(20): ${annualVol}% annualized | HV Percentile: ${hvPercentile}th
${lines.join('\n')}`;
}

// ── Probability Cone: Forward Distribution with Skew/Kurtosis ──

function calcProbabilityCone(data) {
  if (!data || data.length < 30) return 'Not enough data for Probability Cone';
  const closes = data.map(d => d.close);
  const current = closes[closes.length - 1];

  // Full-sample log returns
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const n = logReturns.length;
  const mu = logReturns.reduce((a, b) => a + b, 0) / n;
  const sigma = Math.sqrt(logReturns.reduce((a, r) => a + (r - mu) ** 2, 0) / (n - 1));

  // Skewness
  const m3 = logReturns.reduce((a, r) => a + ((r - mu) / sigma) ** 3, 0) / n;
  const skewness = +m3.toFixed(3);

  // Excess Kurtosis
  const m4 = logReturns.reduce((a, r) => a + ((r - mu) / sigma) ** 4, 0) / n;
  const kurtosis = +(m4 - 3).toFixed(3);

  // Fat-tail adjustment factor
  const tailFactor = Math.max(1, 1 + Math.abs(kurtosis) * 0.1);

  // Cumulative Normal CDF approximation (Abramowitz & Stegun)
  const normalCDF = (x) => {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const z = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + p * z);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return 0.5 * (1 + sign * y);
  };

  // Probability of reaching a price level
  const pAbovePrice = (target, horizon) => {
    const driftedMu = mu * horizon;
    const scaledSigma = sigma * Math.sqrt(horizon) * tailFactor;
    const z = (Math.log(target / current) - driftedMu) / scaledSigma;
    return +(1 - normalCDF(z));
  };

  // Per-horizon projections
  const horizons = [7, 14, 30];
  const lines = horizons.map(h => {
    const expectedPrice = +(current * Math.exp(mu * h)).toFixed(2);
    const em = sigma * Math.sqrt(h) * tailFactor;
    const upper1 = +(current * Math.exp(mu * h + em)).toFixed(2);
    const lower1 = +(current * Math.exp(mu * h - em)).toFixed(2);
    const upper2 = +(current * Math.exp(mu * h + 2 * em)).toFixed(2);
    const lower2 = +(current * Math.exp(mu * h - 2 * em)).toFixed(2);
    const pUp = +(pAbovePrice(current, h) * 100).toFixed(1);

    return `  ${h}-Day Projection:
    Expected: $${expectedPrice} | P(above current): ${pUp}%
    1σ (68%): [$${lower1} – $${upper1}]
    2σ (95%): [$${lower2} – $${upper2}]`;
  });

  const fatTailWarning = Math.abs(kurtosis) > 1 ? 'YES — widen stops, tails are fatter than normal' : 'NO';

  return `Probability Cone (Forward Distribution):
  Current: $${current.toFixed(2)} | Daily μ: ${(mu * 100).toFixed(4)}% | Daily σ: ${(sigma * 100).toFixed(3)}%
  Skewness: ${skewness} (${skewness > 0.3 ? 'right-skewed/bullish tilt' : skewness < -0.3 ? 'left-skewed/bearish tilt' : 'roughly symmetric'})
  Excess Kurtosis: ${kurtosis} | Fat-tail warning: ${fatTailWarning}
  Tail adjustment factor: ${tailFactor.toFixed(2)}x
${lines.join('\n')}`;
}

// ── Monte Carlo: GBM Price Path Simulation ──

function calcMonteCarlo(data) {
  if (!data || data.length < 30) return 'Not enough data for Monte Carlo';
  const closes = data.map(d => d.close);
  const current = closes[closes.length - 1];

  // Calibrate GBM from historical data
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const n = logReturns.length;
  const mu = logReturns.reduce((a, b) => a + b, 0) / n;
  const sigma = Math.sqrt(logReturns.reduce((a, r) => a + (r - mu) ** 2, 0) / (n - 1));

  // Seeded PRNG (mulberry32) for reproducible results
  let seed = 42;
  for (let i = 0; i < closes.length; i++) seed = (seed + Math.round(closes[i] * 100)) | 0;
  const prng = () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };

  // Box-Muller transform for normal random numbers
  const randNormal = () => {
    const u1 = prng(), u2 = prng();
    return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  };

  const numSims = 500;
  const horizon = 30;
  const drift = mu - (sigma * sigma) / 2;
  const terminals = [];

  for (let sim = 0; sim < numSims; sim++) {
    let price = current;
    for (let day = 0; day < horizon; day++) {
      const z = randNormal();
      price = price * Math.exp(drift + sigma * z);
    }
    terminals.push(price);
  }

  terminals.sort((a, b) => a - b);
  const pctile = (p) => terminals[Math.floor(p / 100 * (numSims - 1))];
  const p10 = +pctile(10).toFixed(2);
  const p25 = +pctile(25).toFixed(2);
  const p50 = +pctile(50).toFixed(2);
  const p75 = +pctile(75).toFixed(2);
  const p90 = +pctile(90).toFixed(2);
  const mean = +(terminals.reduce((a, b) => a + b, 0) / numSims).toFixed(2);

  // % of paths above/below key levels
  const pAbove = +(terminals.filter(t => t > current).length / numSims * 100).toFixed(1);
  const pBelow = +(terminals.filter(t => t < current).length / numSims * 100).toFixed(1);

  // Expected max drawdown and max gain across simulations
  const maxGain = +((p90 - current) / current * 100).toFixed(1);
  const maxLoss = +((p10 - current) / current * 100).toFixed(1);

  return `Monte Carlo Simulation (${numSims} paths, ${horizon}-day horizon):
  Current: $${current.toFixed(2)} | Drift (μ): ${(mu * 100).toFixed(4)}%/day | Vol (σ): ${(sigma * 100).toFixed(3)}%/day
  Mean Terminal: $${mean} | Median Terminal: $${p50}
  10th pctile (bearish): $${p10} (${maxLoss}%)
  25th pctile: $${p25}
  50th pctile (most likely): $${p50}
  75th pctile: $${p75}
  90th pctile (bullish): $${p90} (+${maxGain}%)
  P(above current): ${pAbove}% | P(below current): ${pBelow}%`;
}

// ── Tool Registry ──
export const TOOL_REGISTRY = {
  SEARCH_WIKIPEDIA: { desc: 'Search Wikipedia for a quant/finance concept (fuzzy full-text search).', icon: '🔍', execute: (p) => searchWikipedia(p) },
  SEARCH_ARXIV:     { desc: 'Search ArXiv for research papers.',     icon: '📄', execute: (p) => searchArxiv(p) },
  STRATEGY_LOOKUP:  { desc: 'Search the local strategy KB for a trading concept (order blocks, squeeze, ICT, etc).', icon: '📚', execute: (p) => lookupStrategy(p) },
  SUGGEST_STRATEGY: { desc: 'Get strategy recipe suggestions based on market conditions.', icon: '💡', execute: (p) => suggestStrategy(p) },
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
  CALC_VFI:         { desc: 'Calculate Volume Flow Indicator (LazyBear). Detects accumulation/distribution.', icon: '🔊', execute: (p, d) => calcVFI(d) },
  CALC_PRICE_LEVELS: { desc: 'Calculate pivot points, volume profile (POC/VAH/VAL), and buy/sell zones.', icon: '🎯', execute: (p, d) => calcPriceLevels(d) },
  CALC_EXPECTED_MOVE: { desc: 'Calculate volatility-based expected move with σ bands (68%/95%/99%) for 7/14/30 day horizons.', icon: '📐', execute: (p, d) => calcExpectedMove(d) },
  CALC_PROBABILITY_CONE: { desc: 'Calculate forward probability distribution with skewness, kurtosis, and CDF-based price targets.', icon: '🔮', execute: (p, d) => calcProbabilityCone(d) },
  CALC_MONTE_CARLO: { desc: 'Run 500-path Monte Carlo GBM simulation for 30-day price distribution with percentile bands.', icon: '🎲', execute: (p, d) => calcMonteCarlo(d) },
  RESEARCH_SYMBOL:  { desc: 'Research a stock: Yahoo Finance fundamentals + Wikipedia context. Pass a query string.', icon: '🌐', execute: (p, d, s) => researchSymbol(p, d, s) },
  GET_MEMORY:       { desc: 'Retrieve past strategy performance.',   icon: '🧠', execute: (p, d, s) => getMemoryTool(s) },
  GET_BEST_CHAINS:  { desc: 'Get historically best-performing tool chain combos for a ticker.', icon: '🏆', execute: (p, d, s) => getBestChains(s) },
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

/**
 * Parse CREATE_TOOL_CHAIN directive from LLM output text.
 * Format: CREATE_TOOL_CHAIN: ChainName(TOOL1|TOOL2|TOOL3)
 * @param {string} text - LLM output text.
 * @returns {{ name: string, tools: string[] } | null}
 */
export function parseToolChainDirective(text) {
  const match = text.match(/CREATE_TOOL_CHAIN(?:[:：])?\s*([^(\uff08]+)[(\uff08]([^)\uff09]+)[)\uff09]/);
  if (!match) return null;
  const name = match[1].trim().replace(/\*+/g, '').replace(/`/g, '');
  const tools = match[2].split('|').map(t => t.trim().toUpperCase()).filter(Boolean);
  if (!tools.length) return null;
  return { name, tools };
}

export { saveCustomChain };
