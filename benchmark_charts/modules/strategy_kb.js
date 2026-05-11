/**
 * strategy_kb.js — Local Strategy Knowledge Base.
 * Curated trading strategies seeded from TradingView/LazyBear, ICT/SMC, and classic TA.
 * Replaces unreliable network lookups (Wikipedia has no articles on these concepts).
 * Each entry maps a concept → definition → tool chain → entry/exit rules.
 */

// ── LazyBear Strategies (Tier 1) ──

const LAZYBEAR_STRATEGIES = [
  {
    id: 'squeeze_momentum_breakout',
    name: 'LazyBear Squeeze Momentum Breakout',
    source: 'TradingView/LazyBear',
    category: 'volatility',
    tags: ['squeeze', 'momentum', 'breakout', 'lazybear', 'bollinger', 'keltner', 'consolidation'],
    description: 'Identifies periods where Bollinger Bands contract inside Keltner Channels (squeeze), indicating energy buildup. When the squeeze fires (bands expand beyond KC), momentum histogram direction determines trade direction. This is one of the most popular indicators on TradingView.',
    toolChain: ['CALC_SQUEEZE_MOMENTUM', 'CALC_BOLLINGER', 'CALC_ATR'],
    rules: {
      entry_long: 'Squeeze ON → OFF transition with positive (green) momentum histogram and rising bars.',
      entry_short: 'Squeeze ON → OFF transition with negative (red) momentum histogram and falling bars.',
      exit: 'Momentum histogram changes color (positive → negative or vice versa), or first declining bar after peak.',
      confirmation: 'Use CALC_RSI to avoid overbought entries. Use CALC_VWAP for institutional bias direction.',
      risk: 'Stop loss below the low of the squeeze consolidation range. Target = 1.5-2x ATR from breakout.',
    },
    combos: ['wavetrend_reversal', 'macd_divergence_confirmation'],
  },
  {
    id: 'wavetrend_reversal',
    name: 'LazyBear WaveTrend Oscillator Reversal',
    source: 'TradingView/LazyBear',
    category: 'momentum',
    tags: ['wavetrend', 'oscillator', 'reversal', 'overbought', 'oversold', 'lazybear', 'crossover'],
    description: 'A momentum oscillator that identifies potential trend reversals by analyzing price position within a volatility-based channel. WT1 (fast) and WT2 (slow) crossovers in extreme zones signal high-probability reversals. Works best when combined with support/resistance or VWAP.',
    toolChain: ['CALC_WAVETREND', 'CALC_RSI', 'CALC_VWAP'],
    rules: {
      entry_long: 'WT1 crosses above WT2 in oversold zone (below -60). Stronger if RSI is also below 30.',
      entry_short: 'WT1 crosses below WT2 in overbought zone (above +60). Stronger if RSI is also above 70.',
      exit: 'WT1 reaches opposite extreme zone, or re-crosses WT2 in neutral territory.',
      confirmation: 'Price should be near VWAP or key Fibonacci level for confluence. Divergence between price and WT adds conviction.',
      risk: 'Stop loss beyond the swing high/low that preceded the crossover signal.',
    },
    combos: ['squeeze_momentum_breakout', 'fibonacci_atr_target'],
  },
  {
    id: 'volume_flow_indicator',
    name: 'LazyBear Volume Flow Indicator (VFI)',
    source: 'TradingView/LazyBear',
    category: 'volume',
    tags: ['volume', 'flow', 'accumulation', 'distribution', 'lazybear', 'vfi', 'institutional'],
    description: 'Measures volume-based buying and selling pressure by analyzing where price closes relative to the typical price and weighting by volume. Positive VFI = accumulation (buying pressure), negative = distribution (selling pressure). Filters out noise to identify when price moves are backed by real volume.',
    toolChain: ['CALC_VFI', 'CALC_VWAP', 'CALC_RSI'],
    rules: {
      entry_long: 'VFI crosses above zero (accumulation begins) while price is above VWAP.',
      entry_short: 'VFI crosses below zero (distribution begins) while price is below VWAP.',
      exit: 'VFI reverses direction or crosses back through zero.',
      confirmation: 'Rising VFI + rising price = confirmed uptrend. Rising price + falling VFI = bearish divergence (distribution).',
      risk: 'VFI divergence from price is a leading warning signal. Tighten stops when VFI diverges.',
    },
    combos: ['wavetrend_reversal', 'squeeze_momentum_breakout'],
  },
  {
    id: 'lazybear_momentum_stack',
    name: 'LazyBear Full Momentum Stack',
    source: 'TradingView/LazyBear (composite)',
    category: 'momentum',
    tags: ['lazybear', 'momentum', 'stack', 'wavetrend', 'squeeze', 'composite', 'multi-indicator'],
    description: 'Combines LazyBear\'s three signature tools: WaveTrend for reversal timing, Squeeze Momentum for breakout detection, and VFI for volume confirmation. All three must align for highest conviction setups.',
    toolChain: ['CALC_WAVETREND', 'CALC_SQUEEZE_MOMENTUM', 'CALC_VFI'],
    rules: {
      entry_long: 'WaveTrend bullish crossover + Squeeze firing with positive momentum + VFI above zero.',
      entry_short: 'WaveTrend bearish crossover + Squeeze firing with negative momentum + VFI below zero.',
      exit: 'Any two of three indicators flip bearish/bullish.',
      confirmation: 'Triple alignment is rare but very high probability. Two-of-three alignment is still tradeable.',
      risk: 'Widest stop of the individual signals. Target = 2-3x ATR.',
    },
    combos: [],
  },
];

// ── ICT / Smart Money Concepts (Tier 2) ──

const ICT_SMC_CONCEPTS = [
  {
    id: 'order_block',
    name: 'ICT Order Block',
    source: 'ICT/Smart Money Concepts',
    category: 'structural',
    tags: ['order block', 'ob', 'institutional', 'supply', 'demand', 'ict', 'smart money', 'smc'],
    description: 'An order block is the last candle of the opposite color before a strong impulsive move. Bullish OB = last bearish candle before a bullish impulse. Bearish OB = last bullish candle before a bearish impulse. These represent zones where institutional orders were placed and price is likely to return to before continuing.',
    toolChain: ['CALC_VWAP', 'CALC_ATR', 'CALC_VFI'],
    rules: {
      entry_long: 'Price retraces into a bullish order block zone (last red candle before impulse up). Enter at the top of the OB candle body.',
      entry_short: 'Price retraces into a bearish order block zone (last green candle before impulse down). Enter at the bottom of the OB candle body.',
      exit: 'Target the opposite liquidity pool (previous swing high/low). Partial take-profit at 1:1 risk/reward.',
      confirmation: 'VWAP alignment (price above VWAP for bullish OB). VFI positive = institutions accumulating.',
      risk: 'Stop loss beyond the wick of the order block candle. Invalidated if price closes through the OB.',
    },
    combos: ['fair_value_gap', 'liquidity_void'],
  },
  {
    id: 'fair_value_gap',
    name: 'ICT Fair Value Gap (FVG)',
    source: 'ICT/Smart Money Concepts',
    category: 'structural',
    tags: ['fair value gap', 'fvg', 'imbalance', 'inefficiency', 'ict', 'smart money'],
    description: 'A Fair Value Gap is a three-candle pattern where the wick of candle 1 and the wick of candle 3 do not overlap, creating a gap/imbalance in price. These gaps represent inefficient price delivery and price tends to return to fill them. Bullish FVG: gap between candle 1 high and candle 3 low. Bearish FVG: gap between candle 1 low and candle 3 high.',
    toolChain: ['CALC_FIBONACCI', 'CALC_ATR'],
    rules: {
      entry_long: 'Price retraces into a bullish FVG zone (between candle 1 high and candle 3 low). Enter at the 50% level of the FVG.',
      entry_short: 'Price retraces into a bearish FVG zone. Enter at the 50% level of the FVG.',
      exit: 'Target the swing high/low that created the impulse. Use Fibonacci extensions for further targets.',
      confirmation: 'FVG at a key Fibonacci level (61.8%, 78.6%) = very high probability. ATR confirms volatility supports the move.',
      risk: 'Stop loss beyond the full FVG range. If FVG is fully filled and price continues through, the setup is invalidated.',
    },
    combos: ['order_block', 'fibonacci_atr_target'],
  },
  {
    id: 'liquidity_void',
    name: 'ICT Liquidity Void',
    source: 'ICT/Smart Money Concepts',
    category: 'structural',
    tags: ['liquidity void', 'void', 'gap', 'liquidity', 'ict', 'smart money', 'thin volume'],
    description: 'A liquidity void is a large price range with very little trading activity — essentially an unfilled gap in the order book. These voids act as magnets for price because the market seeks to establish fair value. Price moves rapidly through voids and tends to retrace to fill them. Visible as tall candle bodies with minimal wicks and no overlapping candles.',
    toolChain: ['CALC_ATR', 'CALC_VWAP', 'CALC_VFI'],
    rules: {
      entry_long: 'After a bearish liquidity void is created, wait for price to retrace and fill the void partially. Enter long at the VWAP of the void zone.',
      entry_short: 'After a bullish liquidity void is created, wait for price to retrace into the void. Enter short at VWAP of void zone.',
      exit: 'Target the origin of the void (where the impulsive move started). Full void fill = full target.',
      confirmation: 'VFI confirms volume is supporting the fill. ATR shows volatility is decreasing (mean reversion).',
      risk: 'Stop loss beyond the extreme of the void. Voids may not fill immediately — patience required.',
    },
    combos: ['order_block', 'fair_value_gap'],
  },
  {
    id: 'breaker_block',
    name: 'ICT Breaker Block',
    source: 'ICT/Smart Money Concepts',
    category: 'structural',
    tags: ['breaker', 'breaker block', 'failed order block', 'ict', 'smart money', 'reversal'],
    description: 'A breaker block is a failed order block — an OB that was broken through (invalidated) and now acts as the opposite zone. When a bullish OB fails and price breaks below it, that OB becomes a bearish breaker (resistance). This represents a shift in institutional positioning and is a powerful reversal signal.',
    toolChain: ['CALC_RSI', 'CALC_VWAP', 'CALC_ATR'],
    rules: {
      entry_long: 'A bearish OB fails (price breaks above it). The broken OB zone now becomes support. Enter on retest.',
      entry_short: 'A bullish OB fails (price breaks below it). The broken OB zone now becomes resistance. Enter on retest.',
      exit: 'Target the next liquidity pool (equal highs/lows, previous swing points).',
      confirmation: 'RSI divergence at the breaker zone confirms momentum shift. VWAP reclaim/rejection adds confluence.',
      risk: 'Stop loss beyond the breaker zone. If price re-breaks through the breaker, the reversal thesis is invalid.',
    },
    combos: ['order_block', 'liquidity_void'],
  },
];

// ── Classic TA Strategies (Tier 3) ──

const CLASSIC_TA_STRATEGIES = [
  {
    id: 'macd_rsi_divergence',
    name: 'MACD + RSI Divergence Confirmation',
    source: 'Classic Technical Analysis',
    category: 'momentum',
    tags: ['macd', 'rsi', 'divergence', 'confirmation', 'momentum', 'reversal'],
    description: 'Uses MACD and RSI together to identify high-probability divergence setups. When price makes a new high/low but both MACD and RSI fail to confirm, a reversal is likely. Double divergence (both indicators) is stronger than single.',
    toolChain: ['CALC_MACD', 'CALC_RSI', 'CALC_MACD_LEADER'],
    rules: {
      entry_long: 'Price makes lower low, but both MACD histogram and RSI make higher lows (bullish divergence).',
      entry_short: 'Price makes higher high, but both MACD histogram and RSI make lower highs (bearish divergence).',
      exit: 'MACD crosses signal line in the opposite direction, or RSI reaches overbought/oversold extreme.',
      confirmation: 'MACD Leader (zero-lag) crossing before standard MACD = early entry signal.',
      risk: 'Stop loss below the divergence swing low/high. Divergence can persist — wait for price structure confirmation.',
    },
    combos: ['wavetrend_reversal', 'bollinger_mean_reversion'],
  },
  {
    id: 'bollinger_mean_reversion',
    name: 'Bollinger Band Mean Reversion',
    source: 'Classic Technical Analysis',
    category: 'mean_reversion',
    tags: ['bollinger', 'mean reversion', 'zscore', 'overextended', 'bands', 'standard deviation'],
    description: 'When price touches or exceeds the outer Bollinger Bands (2σ), it is statistically overextended and likely to revert toward the mean (SMA20). Z-Score quantifies exactly how extreme the deviation is. Works best in range-bound markets.',
    toolChain: ['CALC_BOLLINGER', 'CALC_ZSCORE', 'CALC_SQUEEZE_MOMENTUM'],
    rules: {
      entry_long: 'Price touches lower Bollinger Band + Z-Score below -2.0 + Squeeze is OFF (not consolidating).',
      entry_short: 'Price touches upper Bollinger Band + Z-Score above +2.0 + Squeeze is OFF.',
      exit: 'Price returns to SMA20 (middle band) for conservative exit. Opposite band for aggressive target.',
      confirmation: 'Squeeze Momentum OFF with histogram reversing toward zero = momentum supporting reversion.',
      risk: 'In strong trends, price can "ride the band" — Z-Score > 3.0 without reverting. Use ATR for stop sizing.',
    },
    combos: ['squeeze_momentum_breakout', 'macd_rsi_divergence'],
  },
  {
    id: 'fibonacci_atr_target',
    name: 'Fibonacci Retracement + ATR Target Projection',
    source: 'Classic Technical Analysis',
    category: 'trend',
    tags: ['fibonacci', 'retracement', 'atr', 'target', 'projection', 'trend', 'pullback'],
    description: 'Combines Fibonacci retracement levels to identify pullback entry zones with ATR-based target projections. Enter at key Fib levels (38.2%, 50%, 61.8%) during pullbacks in a trend, then project targets using ATR multiples from the entry.',
    toolChain: ['CALC_FIBONACCI', 'CALC_ATR', 'CALC_MACD'],
    rules: {
      entry_long: 'Uptrend pullback to 50% or 61.8% Fibonacci level. MACD still bullish (histogram positive).',
      entry_short: 'Downtrend rally to 50% or 61.8% Fibonacci level. MACD still bearish.',
      exit: 'Target 1 = entry + 1.5×ATR. Target 2 = entry + 2.5×ATR. Target 3 = Fibonacci extension 161.8%.',
      confirmation: 'Fibonacci level clustering (multiple timeframe Fibs aligning) dramatically increases probability.',
      risk: 'Stop loss below the 78.6% Fibonacci level. If price breaks 100% retrace, the trend is broken.',
    },
    combos: ['fair_value_gap', 'wavetrend_reversal'],
  },
  {
    id: 'vwap_reversion',
    name: 'VWAP Institutional Reversion',
    source: 'Classic Technical Analysis',
    category: 'mean_reversion',
    tags: ['vwap', 'institutional', 'reversion', 'volume', 'weighted', 'intraday'],
    description: 'VWAP represents the true average price institutions paid. Price above VWAP = bullish institutional bias, below = bearish. Extended deviations from VWAP tend to revert. Works especially well on daily timeframes for swing trades.',
    toolChain: ['CALC_VWAP', 'CALC_ZSCORE', 'CALC_BOLLINGER'],
    rules: {
      entry_long: 'Price below VWAP + Z-Score below -1.5 = statistically cheap vs institutional average. Enter long.',
      entry_short: 'Price above VWAP + Z-Score above +1.5 = statistically expensive. Enter short.',
      exit: 'Price returns to VWAP for conservative target. For aggressive, target opposite side of VWAP.',
      confirmation: 'Bollinger Band position aligns with VWAP signal (price at lower BB + below VWAP = double confluence).',
      risk: 'VWAP is recalculated with new data. In strong trends, VWAP will move with price. Best for range-bound conditions.',
    },
    combos: ['bollinger_mean_reversion', 'volume_flow_indicator'],
  },
];

// ── Named Combo Recipes ──

const COMBO_RECIPES = [
  {
    id: 'momentum_trifecta',
    name: 'Momentum Trifecta',
    tools: ['CALC_RSI', 'CALC_MACD', 'CALC_WAVETREND'],
    description: 'Triple momentum confirmation: RSI for extremes, MACD for trend direction, WaveTrend for reversal timing.',
    when: 'Trending market showing potential exhaustion.',
  },
  {
    id: 'volatility_squeeze_play',
    name: 'Volatility Squeeze Play',
    tools: ['CALC_SQUEEZE_MOMENTUM', 'CALC_BOLLINGER', 'CALC_ATR'],
    description: 'Squeeze detection + Bollinger position + ATR for target sizing. The classic LazyBear breakout setup.',
    when: 'Low volatility consolidation, narrowing Bollinger Bands.',
  },
  {
    id: 'mean_reversion_stack',
    name: 'Mean Reversion Stack',
    tools: ['CALC_BOLLINGER', 'CALC_ZSCORE', 'CALC_VWAP'],
    description: 'Statistical overextension from three angles: band position, z-score deviation, and VWAP distance.',
    when: 'Price at extremes in range-bound or choppy markets.',
  },
  {
    id: 'ict_structural_analysis',
    name: 'ICT Structural Analysis',
    tools: ['CALC_VWAP', 'CALC_ATR', 'CALC_VFI'],
    description: 'Institutional order flow analysis: VWAP for institutional bias, ATR for volatility context, VFI for volume confirmation.',
    when: 'Looking for institutional supply/demand zones and order blocks.',
  },
  {
    id: 'trend_momentum_leaders',
    name: 'Trend Momentum Leaders',
    tools: ['CALC_MACD', 'CALC_MACD_LEADER', 'CALC_WAVETREND'],
    description: 'MACD for trend + MACD Leader for early zero-lag signals + WaveTrend for reversal zones. Catches trend shifts early.',
    when: 'Trending market, looking for continuation or early reversal signals.',
  },
  {
    id: 'fibonacci_precision_entry',
    name: 'Fibonacci Precision Entry',
    tools: ['CALC_FIBONACCI', 'CALC_ATR', 'CALC_RSI'],
    description: 'Fibonacci levels for entry zones + ATR for target/stop sizing + RSI for momentum confirmation at Fib levels.',
    when: 'Clear swing high/low established, waiting for pullback entry.',
  },
  {
    id: 'volume_divergence_scan',
    name: 'Volume Divergence Scanner',
    tools: ['CALC_VFI', 'CALC_RSI', 'CALC_MACD'],
    description: 'VFI for volume flow + RSI/MACD for price momentum. Divergence between volume flow and price momentum = warning signal.',
    when: 'Suspecting hidden accumulation or distribution despite price trend.',
  },
  {
    id: 'full_quant_scan',
    name: 'Full Quantitative Scan',
    tools: ['CALC_RSI', 'CALC_BOLLINGER', 'CALC_ZSCORE', 'CALC_ATR', 'CALC_SQUEEZE_MOMENTUM', 'CALC_MACD'],
    description: 'Run every major indicator at once for a comprehensive quantitative snapshot. Use when you want a holistic view before deciding on a specific thesis.',
    when: 'First analysis of an unfamiliar ticker, or when market regime is unclear.',
  },
];

// ── All strategies combined ──
const ALL_STRATEGIES = [...LAZYBEAR_STRATEGIES, ...ICT_SMC_CONCEPTS, ...CLASSIC_TA_STRATEGIES];

// ── Public API ──

/**
 * Fuzzy search the strategy KB by query string.
 * Matches against id, name, tags, and description.
 * @param {string} query - Search query.
 * @returns {string} Formatted strategy info or "not found".
 */
export function lookupStrategy(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return 'Error: empty strategy query';

  // Score each strategy by match quality
  const scored = ALL_STRATEGIES.map(s => {
    let score = 0;
    const qWords = q.split(/\s+/);

    // Exact ID match
    if (s.id === q.replace(/\s+/g, '_')) score += 100;

    // Name match
    if (s.name.toLowerCase().includes(q)) score += 50;

    // Tag match (strongest signal)
    for (const tag of s.tags) {
      if (tag.toLowerCase() === q) { score += 80; break; }
      if (tag.toLowerCase().includes(q) || q.includes(tag.toLowerCase())) score += 30;
    }

    // Word-level matching
    for (const w of qWords) {
      if (w.length < 3) continue;
      if (s.name.toLowerCase().includes(w)) score += 10;
      if (s.description.toLowerCase().includes(w)) score += 5;
      for (const tag of s.tags) {
        if (tag.toLowerCase().includes(w)) score += 15;
      }
    }

    // Category match
    if (s.category === q) score += 20;

    return { strategy: s, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return `Strategy KB: no match for "${query}". Available categories: volatility, momentum, volume, structural, mean_reversion, trend.`;

  // Return top 3 matches
  return scored.slice(0, 3).map((x, i) => {
    const s = x.strategy;
    let out = `[${i + 1}] ${s.name} (${s.source})\n`;
    out += `  ${s.description}\n`;
    out += `  Tool Chain: ${s.toolChain.join(' → ')}\n`;
    out += `  Entry Long: ${s.rules.entry_long}\n`;
    out += `  Entry Short: ${s.rules.entry_short}\n`;
    out += `  Exit: ${s.rules.exit}\n`;
    out += `  Confirmation: ${s.rules.confirmation}\n`;
    out += `  Risk: ${s.rules.risk}`;
    return out;
  }).join('\n\n');
}

/**
 * Suggest strategy recipes based on market condition description.
 * @param {string} condition - Brief market condition (e.g., "high volatility consolidating")
 * @returns {string} Top matching recipes with tool chains.
 */
export function suggestStrategy(condition) {
  const q = (condition || '').toLowerCase().trim();
  if (!q) return 'Error: describe the market condition (e.g., "high volatility consolidating near support")';

  const qWords = q.split(/\s+/);

  // Score recipes
  const scored = COMBO_RECIPES.map(r => {
    let score = 0;
    for (const w of qWords) {
      if (w.length < 3) continue;
      if (r.description.toLowerCase().includes(w)) score += 10;
      if (r.when.toLowerCase().includes(w)) score += 15;
      if (r.name.toLowerCase().includes(w)) score += 5;
    }
    return { recipe: r, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

  // Also score full strategies
  const stratScored = ALL_STRATEGIES.map(s => {
    let score = 0;
    for (const w of qWords) {
      if (w.length < 3) continue;
      if (s.description.toLowerCase().includes(w)) score += 5;
      for (const tag of s.tags) {
        if (tag.includes(w)) score += 10;
      }
    }
    return { strategy: s, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

  let out = `Strategy Suggestions for "${condition}":\n\n`;

  if (scored.length) {
    out += '— COMBO RECIPES —\n';
    scored.slice(0, 3).forEach((x, i) => {
      out += `${i + 1}. ${x.recipe.name}: [${x.recipe.tools.join(', ')}]\n`;
      out += `   ${x.recipe.description}\n`;
      out += `   Best when: ${x.recipe.when}\n`;
    });
  }

  if (stratScored.length) {
    out += '\n— MATCHING STRATEGIES —\n';
    stratScored.slice(0, 2).forEach((x, i) => {
      out += `${i + 1}. ${x.strategy.name}: [${x.strategy.toolChain.join(' → ')}]\n`;
      out += `   ${x.strategy.rules.entry_long}\n`;
    });
  }

  if (!scored.length && !stratScored.length) {
    out += 'No specific match. Try: "trending", "consolidating", "volatile", "reversal", "oversold", "breakout".';
  }

  return out;
}

/**
 * Get all available strategy IDs for the LLM to browse.
 * @returns {string} List of all strategies.
 */
export function listStrategies() {
  let out = 'Available Strategies:\n\n';
  out += '— LAZYBEAR (TradingView) —\n';
  LAZYBEAR_STRATEGIES.forEach(s => { out += `  • ${s.id}: ${s.name}\n`; });
  out += '\n— ICT / SMART MONEY —\n';
  ICT_SMC_CONCEPTS.forEach(s => { out += `  • ${s.id}: ${s.name}\n`; });
  out += '\n— CLASSIC TA —\n';
  CLASSIC_TA_STRATEGIES.forEach(s => { out += `  • ${s.id}: ${s.name}\n`; });
  out += '\n— COMBO RECIPES —\n';
  COMBO_RECIPES.forEach(r => { out += `  • ${r.id}: ${r.name} [${r.tools.join(', ')}]\n`; });
  return out;
}

export { ALL_STRATEGIES, COMBO_RECIPES };
