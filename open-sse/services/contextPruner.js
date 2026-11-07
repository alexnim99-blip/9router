/**
 * Adaptive Context Window Pruning
 *
 * Automatically monitors conversation token length and prunes redundant middle dialogue turns
 * when approaching the model's context window limit, preventing "400 context_length_exceeded" crashes.
 */

// Model context window fallback defaults (in tokens)
const DEFAULT_MODEL_CONTEXT_LIMITS = {
  "claude-3-5-sonnet": 200000,
  "claude-3-opus": 200000,
  "claude-3-haiku": 200000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gemini-1.5-pro": 1000000,
  "gemini-1.5-flash": 1000000,
  "gemini-2.0-flash": 1048576,
  "default": 128000,
};

const DEFAULT_SAFETY_THRESHOLD = 0.85; // Prune when reaching 85% of limit
const MIN_RECENT_TURNS_TO_KEEP = 6; // Keep system + 1st user + last 6 turns

/**
 * Estimates token count for messages array with high speed (~3.8 chars/token)
 */
export function estimateTokenCount(messages = []) {
  if (!Array.isArray(messages)) return 0;
  let charCount = 0;

  for (const m of messages) {
    charCount += 10; // Message envelope/role overhead
    const content = m?.content;
    if (typeof content === "string") {
      charCount += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") charCount += part.length;
        else if (part?.text) charCount += part.text.length;
      }
    }

    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        charCount += String(tc?.function?.name || "").length;
        charCount += String(tc?.function?.arguments || "").length;
      }
    }
  }

  return Math.ceil(charCount / 3.8);
}

/**
 * Resolves context limit for a given model string
 */
export function resolveModelContextLimit(modelStr = "") {
  const lower = String(modelStr || "").toLowerCase();
  for (const [key, limit] of Object.entries(DEFAULT_MODEL_CONTEXT_LIMITS)) {
    if (key !== "default" && lower.includes(key)) {
      return limit;
    }
  }
  return DEFAULT_MODEL_CONTEXT_LIMITS.default;
}

/**
 * Prunes conversation history if it exceeds safety threshold of context window
 *
 * @param {object} body - Chat request body
 * @param {number} [customLimit=null] - Optional override for context limit
 * @param {object} [options={}] - Options like safetyThreshold, minRecentTurns
 * @returns {{ pruned: boolean, body: object, originalTokens: number, prunedTokens: number, savedTokens: number }}
 */
export function pruneContextIfNeeded(body = {}, customLimit = null, options = {}) {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length <= MIN_RECENT_TURNS_TO_KEEP + 2) {
    const tokens = estimateTokenCount(messages);
    return { pruned: false, body, originalTokens: tokens, prunedTokens: tokens, savedTokens: 0 };
  }

  const modelLimit = customLimit || resolveModelContextLimit(body.model);
  const threshold = options.safetyThreshold || (process.env.CONTEXT_PRUNE_THRESHOLD ? parseFloat(process.env.CONTEXT_PRUNE_THRESHOLD) : DEFAULT_SAFETY_THRESHOLD);
  const maxSafeTokens = Math.floor(modelLimit * threshold);

  const initialTokens = estimateTokenCount(messages);
  if (initialTokens <= maxSafeTokens) {
    return { pruned: false, body, originalTokens: initialTokens, prunedTokens: initialTokens, savedTokens: 0 };
  }

  // Partition messages
  const systemMessages = [];
  const nonSystemMessages = [];

  for (const m of messages) {
    if (m?.role === "system") {
      systemMessages.push(m);
    } else {
      nonSystemMessages.push(m);
    }
  }

  // Preserve initial user turn
  const firstUserTurn = nonSystemMessages.length > 0 ? nonSystemMessages[0] : null;

  // Determine recent turns to keep
  const keepRecent = options.minRecentTurns || MIN_RECENT_TURNS_TO_KEEP;
  const recentTurns = nonSystemMessages.slice(-keepRecent);

  // Check how many turns were pruned
  const candidateMiddle = nonSystemMessages.slice(1, -keepRecent);
  if (candidateMiddle.length === 0) {
    return { pruned: false, body, originalTokens: initialTokens, prunedTokens: initialTokens, savedTokens: 0 };
  }

  const prunedNotice = {
    role: "system",
    content: `[Notice from 9Router Gateway: Pruned ${candidateMiddle.length} older dialogue turns to prevent context_length_exceeded error for model "${body.model}". Earliest request and latest ${keepRecent} turns preserved.]`,
  };

  const newMessages = [
    ...systemMessages,
    ...(firstUserTurn && !recentTurns.includes(firstUserTurn) ? [firstUserTurn] : []),
    prunedNotice,
    ...recentTurns,
  ];

  const finalTokens = estimateTokenCount(newMessages);

  return {
    pruned: true,
    body: {
      ...body,
      messages: newMessages,
    },
    originalTokens: initialTokens,
    prunedTokens: finalTokens,
    savedTokens: initialTokens - finalTokens,
  };
}
