/**
 * app.js — Entry point. Event wiring only.
 * No logic, no state management, no rendering.
 * Imports modular pieces and connects them to the DOM.
 */
import { TF_ORDER } from './modules/config.js';
import { state, loadState, clearAllState, deleteTickerState } from './modules/state.js';
import { initBackground } from './modules/background.js';
import {
  $, renderList, updatePills, selectItem, switchTimeframe,
  switchModel, prevStrategy, nextStrategy, updateAgentLogPanel,
  showTimeframe,
} from './modules/ui.js';
import { runAnalysis, generateMore, scoreStrategies } from './modules/engine.js';

// ── file:// protocol guard ──
if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', () => {
    const warn = document.createElement('div');
    warn.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#f85149;color:#fff;padding:12px 20px;font-family:monospace;font-size:13px;text-align:center';
    warn.innerHTML = '⚠ <b>file:// detected</b> — localStorage and network requests are blocked. Run <code style="background:rgba(0,0,0,.3);padding:2px 6px;border-radius:3px">run_pipeline.bat</code> to start a local server, then open <b>http://localhost:3000</b>';
    document.body.prepend(warn);
  });
}

// ── Expose functions for inline HTML onclick handlers ──
window.switchModel = switchModel;
window.switchTimeframe = switchTimeframe;
window.runAnalysis = runAnalysis;
window.generateMore = generateMore;
window.scoreStrategies = scoreStrategies;
window.prevStrategy = prevStrategy;
window.nextStrategy = nextStrategy;

window.clearAll = function clearAll() {
  clearAllState();
  renderList();
  updatePills();
  $('analysis-text').textContent = 'Cleared. Type tickers and press ▶ RUN.';
  updateAgentLogPanel([]);
  $('bar-sym').textContent = '—';
  $('bar-strat').textContent = '';
  $('bar-conf').textContent = '';
  Plotly.purge('plotly-chart');
  document.querySelectorAll('.tf-tab').forEach(b => {
    b.classList.remove('has-data', 'has-error');
  });
};

window.deleteTicker = function(idx, event) {
  event.stopPropagation();
  deleteTickerState(idx);
  renderList();
  updatePills();
  if (state.tickers.length > 0) {
    selectItem(state.activeIdx);
  } else {
    $('analysis-text').textContent = 'Type tickers above and press ▶ RUN to begin.';
    updateAgentLogPanel([]);
    $('bar-sym').textContent = '—';
    $('bar-strat').textContent = '';
    $('bar-conf').textContent = '';
    Plotly.purge('plotly-chart');
    document.querySelectorAll('.tf-tab').forEach(b => {
      b.classList.remove('has-data', 'has-error');
    });
  }
};

// ── Keyboard shortcut ──
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement === $('ticker-input')) {
    runAnalysis();
  }
});

// ── Clock ──
setInterval(() => {
  const e = document.getElementById('clock');
  if (e) e.innerHTML = '<b>' + new Date().toLocaleTimeString() + '</b>';
}, 1000);

// ── Bootstrap ──
document.addEventListener('DOMContentLoaded', () => {
  initBackground();
  loadState();

  // Restore persisted selection
  const savedIdx = parseInt(localStorage.getItem('aql_activeIdx') || '0');
  const savedTF = localStorage.getItem('aql_activeTF') || 'short';
  if (TF_ORDER.includes(savedTF)) state.activeTF = savedTF;

  document.querySelectorAll('.tf-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tf === state.activeTF);
  });

  renderList();
  updatePills();

  if (state.tickers.length) {
    selectItem(Math.min(savedIdx, state.tickers.length - 1));
  }

  // Init model selector display
  switchModel(state.activeModelIdx);

  console.log('[APP] Agentic Quant Lab initialized — modular architecture');
});
