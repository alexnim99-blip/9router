import { createHash } from "node:crypto";

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_CACHE_SIZE = 1000;

const cacheMap = new Map();
const stats = {
  hits: 0,
  misses: 0,
  evictions: 0,
};

/**
 * Normalizes input messages and tools into a deterministic JSON string
 */
function normalizePayload(payload = {}) {
  const model = String(payload.model || "").trim().toLowerCase();
  const temperature = payload.temperature != null ? Number(payload.temperature) : null;
  const tools = Array.isArray(payload.tools)
    ? payload.tools.map((t) => ({
        type: t?.type || "function",
        name: t?.function?.name || t?.name || "",
        description: t?.function?.description || t?.description || "",
        parameters: t?.function?.parameters || t?.parameters || null,
      }))
    : null;

  const messages = Array.isArray(payload.messages)
    ? payload.messages.map((m) => {
        let content = m?.content;
        if (Array.isArray(content)) {
          content = content.map((c) => {
            if (typeof c === "string") return c;
            if (c?.type === "text") return { type: "text", text: c.text };
            if (c?.type === "image_url") return { type: "image_url", url: c.image_url?.url || c.url };
            return c;
          });
        }
        return {
          role: m?.role || "",
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
    system: payload.system || undefined,
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
 * Retrieves a cached entry if available and not expired
 */
export function getCachedEntry(cacheKey) {
  if (!cacheKey) return null;
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
  return entry;
}

/**
 * Stores a response entry into the cache
 */
export function setCachedEntry(cacheKey, entryData, ttlMs) {
  if (!cacheKey || !entryData) return;

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
 * Synthesizes an instantaneous SSE Response from cached streaming chunks
 */
export function createCachedStreamResponse(cachedEntry, options = {}) {
  const chunks = cachedEntry?.chunks || [];
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (typeof chunk === "string") {
          controller.enqueue(encoder.encode(chunk));
        } else if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk);
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-9Router-Cache": "HIT",
      "X-Cache-Lookup-Ms": "0",
    },
  });
}

/**
 * Synthesizes a JSON Response from cached non-streaming data
 */
export function createCachedJsonResponse(cachedEntry) {
  const body = typeof cachedEntry?.data === "string" ? cachedEntry.data : JSON.stringify(cachedEntry?.data || {});
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-9Router-Cache": "HIT",
      "X-Cache-Lookup-Ms": "0",
    },
  });
}

/**
 * Wraps an outgoing ReadableStream to tee chunks and record full stream on completion
 */
export function wrapStreamWithCacheRecording(readableStream, onComplete) {
  if (!readableStream || typeof readableStream.getReader !== "function") {
    return readableStream;
  }

  const chunks = [];
  const decoder = new TextDecoder();

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      try {
        const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        chunks.push(text);
      } catch {
        // ignore decoding errors
      }
    },
    flush() {
      try {
        if (chunks.length > 0 && typeof onComplete === "function") {
          onComplete(chunks);
        }
      } catch (err) {
        console.warn("[ResponseCache] Failed to record completed stream:", err.message);
      }
    },
  });

  return readableStream.pipeThrough(transformStream);
}

/**
 * Cache diagnostics & stats
 */
export function getCacheStats() {
  return {
    size: cacheMap.size,
    hits: stats.hits,
    misses: stats.misses,
    evictions: stats.evictions,
  };
}

/**
 * Clears entire cache (for testing or manual purge)
 */
export function clearResponseCache() {
  cacheMap.clear();
  stats.hits = 0;
  stats.misses = 0;
  stats.evictions = 0;
}
