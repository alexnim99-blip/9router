/**
 * Token Budget & Runaway Agent Guard
 *
 * Protects user accounts from accidental quota exhaustion, runaway infinite loops in autonomous
 * coding agents (Cline, Cursor Agent, Roo-Code, AutoGPT), and enforces sliding-window RPM/TPM limits.
 */

const WINDOW_MS = 60 * 1000; // 1-minute sliding window
const DAY_MS = 24 * 60 * 60 * 1000; // 24-hour daily budget window

// Default thresholds (can be overridden via env vars or per-key settings)
const DEFAULT_RPM = 120; // 120 requests/minute
const DEFAULT_TPM = 1000000; // 1,000,000 tokens/minute
const DEFAULT_DAILY_TOKENS = 10000000; // 10M tokens/day (0 to disable)
const RUNAWAY_THRESHOLD = 8; // >= 8 near-identical requests within 10s indicates runaway loop

// In-memory sliding window trackers per identifier
const clientWindows = new Map();
const dailyTokenTrackers = new Map();
const recentPromptSignatures = new Map();

/**
 * Returns configuration values
 */
function getConfig() {
  const enabled = process.env.RUNAWAY_GUARD_ENABLED !== "false" && process.env.RUNAWAY_GUARD_ENABLED !== "0";
  const maxRpm = process.env.RATE_LIMIT_RPM != null ? parseInt(process.env.RATE_LIMIT_RPM, 10) : DEFAULT_RPM;
  const maxTpm = process.env.RATE_LIMIT_TPM != null ? parseInt(process.env.RATE_LIMIT_TPM, 10) : DEFAULT_TPM;
  const maxDailyTokens = process.env.MAX_DAILY_TOKENS_PER_KEY != null ? parseInt(process.env.MAX_DAILY_TOKENS_PER_KEY, 10) : DEFAULT_DAILY_TOKENS;

  return { enabled, maxRpm, maxTpm, maxDailyTokens };
}

/**
 * Generates lightweight signature for runaway loop detection
 */
function getPromptSignature(payload = {}) {
  const model = payload.model || "";
  const msgCount = Array.isArray(payload.messages) ? payload.messages.length : 0;
  const lastContent = msgCount > 0 ? String(payload.messages[msgCount - 1]?.content || "").slice(0, 100) : "";
  return `${model}:${msgCount}:${lastContent.length}:${lastContent.slice(0, 30)}`;
}

/**
 * Cleans up timestamps older than window
 */
function pruneWindow(entries, cutoffTime) {
  return entries.filter((e) => e.time >= cutoffTime);
}

/**
 * Checks rate limits, daily budget, and runaway agent loop patterns
 *
 * @param {string} identifier - API Key, IP, or Session ID
 * @param {number} estimatedTokens - Estimated prompt tokens for this request
 * @param {object} [payload={}] - Request body payload
 * @returns {{ allowed: boolean, reason?: string, status?: number, retryAfterSec?: number }}
 */
export function checkRateLimitAndBudget(identifier = "anonymous", estimatedTokens = 100, payload = {}) {
  const cfg = getConfig();
  if (!cfg.enabled) {
    return { allowed: true };
  }

  const now = Date.now();
  const cutoff1Min = now - WINDOW_MS;
  const cutoff24Hr = now - DAY_MS;

  // 1. Check Runaway Agent Loop (autonomous agent caught in retry loop)
  const signature = getPromptSignature(payload);
  let sigHistory = recentPromptSignatures.get(identifier) || [];
  sigHistory = pruneWindow(sigHistory, now - 10000); // 10-second window for rapid repeats

  const identicalCount = sigHistory.filter((s) => s.signature === signature).length;
  if (identicalCount >= RUNAWAY_THRESHOLD) {
    return {
      allowed: false,
      status: 429,
      reason: `Runaway agent loop detected for client "${identifier}". Repeated ${identicalCount} identical requests within 10s. Throttled for safety.`,
      retryAfterSec: 15,
    };
  }

  sigHistory.push({ time: now, signature });
  recentPromptSignatures.set(identifier, sigHistory);

  // 2. Sliding window RPM & TPM
  let windowEntries = clientWindows.get(identifier) || [];
  windowEntries = pruneWindow(windowEntries, cutoff1Min);

  const currentRequests = windowEntries.length;
  const currentTokens = windowEntries.reduce((sum, e) => sum + (e.tokens || 0), 0);

  if (cfg.maxRpm > 0 && currentRequests >= cfg.maxRpm) {
    return {
      allowed: false,
      status: 429,
      reason: `Rate limit exceeded: ${currentRequests}/${cfg.maxRpm} RPM for client "${identifier}".`,
      retryAfterSec: Math.ceil((windowEntries[0].time + WINDOW_MS - now) / 1000) || 1,
    };
  }

  if (cfg.maxTpm > 0 && currentTokens + estimatedTokens > cfg.maxTpm) {
    return {
      allowed: false,
      status: 429,
      reason: `Token limit exceeded: ${currentTokens + estimatedTokens}/${cfg.maxTpm} TPM for client "${identifier}".`,
      retryAfterSec: Math.ceil((windowEntries[0].time + WINDOW_MS - now) / 1000) || 5,
    };
  }

  // 3. Daily Token Budget Cap
  if (cfg.maxDailyTokens > 0) {
    let dailyEntries = dailyTokenTrackers.get(identifier) || [];
    dailyEntries = pruneWindow(dailyEntries, cutoff24Hr);

    const dailyTokensUsed = dailyEntries.reduce((sum, e) => sum + (e.tokens || 0), 0);
    if (dailyTokensUsed + estimatedTokens > cfg.maxDailyTokens) {
      return {
        allowed: false,
        status: 429,
        reason: `Daily token budget cap reached: ${dailyTokensUsed}/${cfg.maxDailyTokens} tokens in last 24h.`,
        retryAfterSec: 60,
      };
    }
  }

  // Record optimistic tentative request in sliding window
  windowEntries.push({ time: now, tokens: estimatedTokens });
  clientWindows.set(identifier, windowEntries);

  return { allowed: true };
}

/**
 * Records actual token usage after completion
 */
export function recordTokenUsage(identifier = "anonymous", actualTokens = 0) {
  if (!actualTokens || actualTokens <= 0) return;

  const now = Date.now();
  let dailyEntries = dailyTokenTrackers.get(identifier) || [];
  dailyEntries = pruneWindow(dailyEntries, now - DAY_MS);
  dailyEntries.push({ time: now, tokens: actualTokens });
  dailyTokenTrackers.set(identifier, dailyEntries);
}

/**
 * Returns tracking metrics for an identifier
 */
export function getBudgetStats(identifier = "anonymous") {
  const now = Date.now();
  const windowEntries = pruneWindow(clientWindows.get(identifier) || [], now - WINDOW_MS);
  const dailyEntries = pruneWindow(dailyTokenTrackers.get(identifier) || [], now - DAY_MS);

  return {
    requestsInLastMinute: windowEntries.length,
    tokensInLastMinute: windowEntries.reduce((sum, e) => sum + (e.tokens || 0), 0),
    tokensInLast24Hours: dailyEntries.reduce((sum, e) => sum + (e.tokens || 0), 0),
  };
}

/**
 * Resets tracking state (primarily for tests)
 */
export function resetBudgetTracking(identifier = null) {
  if (identifier) {
    clientWindows.delete(identifier);
    dailyTokenTrackers.delete(identifier);
    recentPromptSignatures.delete(identifier);
  } else {
    clientWindows.clear();
    dailyTokenTrackers.clear();
    recentPromptSignatures.clear();
  }
}
