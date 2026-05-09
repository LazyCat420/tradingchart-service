/**
 * api.js — Network I/O boundary.
 * Yahoo Finance data fetching + vLLM streaming.
 * All network calls live here. No DOM manipulation.
 */
import { CORS_PROXY, FETCH_TIMEOUT_MS, LLM_TIMEOUT_MS } from './config.js';
import { getVLLM, getMODEL } from './state.js';

/**
 * Fetch OHLCV stock data from Yahoo Finance with timeout.
 * BUG FIX: Original had NO timeout — could hang forever, permanently
 * corrupting runningCount and leaving tickers stuck as "pending".
 *
 * @param {string} symbol - Ticker symbol (e.g. "NBIS").
 * @param {string} range - Time range (e.g. "3mo", "1y", "5y").
 * @param {string} interval - Candle interval (e.g. "1d", "1wk", "1mo").
 * @returns {Promise<Array>} Array of OHLCV row objects.
 * @throws {Error} On network failure, timeout, or empty data.
 */

// Domain sharding to bypass the browser's 6-connection HTTP/1.1 limit
let shardIdx = 0;
function getApiHost() {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (!isLocal) return '';
  const port = window.location.port ? ':' + window.location.port : '';
  const origins = [
    `http://localhost${port}`,
    `http://127.0.0.1${port}`
  ];
  const origin = origins[shardIdx];
  shardIdx = (shardIdx + 1) % origins.length;
  return origin;
}

export async function fetchData(symbol, range, interval) {
  const url = `${getApiHost()}/api/data?symbol=${symbol}&period=${range}&interval=${interval}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`Data proxy error: ${res.status}`);

  const json = await res.json();
  if (json.error) throw new Error(json.error);
  
  const data = json.data;
  if (!data || data.length === 0) throw new Error(`Empty dataset for ${symbol} (${range}/${interval})`);

  console.log(`[API] Fetched ${data.length} rows for ${symbol} (${range}/${interval})`);
  return data;
}

/**
 * Stream a single LLM call. Returns accumulated content + reasoning.
 * Accepts an onChunk callback for progressive UI updates (no DOM coupling).
 *
 * @param {Array} messages - Chat messages array.
 * @param {function} onChunk - Callback: ({ content, reasoning }) => void
 * @returns {Promise<{ content: string, reasoning: string }>}
 */
export async function singleStreamLLM(messages, onChunk) {
  const payload = {
    model: getMODEL(),
    messages,
    max_tokens: 4000,
    temperature: 0.2,
    stream: true,
  };

  const ctrl = new AbortController();
  
  // We only start the timeout AFTER the connection is established to avoid penalizing
  // requests that are queued by the browser's HTTP/1.1 max-concurrent-connections limit (6).
  let timeout = null;
  const resetInactivityTimeout = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  };

  const reqId = Math.random().toString(36).substring(2, 6).toUpperCase();
  console.log(`⏳ [LLM ${reqId}] Request initialized. If > 6 active, browser will queue this...`);

  let res;
  try {
    res = await fetch(`${getApiHost()}/api/llm/stream`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-vllm-endpoint': getVLLM()
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    console.log(`⚡ [LLM ${reqId}] Connection established! Starting 120s inactivity timer.`);
    resetInactivityTimeout();
  } catch (e) {
    if (timeout) clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error(`LLM timeout: Stream inactive for ${LLM_TIMEOUT_MS / 1000}s`);
    throw e;
  }

  if (!res.ok) {
    if (timeout) clearTimeout(timeout);
    throw new Error(`vLLM error: ${res.status} ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let reasoning = '';
  let content = '';
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      resetInactivityTimeout(); // Reset timer on every incoming chunk!
      
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const j = line.slice(6).trim();
        if (j === '[DONE]') continue;
        try {
          const delta = JSON.parse(j).choices?.[0]?.delta || {};
          if (delta.reasoning_content) reasoning += delta.reasoning_content;
          if (delta.content) {
            content += delta.content;
            if (onChunk) onChunk({ content, reasoning });
          }
        } catch { /* skip malformed SSE lines */ }
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    console.log(`✅ [LLM ${reqId}] Stream fully completed.`);
  }

  return { content, reasoning };
}
