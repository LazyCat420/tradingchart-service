/**
 * json-utils.js — JSON repair and parsing utilities.
 * Pure functions. No I/O, no state, no DOM.
 */

/**
 * Repair common LLM JSON defects (trailing commas, NaN, control chars).
 * @param {string} raw - Raw JSON string from LLM.
 * @returns {string} Cleaned JSON string.
 */
export function repairJSON(raw) {
  let s = raw;
  // 1. Strip trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // 2. Replace bare NaN / Infinity with null
  s = s.replace(/:\s*NaN\b/g, ': null');
  s = s.replace(/:\s*-?Infinity\b/g, ': null');
  // 3. Strip control characters (except \n \r \t)
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  // 4. Fix single-quoted strings (only if no double quotes exist)
  if (s.includes("'") && !s.includes('"')) {
    s = s.replace(/'/g, '"');
  }
  return s;
}

/**
 * Try to close truncated JSON (LLM ran out of tokens).
 * @param {string} s - Partial JSON string.
 * @returns {string} Patched JSON string with balanced braces/brackets.
 */
export function tryCloseTruncated(s) {
  let braces = 0;
  let brackets = 0;
  for (const ch of s) {
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '[') brackets++;
    else if (ch === ']') brackets--;
  }
  // Remove trailing partial key-value pairs
  let patched = s.replace(/,\s*"[^"]*"?\s*:?\s*$/, '');
  patched = patched.replace(/,\s*$/, '');
  while (brackets > 0) { patched += ']'; brackets--; }
  while (braces > 0) { patched += '}'; braces--; }
  return patched;
}

/**
 * Extract the JSON substring from LLM output (strips markdown, think tags, tool calls).
 * @param {string} content - Raw LLM content string.
 * @returns {string} Extracted JSON substring.
 * @throws {Error} If no JSON object is found.
 */
export function extractJSON(content) {
  let c = content.replace(/```json/g, '').replace(/```/g, '').trim();
  // Strip <think> blocks
  if (c.includes('</think>')) {
    c = c.slice(c.indexOf('</think>') + 8).trim();
  }
  if (c.startsWith('<think>')) {
    c = '';
  }
  // Strip residual TOOL_CALL lines (robust)
  c = c.replace(/TOOL_CALL(?:[:：])?\s*\*?\*?\s*`?\w+`?[(\uff08][^)\uff09]*[)\uff09]/g, '').trim();
  // Find JSON boundaries
  const si = c.indexOf('{');
  const ei = c.lastIndexOf('}') + 1;
  if (si === -1 || ei <= si) {
    throw new Error('No JSON object found in response: ' + content.slice(0, 120));
  }
  return c.slice(si, ei);
}

/**
 * 3-step JSON parse: raw → repair → truncation fix.
 * @param {string} jsonStr - JSON string to parse.
 * @param {string} symbol - Ticker symbol for logging.
 * @returns {object} Parsed JSON object.
 * @throws {Error} If all parse attempts fail.
 */
export function safeJSONParse(jsonStr, symbol) {
  // Attempt 1: raw parse
  try {
    return JSON.parse(jsonStr);
  } catch (e1) {
    console.warn(`[${symbol}] Raw JSON.parse failed (${e1.message}), repairing...`);
  }
  // Attempt 2: repair common defects
  const repaired = repairJSON(jsonStr);
  try {
    return JSON.parse(repaired);
  } catch (e2) {
    console.warn(`[${symbol}] Repaired JSON.parse failed (${e2.message}), trying truncation fix...`);
  }
  // Attempt 3: close truncated JSON
  const closed = tryCloseTruncated(repaired);
  try {
    const parsed = JSON.parse(closed);
    console.log(`[${symbol}] Recovered truncated JSON successfully`);
    return parsed;
  } catch (e3) {
    console.error(`[${symbol}] All JSON parse attempts failed. Raw (first 500):`, jsonStr.slice(0, 500));
    throw new Error(`JSON parse failed after repair: ${e3.message}`);
  }
}

/**
 * Parse the full LLM response into { spec, reasoning }.
 * @param {string} content - LLM content string.
 * @param {string} reasoning - LLM reasoning string.
 * @param {string} symbol - Ticker symbol for logging.
 * @returns {{ spec: object, reasoning: string }}
 */
export function parseResponse(content, reasoning, symbol) {
  const jsonStr = extractJSON(content);
  const spec = safeJSONParse(jsonStr, symbol);
  return { spec, reasoning };
}

/**
 * Try to parse incomplete JSON for progressive chart rendering.
 * Returns null on failure (non-throwing).
 * @param {string} content - Partial LLM content string.
 * @returns {object|null} Parsed partial spec or null.
 */
export function tryParsePartial(content) {
  let c = content.replace(/```json/g, '').replace(/```/g, '').trim();
  if (c.includes('</think>')) c = c.slice(c.indexOf('</think>') + 8).trim();
  if (c.startsWith('<think>')) return null;
  c = c.replace(/TOOL_CALL(?:[:：])?\s*\*?\*?\s*`?\w+`?[(\uff08][^)\uff09]*[)\uff09]/g, '').trim();
  const si = c.indexOf('{');
  if (si === -1) return null;
  c = c.slice(si);
  try { return JSON.parse(tryCloseTruncated(c)); } catch { /* ignore */ }
  try { return JSON.parse(tryCloseTruncated(repairJSON(c))); } catch { /* ignore */ }
  return null;
}
