/**
 * api.js — Network I/O boundary.
 * Yahoo Finance data fetching + vLLM streaming.
 * All network calls live here. No DOM manipulation.
 */
import { FETCH_TIMEOUT_MS, LLM_TIMEOUT_MS } from './config.js';
import { getMODEL, getVLLM } from "./state.js";

/**
 * Gets a random API host to bypass the browser's 6-connection HTTP/1.1 limit.
 * Uses Math.random() instead of state to maintain purity.
 * @returns {string} The origin to use for the API call.
 */
function getApiHost() {
	return "";
}

/**
 * Fetch OHLCV stock data from Yahoo Finance with timeout.
 * @param {string} symbol - Ticker symbol.
 * @param {string} range - Time range.
 * @param {string} interval - Candle interval.
 * @returns {Promise<Array>} Array of OHLCV row objects.
 */
export async function fetchData(symbol, range, interval) {
	if (!symbol || !range || !interval)
		throw new Error("Missing required arguments for fetchData");

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
	if (!json.data || json.data.length === 0)
		throw new Error(`Empty dataset for ${symbol}`);

	return json.data;
}

/**
 * Builds the payload for the vLLM API.
 * @param {Array} messages - Chat messages array.
 * @param {string} modelName - The model name to use.
 * @returns {Object} The JSON payload.
 */
function buildLlmPayload(messages, modelName) {
	return {
		model: modelName,
		messages,
		max_tokens: 4000,
		temperature: 0.2,
		stream: true,
	};
}

// ── Smart Concurrency Throttle ──
const LOCAL_CONCURRENCY_LIMIT = 15;
let activeRequests = 0;
const requestQueue = [];
let pumpTimer = null;

let capacityCheckPromise = null;
let lastCapacityResult = true;
let lastCapacityTime = 0;

/**
 * Polls the backend proxy for vLLM metrics.
 * Ensures the GPU KV cache is healthy and no requests are internally queued.
 */
async function getBackendCapacity() {
	const now = Date.now();
	if (now - lastCapacityTime < 2000) return lastCapacityResult;

	if (!capacityCheckPromise) {
		capacityCheckPromise = (async () => {
			try {
				const res = await fetch(`/api/llm/metrics`, {
					headers: { "x-vllm-endpoint": getVLLM() },
					signal: AbortSignal.timeout(2000)
				});
				if (!res.ok) return true; // Fail open if metrics missing
				const text = await res.text();

				const waitingMatch = text.match(/vllm:num_requests_waiting(?:\{.*?\})?\s+([0-9.]+)/);
				const kvMatch = text.match(/vllm:gpu_kv_cache_usage(?:\{.*?\})?\s+([0-9.]+)/);

				const waiting = waitingMatch ? parseFloat(waitingMatch[1]) : 0;
				const kvUsage = kvMatch ? parseFloat(kvMatch[1]) : 0;

				// Block if backend is internally queuing
				return (waiting === 0);
			} catch {
				return true; // Fail open
			} finally {
				lastCapacityTime = Date.now();
				capacityCheckPromise = null;
			}
		})();
	}
	lastCapacityResult = await capacityCheckPromise;
	return lastCapacityResult;
}

let isPumping = false;

async function pumpQueue() {
	if (isPumping) return;
	isPumping = true;

	try {
		if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }

		while (requestQueue.length > 0 && activeRequests < LOCAL_CONCURRENCY_LIMIT) {
			const safe = await getBackendCapacity();
			if (!safe) {
				pumpTimer = setTimeout(pumpQueue, 2000);
				return;
			}

			if (requestQueue.length === 0) break;

			activeRequests++;
			const next = requestQueue.shift();
			if (next) {
				console.log(`[API] 🚀 Dispatching request. Active: ${activeRequests}/${LOCAL_CONCURRENCY_LIMIT}. Queue: ${requestQueue.length}`);
				next();
			}
		}
	} finally {
		isPumping = false;
	}
}

function acquireLock() {
	return new Promise(resolve => {
		requestQueue.push(resolve);
		console.log(`[API] 📥 Queued request. Active: ${activeRequests}/${LOCAL_CONCURRENCY_LIMIT}. Queue: ${requestQueue.length}`);
		pumpQueue();
	});
}

function releaseLock() {
	activeRequests--;
	console.log(`[API] 🏁 Request finished. Active: ${activeRequests}/${LOCAL_CONCURRENCY_LIMIT}. Queue: ${requestQueue.length}`);
	pumpQueue();
}

/**
 * Executes the POST request to the LLM proxy.
 * @param {Object} payload - The request payload.
 * @param {AbortController} ctrl - Abort controller for timeout.
 * @param {string} endpoint - The exact vLLM endpoint to send to.
 * @returns {Promise<Response>}
 */
async function executeLlmRequest(payload, ctrl, endpoint) {
	return await fetch(`${getApiHost()}/api/llm/stream`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-vllm-endpoint": endpoint,
		},
		body: JSON.stringify(payload),
		signal: ctrl.signal,
	});
}

/**
 * Parses the SSE stream from vLLM.
 * @param {ReadableStreamDefaultReader} reader - The stream reader.
 * @param {Function} resetTimeoutCallback - Callback to reset inactivity timer.
 * @param {Function} onChunk - Callback for partial updates.
 * @returns {Promise<{content: string, reasoning: string}>}
 */
async function parseSseStream(reader, resetTimeoutCallback, onChunk) {
	const dec = new TextDecoder();
	let reasoning = "";
	let content = "";
	let buf = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		resetTimeoutCallback();
		buf += dec.decode(value, { stream: true });

		const lines = buf.split("\n");
		buf = lines.pop() || "";

		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			const j = line.slice(6).trim();
			if (j === "[DONE]") {
				try { reader.cancel(); } catch { /* ignore */ }
				return { content, reasoning };
			}
			try {
				const delta = JSON.parse(j).choices?.[0]?.delta || {};
				if (delta.reasoning_content) reasoning += delta.reasoning_content;
				if (delta.content) content += delta.content;

				if ((delta.content || delta.reasoning_content) && onChunk) {
					let stop = false;
					try {
						stop = onChunk({ content, reasoning });
					} catch (chunkErr) {
						console.error("[API] onChunk error:", chunkErr);
					}
					if (stop) {
						// Return early, closing the stream
						try { reader.cancel(); } catch { /* ignore */ }
						return { content, reasoning };
					}
				}
			} catch (e) {
				/* skip malformed SSE lines only if it's a JSON parse error, don't swallow onChunk errors */
				if (e.name !== 'SyntaxError') console.error("[API] SSE loop error:", e);
			}
		}
	}
	return { content, reasoning };
}

/**
 * Stream a single LLM call. Returns accumulated content + reasoning.
 * @param {Array} messages - Chat messages array.
 * @param {function} onChunk - Callback: ({ content, reasoning }) => void
 * @returns {Promise<{ content: string, reasoning: string }>}
 */
export async function singleStreamLLM(messages, onChunk) {
	if (!messages || !Array.isArray(messages))
		throw new Error("Invalid messages array");

	const ctrl = new AbortController();
	let timeout = null;
	const resetInactivityTimeout = () => {
		if (timeout) clearTimeout(timeout);
		timeout = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
	};

	// Snapshot the currently selected model and endpoint 
	// so they cannot drift during the queue wait time.
	const targetModel = getMODEL();
	const targetEndpoint = getVLLM();
	const payload = buildLlmPayload(messages, targetModel);

	await acquireLock();
	resetInactivityTimeout(); // Protect TTFT
	try {
		const res = await executeLlmRequest(payload, ctrl, targetEndpoint);
		resetInactivityTimeout();

		if (!res.ok) {
			let errMsg = `vLLM error: ${res.status}`;
			try {
				const errJson = await res.json();
				if (errJson.error && errJson.error.message) {
					errMsg = errJson.error.message;
				} else if (errJson.error) {
					errMsg = errJson.error;
				}
			} catch { /* ignore */ }
			throw new Error(errMsg);
		}

		return await parseSseStream(
			res.body.getReader(),
			resetInactivityTimeout,
			onChunk,
		);
	} catch (e) {
		if (e.name === "AbortError")
			throw new Error(
				`LLM timeout: Stream inactive for ${LLM_TIMEOUT_MS / 1000}s`,
			);
		throw e;
	} finally {
		if (timeout) clearTimeout(timeout);
		releaseLock();
	}
}
