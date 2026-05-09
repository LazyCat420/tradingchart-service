/**
 * app.js — Entry point. Event wiring only.
 * No logic, no state management, no rendering.
 * Imports modular pieces and connects them to the DOM.
 */
import { TF_ORDER, MODELS, MODEL_PROBE_INTERVAL_MS } from './modules/config.js';
import { state, loadState, clearAllState, deleteTickerState } from './modules/state.js';
import { initBackground } from './modules/background.js';
import {
  $, renderList, updatePills, selectItem, switchTimeframe,
  switchModel, prevStrategy, nextStrategy, updateAgentLogPanel,
  showTimeframe,
} from './modules/ui.js';
import { runAnalysis, generateSpecific, generateAll, scoreStrategies } from './modules/engine.js';

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
window.generateSpecific = generateSpecific;
window.generateAll = generateAll;
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

// ── Model Health Probing ──

/**
 * Probe a single model entry. 2-step check:
 *   1. GET /health — is vLLM ready to serve?
 *   2. GET /v1/models — what model is loaded?
 * Mutates the model entry in-place (name, model, ready).
 */
async function probeModel(m) {
  const ip = m.id; // '141' or '30'

  // Step 1: Health check via proxy
  let healthy = false;
  let status = 200;
  try {
    const healthRes = await fetch('/api/llm/health', {
      headers: { 'x-vllm-endpoint': m.endpoint },
      signal: AbortSignal.timeout(5000),
      cache: 'no-store'
    });
    status = healthRes.status;
    healthy = healthRes.ok; // 200 = ready, 503 = loading
  } catch (e) {
    status = 0;
  }

  if (status === 502 || status === 0) {
    m.name = `Offline (${ip})`;
    m.model = '';
    m.ready = false;
    console.log(`[PROBE] ${ip}: offline`);
    return;
  }

  if (!healthy) {
    m.name = `Loading... (${ip})`;
    m.model = '';
    m.ready = false;
    console.log(`[PROBE] ${ip}: server up but model loading`);
    return;
  }

  // Step 2: Fetch model name (only if healthy) via proxy
  try {
    const modelsRes = await fetch('/api/llm/models', {
      headers: { 'x-vllm-endpoint': m.endpoint },
      signal: AbortSignal.timeout(5000),
      cache: 'no-store'
    });
    const data = await modelsRes.json();
    if (data && data.data && data.data.length > 0) {
      m.model = data.data[0].id;
      const shortName = m.model.split('/').pop()
        .replace('.w4a16', '')
        .replace('-FP8', '')
        .replace('quantized.', '')
        .replace('-quantized', ''); // Added extra cleanup just in case
      m.name = `${shortName} (${ip})`;
      m.ready = true;
      console.log(`[PROBE] ${ip}: ready — ${m.model}`);
    } else {
      m.name = `No Model (${ip})`;
      m.model = '';
      m.ready = false;
      console.log(`[PROBE] ${ip}: healthy but no models listed`);
    }
  } catch (e) {
    m.name = `Error (${ip})`;
    m.model = '';
    m.ready = false;
    console.warn(`[PROBE] ${ip}: models fetch failed`, e);
  }
}

/**
 * Probe all models and update the UI.
 */
async function probeAllModels() {
  await Promise.all(MODELS.map(probeModel));
  updateModelDropdown();
  switchModel(state.activeModelIdx);
}

/**
 * Rebuild the dropdown menu items to reflect current model names + readiness.
 */
function updateModelDropdown() {
  const dropdown = document.getElementById('model-dropdown');
  if (!dropdown) return;
  dropdown.innerHTML = MODELS.map((m, i) => {
    const cls = i === state.activeModelIdx ? 'model-opt active' : 'model-opt';
    const readyDot = m.ready ? '🟢' : '🔴';
    return `<div class="${cls}" onclick="switchModel(${i}); document.getElementById('model-dropdown').classList.remove('open')">${readyDot} ${m.name}</div>`;
  }).join('');
}

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

  // Initial probe + render with whatever we know
  switchModel(state.activeModelIdx);
  probeAllModels();

  // Poll every 10s to keep model status accurate
  setInterval(probeAllModels, MODEL_PROBE_INTERVAL_MS);

  console.log('[APP] Agentic Quant Lab initialized — modular architecture');
});
