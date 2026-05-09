/**
 * memory.js — Agent performance memory (localStorage CRUD).
 * Isolated I/O boundary for agent learning data.
 */

/** Load the full memory object from localStorage. */
export function loadMemory() {
  try {
    return JSON.parse(localStorage.getItem('aql_memory') || '{}');
  } catch {
    return {};
  }
}

/** Save the full memory object to localStorage. */
export function saveMemory(mem) {
  try {
    localStorage.setItem('aql_memory', JSON.stringify(mem));
  } catch (e) {
    console.warn('[MEM] save failed:', e);
  }
}

/**
 * Add a strategy entry to memory for a symbol.
 * Prunes to last 10 entries per ticker.
 * @param {string} symbol - Ticker symbol.
 * @param {object} entry - Memory entry object.
 */
export function addMemoryEntry(symbol, entry) {
  const mem = loadMemory();
  if (!mem[symbol]) mem[symbol] = { entries: [] };
  mem[symbol].entries.push(entry);
  if (mem[symbol].entries.length > 10) {
    mem[symbol].entries = mem[symbol].entries.slice(-10);
  }
  saveMemory(mem);
}

/**
 * Build a context string from past memory for LLM prompt injection.
 * @param {string} symbol - Ticker symbol.
 * @returns {string} Formatted memory context (empty if no history).
 */
export function getMemoryContext(symbol) {
  const mem = loadMemory();
  const entries = mem[symbol]?.entries || [];
  if (!entries.length) return '';

  const scored = entries.filter(e => e.forward_score != null);
  const highPerf = scored.filter(e => e.forward_score >= 0.7);
  const lowPerf = scored.filter(e => e.forward_score < 0.4);
  const recent = entries.slice(-3);

  let ctx = `\n--- PERFORMANCE MEMORY FOR ${symbol} ---\n`;

  if (highPerf.length) {
    ctx += `High performers (score > 0.7):\n`;
    highPerf.slice(-3).forEach(e => {
      ctx += `  "${e.strategy_name}" (${e.forward_score.toFixed(2)}) — ${e.lens || '?'} lens, conf:${e.confidence}\n`;
    });
  }

  if (lowPerf.length) {
    ctx += `Low performers (score < 0.4):\n`;
    lowPerf.slice(-3).forEach(e => {
      ctx += `  "${e.strategy_name}" (${e.forward_score.toFixed(2)}) — ${e.lens || '?'} lens\n`;
    });
  }

  ctx += `Recent strategies:\n`;
  recent.forEach(e => {
    const score = e.forward_score != null ? ' score:' + e.forward_score.toFixed(2) : '';
    ctx += `  [${e.timestamp?.slice(0, 10) || '?'}] ${e.timeframe}: "${e.strategy_name}" (${e.lens || '?'}) conf:${e.confidence}${score}\n`;
  });

  ctx += `Build on HIGH-SCORING strategies. Avoid LOW-SCORING approaches.\n--- END MEMORY ---\n`;
  return ctx;
}
