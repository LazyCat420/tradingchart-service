/**
 * chart.js — Plotly chart rendering.
 * Pure rendering functions. No state mutation, no network I/O.
 */

/** Calculate Exponential Moving Average. */
export function calcEMA(closes, span) {
  const k = 2 / (span + 1);
  const ema = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

/**
 * Build Plotly shape objects from overlay specs.
 * @param {Array} overlays - Array of overlay objects from LLM spec.
 * @returns {{ shapes: Array, annotations: Array }}
 */
function buildOverlayShapes(overlays) {
  const shapes = [];
  const annotations = [];

  for (const ov of overlays) {
    if (ov.kind === 'line') {
      shapes.push({
        type: 'line', x0: ov.x0, y0: ov.y0, x1: ov.x1, y1: ov.y1,
        line: { color: ov.color || '#fff', width: 2, dash: 'dashdot' },
        xref: 'x', yref: 'y',
      });
      annotations.push({
        x: ov.x1, y: ov.y1, text: ov.label || '', showarrow: false,
        font: { color: ov.color || '#fff', size: 10 }, yshift: 12,
        xref: 'x', yref: 'y',
      });
    } else if (ov.kind === 'zone' || ov.kind === 'volume_void') {
      const isVoid = ov.kind === 'volume_void';
      shapes.push({
        type: 'rect', x0: ov.x0, y0: ov.y0, x1: ov.x1, y1: ov.y1,
        fillcolor: ov.color || (isVoid ? 'purple' : 'blue'),
        opacity: isVoid ? 0.25 : 0.15,
        line: { color: ov.color || '#fff', width: isVoid ? 1 : 0, dash: isVoid ? 'dot' : 'solid' },
        xref: 'x', yref: 'y',
      });
      annotations.push({
        x: ov.x0, y: ov.y1, text: ov.label || '', showarrow: false,
        font: { color: ov.color || '#fff', size: 9 }, yshift: 10,
        xref: 'x', yref: 'y',
      });
    }
  }
  return { shapes, annotations };
}

/**
 * Render a full candlestick chart with overlays into the Plotly container.
 * @param {Array} data - OHLCV data array.
 * @param {object} spec - LLM analysis spec (overlays, strategy_name, etc.).
 * @param {string} symbol - Ticker symbol.
 * @param {string} tfLabel - Timeframe label (e.g. "3M Daily").
 */
export function renderChart(data, spec, symbol, tfLabel) {
  if (!data || !data.length) return;

  const dates = data.map(d => d.date);
  const closes = data.map(d => d.close);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const volumeColors = data.map(d => d.close >= d.open ? '#34d399' : '#f87171');

  const traces = [
    {
      type: 'candlestick', x: dates,
      open: data.map(d => d.open), high: data.map(d => d.high),
      low: data.map(d => d.low), close: closes,
      increasing: { line: { color: '#34d399' } },
      decreasing: { line: { color: '#f87171' } },
      name: 'Price', yaxis: 'y',
    },
    { type: 'scatter', x: dates, y: ema20, line: { color: '#fbbf24', width: 1.5 }, name: 'EMA 20', yaxis: 'y' },
    { type: 'scatter', x: dates, y: ema50, line: { color: '#a78bfa', width: 1.5 }, name: 'EMA 50', yaxis: 'y' },
    { type: 'bar', x: dates, y: data.map(d => d.volume), marker: { color: volumeColors }, name: 'Volume', yaxis: 'y2', opacity: 0.6 },
  ];

  const { shapes, annotations } = buildOverlayShapes(spec.overlays || []);

  // Build title parts
  const titleParts = [symbol];
  if (tfLabel) titleParts.push(tfLabel);
  const sName = spec.strategy_name || '';
  if (sName) titleParts.push(sName);
  const conf = spec.confidence ? (spec.confidence * 100).toFixed(0) + '%' : '';
  if (conf) titleParts.push(conf);

  Plotly.react('plotly-chart', traces, {
    title: { text: titleParts.join(' · '), font: { color: '#e2e8f0', size: 14 } },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(6,10,18,0.6)',
    font: { family: 'JetBrains Mono,monospace', color: '#8b949e', size: 10 },
    xaxis: { gridcolor: 'rgba(56,68,100,0.3)', rangeslider: { visible: false }, tickfont: { size: 9 } },
    yaxis: { gridcolor: 'rgba(56,68,100,0.3)', side: 'right', tickfont: { size: 9 }, domain: [0.22, 1] },
    yaxis2: { gridcolor: 'rgba(56,68,100,0.2)', side: 'right', tickfont: { size: 8 }, domain: [0, 0.18], showgrid: false },
    shapes,
    annotations,
    margin: { l: 10, r: 60, t: 40, b: 30 },
    legend: { x: 0, y: 1.02, orientation: 'h', font: { size: 9 } },
    showlegend: true,
  }, { responsive: true, displayModeBar: false });
}

/**
 * Render an empty placeholder chart for a timeframe with no data yet.
 * @param {string} symbol - Ticker symbol.
 * @param {string} tfLabel - Timeframe label.
 */
export function renderEmptyChart(symbol, tfLabel) {
  Plotly.react('plotly-chart', [], {
    title: { text: `${symbol} · ${tfLabel} · awaiting data...`, font: { color: '#8b949e', size: 14 } },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(6,10,18,0.6)',
    font: { family: 'JetBrains Mono,monospace', color: '#8b949e', size: 10 },
    xaxis: { visible: false },
    yaxis: { visible: false },
    annotations: [{
      text: `${tfLabel} data will load when this timeframe is processed`,
      xref: 'paper', yref: 'paper', x: 0.5, y: 0.5,
      showarrow: false, font: { size: 13, color: '#58a6ff' },
    }],
    margin: { l: 10, r: 60, t: 40, b: 30 },
  }, { responsive: true, displayModeBar: false });
}
