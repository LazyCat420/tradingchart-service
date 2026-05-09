/**
 * state.js — Centralized application state + localStorage persistence.
 * Single source of truth. No scattered globals.
 */
import { TF_ORDER, MODELS } from './config.js';

// ── The single state object (replaces all scattered globals) ──
export const state = {
  tickers: [],
  activeIdx: -1,
  activeTF: 'short',
  runningCount: 0,
  activeStratIdx: 0,
  userLockedTF: false,
  activeModelIdx: parseInt(localStorage.getItem('aql_model_idx') || '0'),
};

// Clamp model index
if (state.activeModelIdx >= MODELS.length) state.activeModelIdx = 0;

// ── Model accessors ──
export function getVLLM() { return MODELS[state.activeModelIdx].endpoint; }
export function getMODEL() { return MODELS[state.activeModelIdx].model; }

// ── Ticker factory ──
export function createTicker(symbol) {
  const t = { symbol, status: 'pending', error: '' };
  initTickerTF(t);
  return t;
}

/** Initialize all timeframe slots on a ticker object. */
export function initTickerTF(t) {
  if (!t.tf) t.tf = {};
  TF_ORDER.forEach(tf => {
    if (!t.tf[tf]) {
      t.tf[tf] = {
        status: 'pending', data: null, spec: null,
        analysis: '', reasoning: '',
        strategy_name: '', confidence: 0, iterations: 0,
        prevSpecs: [], liveContent: '', liveReasoning: '',
        toolLog: [],
      };
    }
  });
}

// ── Persistence: save/load ──

/** Persist ticker metadata to localStorage. */
export function saveState() {
  try {
    const meta = state.tickers.map(t => {
      const tfData = {};
      TF_ORDER.forEach(tf => {
        const d = t.tf?.[tf];
        if (!d) return;
        tfData[tf] = {
          status: d.status || 'pending',
          analysis: d.analysis || '',
          reasoning: d.reasoning || '',
          strategy_name: d.strategy_name || '',
          confidence: d.confidence || 0,
          iterations: d.iterations || 0,
          spec: d.spec || null,
          prevSpecs: d.prevSpecs || [],
        };
      });
      return { symbol: t.symbol, status: t.status, error: t.error || '', tf: tfData };
    });
    localStorage.setItem('aql_tickers', JSON.stringify(meta));
    localStorage.setItem('aql_activeIdx', String(state.activeIdx));
    localStorage.setItem('aql_activeTF', state.activeTF);
    console.log('[SAVE] Saved', meta.length, 'tickers');
  } catch (e) {
    console.warn('[SAVE] meta write failed:', e);
  }
}

/** Persist OHLCV chart data for one ticker/timeframe. */
export function saveTickerData(symbol, tf, data) {
  try {
    localStorage.setItem(`aql_data_${symbol}_${tf}`, JSON.stringify(data));
    console.log('[SAVE] Saved chart data for', symbol, tf, '(' + data.length + ' rows)');
  } catch (e) {
    console.warn('[SAVE] data write failed for', symbol, tf, e);
  }
}

/** Load OHLCV chart data for one ticker/timeframe. */
export function loadTickerData(symbol, tf) {
  try {
    const s = localStorage.getItem(`aql_data_${symbol}_${tf}`);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

/** Restore full state from localStorage on startup. */
export function loadState() {
  try {
    const s = localStorage.getItem('aql_tickers');
    if (!s) return;

    state.tickers = JSON.parse(s);
    state.tickers.forEach(t => {
      // Migrate old single-timeframe format
      if (!t.tf && t.spec) {
        t.tf = {
          short: {
            status: 'success', spec: t.spec, analysis: t.analysis || '',
            reasoning: t.reasoning || '', strategy_name: t.strategy_name || '',
            confidence: t.confidence || 0, iterations: t.iterations || 0,
            prevSpecs: t.prevSpecs || [],
          },
        };
        delete t.spec; delete t.analysis; delete t.reasoning;
        delete t.strategy_name; delete t.confidence;
        delete t.iterations; delete t.prevSpecs;
      }
      initTickerTF(t);
      // Restore chart data per timeframe
      TF_ORDER.forEach(tf => {
        t.tf[tf].data = loadTickerData(t.symbol, tf);
        // Legacy key migration
        if (!t.tf[tf].data && tf === 'short') {
          try {
            const x = localStorage.getItem('aql_data_' + t.symbol);
            t.tf[tf].data = x ? JSON.parse(x) : null;
          } catch { /* ignore */ }
        }
        // Reset stuck running states from prior sessions
        if (t.tf[tf].status === 'running') t.tf[tf].status = 'pending';
      });
      if (t.status === 'running') t.status = 'pending';
    });
    console.log('[LOAD] Restored', state.tickers.length, 'tickers');
  } catch (e) {
    console.warn('[LOAD] failed:', e);
  }
}

/** Purge all persisted state. */
export function clearAllState() {
  state.tickers.forEach(t => {
    TF_ORDER.forEach(tf => {
      try { localStorage.removeItem(`aql_data_${t.symbol}_${tf}`); } catch { /* ignore */ }
    });
    try { localStorage.removeItem('aql_data_' + t.symbol); } catch { /* ignore */ }
  });
  localStorage.removeItem('aql_tickers');
  localStorage.removeItem('aql_memory');
  localStorage.removeItem('aql_activeIdx');
  localStorage.removeItem('aql_activeTF');
  state.tickers = [];
  state.activeIdx = -1;
  state.activeTF = 'short';
  state.activeStratIdx = 0;
  console.log('[CLEAR] All state purged');
}

/** Check if a given ticker/timeframe is currently being viewed. */
export function isCurrentView(tickerIdx, tfKey) {
  return state.activeIdx === tickerIdx && state.activeTF === tfKey;
}

/** Delete a single ticker. */
export function deleteTickerState(idx) {
  if (idx < 0 || idx >= state.tickers.length) return;
  const t = state.tickers[idx];
  TF_ORDER.forEach(tf => {
    try { localStorage.removeItem(`aql_data_${t.symbol}_${tf}`); } catch { /* ignore */ }
  });
  try { localStorage.removeItem('aql_data_' + t.symbol); } catch { /* ignore */ }
  state.tickers.splice(idx, 1);
  if (state.activeIdx >= state.tickers.length) state.activeIdx = Math.max(0, state.tickers.length - 1);
  saveState();
}
