import { createHash } from "node:crypto";

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_CACHE_SIZE = 1000;

// Storage backend mode: "hybrid" (default), "memory", or "sqlite"
let currentStorageMode = process.env.RESPONSE_CACHE_STORAGE || "hybrid";

// In-Memory LRU Cache
const cacheMap = new Map();

// Dynamic SQLite repo reference
let sqliteRepo = null;
let sqliteInitAttempted = false;

const stats = {
  hits: 0,
  misses: 0,
  evictions: 0,
  l1Hits: 0,
  l2Hits: 0,
};

/**
 * Configure cache storage backend or inject repo (useful for testing)
 */
export function setCacheStorageBackend(mode, customRepo = null) {
  if (["hybrid", "memory", "sqlite"].includes(mode)) {
    currentStorageMode = mode;
  }
  if (customRepo) {
    sqliteRepo = customRepo;
    sqliteInitAttempted = true;
  }
}

/**
 * Lazy loads the SQLite response cache repository
 */
async function getSqliteRepo() {
  if (sqliteRepo) return sqliteRepo;
  if (sqliteInitAttempted) return null;
  sqliteInitAttempted = true;

  try {
    const repo = await import("../../src/lib/db/repos/responseCacheRepo.js");
    sqliteRepo = repo;
    return sqliteRepo;
  } catch (err) {
    // Graceful fallback to memory mode if SQLite repo is unreachable
    return null;
  }
}

/**
 * Normalizes text content: trims whitespace and normalizes internal line breaks
 */
function normalizeText(text) {
  if (typeof text !== "string") return text;
  return text.trim().replace(/\r\n/g, "\n");
}

/**
 * Normalizes input messages and tools into a deterministic JSON string
 * Includes semantic prompt normalization and tool parameter ordering
 */
export function normalizePayload(payload = {}) {
  const model = String(payload.model || "").trim().toLowerCase();
  const temperature = payload.temperature != null ? Number(payload.temperature) : null;

  // Sort tools deterministically by name
  let tools = null;
  if (Array.isArray(payload.tools)) {
    tools = payload.tools
      .map((t) => ({
        type: t?.type || "function",
        name: t?.function?.name || t?.name || "",
        description: normalizeText(t?.function?.description || t?.description || ""),
        parameters: t?.function?.parameters || t?.parameters || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Normalize messages
  const messages = Array.isArray(payload.messages)
    ? payload.messages.map((m) => {
        let content = m?.content;
        if (typeof content === "string") {
          content = normalizeText(content);
        } else if (Array.isArray(content)) {
          content = content.map((c) => {
            if (typeof c === "string") return normalizeText(c);
            if (c?.type === "text") return { type: "text", text: normalizeText(c.text) };
            if (c?.type === "image_url") return { type: "image_url", url: c.image_url?.url || c.url };
            return c;
          });
        }
        return {
          role: String(m?.role || "").trim().toLowerCase(),
          content,
          name: m?.name || undefined,
          tool_call_id: m?.tool_call_id || undefined,
          tool_calls: m?.tool_calls || undefined,
        };
      })
    : [];

  return {
    model,
    messages,
    tools,
    temperature,
    system: typeof payload.system === "string" ? normalizeText(payload.system) : payload.system || undefined,
  };
}

/**
 * Generates deterministic SHA-256 fingerprint for a chat request
 */
export function generateCacheKey(payload = {}) {
  const normalized = normalizePayload(payload);
  const serialized = JSON.stringify(normalized);
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Determines whether a request can be safely cached
 */
export function isCacheable(payload = {}, options = {}) {
  if (process.env.ENABLE_RESPONSE_CACHE === "false" || process.env.ENABLE_RESPONSE_CACHE === "0") {
    return false;
  }
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return false;
  }
  // Optional bypass flag from client headers
  if (options.bypassCache === true || payload.bypass_cache === true) {
    return false;
  }
  return true;
}

/**
 * Retrieves a cached entry synchronously from Memory (L1)
 */
export function getCachedEntry(cacheKey) {
  if (!cacheKey) return null;

  if (currentStorageMode === "sqlite") {
    // In pure sqlite mode, sync get returns null (must use getCachedEntryAsync)
    return null;
  }

  const entry = cacheMap.get(cacheKey);
  if (!entry) {
    stats.misses++;
    return null;
  }

  if (Date.now() > entry.expiry) {
    cacheMap.delete(cacheKey);
    stats.misses++;
    return null;
  }

  // Touch entry for LRU (re-insert at the end)
  cacheMap.delete(cacheKey);
  cacheMap.set(cacheKey, entry);

  stats.hits++;
  stats.l1Hits++;
  return entry;
}

/**
 * Retrieves a cached entry asynchronously (checks Memory L1 -> SQLite L2)
 */
export async function getCachedEntryAsync(cacheKey) {
  if (!cacheKey) return null;

  // 1. Check L1 Memory if hybrid or memory
  if (currentStorageMode !== "sqlite") {
    const l1Entry = getCachedEntry(cacheKey);
    if (l1Entry) return l1Entry;
  }

  // 2. If memory mode only, miss
  if (currentStorageMode === "memory") {
    return null;
  }

  // 3. Check L2 SQLite
  try {
    const db = await getSqliteRepo();
    if (db) {
      const l2Entry = await db.getCacheEntry(cacheKey);
      if (l2Entry) {
        stats.hits++;
        stats.l2Hits++;

        // Backfill to L1 memory cache for instant future hits
        if (currentStorageMode === "hybrid") {
          const ttlMs = (l2Entry.expiry || (Date.now() + DEFAULT_CACHE_TTL_MS)) - Date.now();
          if (ttlMs > 0) {
            setCachedEntryInMemory(cacheKey, l2Entry, ttlMs);
          }
        }
        return l2Entry;
      }
    }
  } catch (err) {
    // Fail-open to avoid breaking user requests
  }

  stats.misses++;
  return null;
}

/**
 * Internal helper to save into in-memory LRU map
 */
function setCachedEntryInMemory(cacheKey, entryData, ttlMs) {
  const ttl = ttlMs || (process.env.RESPONSE_CACHE_TTL_MS ? parseInt(process.env.RESPONSE_CACHE_TTL_MS, 10) : DEFAULT_CACHE_TTL_MS);
  const maxSize = process.env.RESPONSE_CACHE_MAX_SIZE ? parseInt(process.env.RESPONSE_CACHE_MAX_SIZE, 10) : DEFAULT_MAX_CACHE_SIZE;

  // LRU eviction if full
  if (cacheMap.size >= maxSize && !cacheMap.has(cacheKey)) {
    const oldestKey = cacheMap.keys().next().value;
    if (oldestKey) {
      cacheMap.delete(oldestKey);
      stats.evictions++;
    }
  }

  cacheMap.set(cacheKey, {
    ...entryData,
    createdAt: Date.now(),
    expiry: Date.now() + (ttl > 0 ? ttl : DEFAULT_CACHE_TTL_MS),
  });
}

/**
 * Stores a response entry into the cache (sync L1 + background L2 persist)
 */
export function setCachedEntry(cacheKey, entryData, ttlMs) {
  if (!cacheKey || !entryData) return;

  const ttl = ttlMs || (process.env.RESPONSE_CACHE_TTL_MS ? parseInt(process.env.RESPONSE_CACHE_TTL_MS, 10) : DEFAULT_CACHE_TTL_MS);

  // 1. Store in memory unless pure sqlite mode
  if (currentStorageMode !== "sqlite") {
    setCachedEntryInMemory(cacheKey, entryData, ttl);
  }

  // 2. Persist to SQLite in background if hybrid or sqlite
  if (currentStorageMode !== "memory") {
    getSqliteRepo()
      .then((db) => {
        if (db) {
          return db.setCacheEntry(cacheKey, entryData, ttl);
        }
      })
      .catch(() => {});
  }
}

/**
 * Stores a response entry into the cache and awaits persistence
 */
export async function setCachedEntryAsync(cacheKey, entryData, ttlMs) {
  if (!cacheKey || !entryData) return;

  const ttl = ttlMs || (process.env.RESPONSE_CACHE_TTL_MS ? parseInt(process.env.RESPONSE_CACHE_TTL_MS, 10) : DEFAULT_CACHE_TTL_MS);

  if (currentStorageMode !== "sqlite") {
    setCachedEntryInMemory(cacheKey, entryData, ttl);
  }

  if (currentStorageMode !== "memory") {
    try {
      const db = await getSqliteRepo();
      if (db) {
        await db.setCacheEntry(cacheKey, entryData, ttl);
      }
    } catch {}
  }
}

/**
 * Synthesizes an instantaneous SSE Response from cached streaming chunks
 */
export function createCachedStreamResponse(cachedEntry, options = {}) {
  const chunks = cachedEntry?.chunks || [];
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        const payload = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-9Router-Cache": "HIT",
      "X-Cache-Lookup": "HIT",
      "X-Cache-Backend": currentStorageMode,
      ...(options.headers || {}),
    },
  });
}

/**
 * Synthesizes an instantaneous JSON Response from cached non-streaming completion
 */
export function createCachedJsonResponse(cachedEntry, options = {}) {
  const payload = cachedEntry?.json || cachedEntry?.data || {};

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-9Router-Cache": "HIT",
      "X-Cache-Lookup": "HIT",
      "X-Cache-Backend": currentStorageMode,
      ...(options.headers || {}),
    },
  });
}

/**
 * Non-blocking wrapper around an active upstream SSE stream to capture chunks and cache them
 */
export function wrapStreamWithCacheRecording(originalStream, cacheKey, metadata = {}) {
  if (!originalStream || !cacheKey) return originalStream;

  const recordedChunks = [];
  const rawChunks = [];
  const textDecoder = new TextDecoder();
  let buffer = "";

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      try {
        const text = textDecoder.decode(chunk, { stream: true });
        rawChunks.push(text);
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.slice(6).trim();
            if (dataStr && dataStr !== "[DONE]") {
              try {
                const parsed = JSON.parse(dataStr);
                recordedChunks.push(parsed);
              } catch {
                recordedChunks.push(dataStr);
              }
            }
          }
        }
      } catch {
        // Recording error should never interrupt stream delivery
      }
    },
    flush() {
      const finalChunks = recordedChunks.length > 0 ? recordedChunks : rawChunks;
      if (finalChunks.length > 0) {
        if (typeof cacheKey === "function") {
          try {
            cacheKey(finalChunks);
          } catch {}
        } else {
          setCachedEntry(cacheKey, {
            isStream: true,
            chunks: finalChunks,
            metadata,
          });
        }
      }
    },
  });

  return originalStream.pipeThrough(transformStream);
}

/**
 * Clears both in-memory and SQLite cache entries
 */
export async function clearResponseCache() {
  cacheMap.clear();
  stats.hits = 0;
  stats.misses = 0;
  stats.evictions = 0;
  stats.l1Hits = 0;
  stats.l2Hits = 0;

  try {
    const db = await getSqliteRepo();
    if (db) {
      await db.clearCache();
    }
  } catch {}
}

/**
 * Returns cache operational statistics
 */
export function getResponseCacheStats() {
  return {
    ...stats,
    memorySize: cacheMap.size,
    storageMode: currentStorageMode,
  };
}

export const getCacheStats = getResponseCacheStats;
