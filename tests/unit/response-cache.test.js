import { describe, expect, it, beforeEach } from "vitest";
import {
  generateCacheKey,
  isCacheable,
  getCachedEntry,
  setCachedEntry,
  createCachedStreamResponse,
  createCachedJsonResponse,
  wrapStreamWithCacheRecording,
  getCacheStats,
  clearResponseCache,
} from "../../open-sse/cache/responseCache.js";

describe("responseCache", () => {
  beforeEach(() => {
    clearResponseCache();
  });

  it("generates deterministic cache keys for identical payloads", () => {
    const payload1 = {
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "Hello world" }],
      temperature: 0.7,
    };
    const payload2 = {
      model: "claude-3-5-sonnet",
      temperature: 0.7,
      messages: [{ role: "user", content: "Hello world" }],
    };

    const key1 = generateCacheKey(payload1);
    const key2 = generateCacheKey(payload2);

    expect(key1).toBeTruthy();
    expect(key1).toBe(key2);
  });

  it("generates different keys when payload parameters differ", () => {
    const base = { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] };
    const keyBase = generateCacheKey(base);
    const keyDiffModel = generateCacheKey({ ...base, model: "gpt-4o-mini" });
    const keyDiffMsg = generateCacheKey({ ...base, messages: [{ role: "user", content: "Hey" }] });
    const keyDiffTemp = generateCacheKey({ ...base, temperature: 0.2 });

    expect(keyDiffModel).not.toBe(keyBase);
    expect(keyDiffMsg).not.toBe(keyBase);
    expect(keyDiffTemp).not.toBe(keyBase);
  });

  it("determines cacheability correctly", () => {
    expect(isCacheable({ messages: [{ role: "user", content: "test" }] })).toBe(true);
    expect(isCacheable({ messages: [] })).toBe(false);
    expect(isCacheable(null)).toBe(false);
    expect(isCacheable({ messages: [{ role: "user", content: "test" }] }, { bypassCache: true })).toBe(false);
    expect(isCacheable({ messages: [{ role: "user", content: "test" }], bypass_cache: true })).toBe(false);
  });

  it("stores and retrieves cached non-streaming entries with TTL", () => {
    const key = "test-key-1";
    const data = { id: "chatcmpl-123", choices: [{ message: { content: "Cached answer" } }] };

    expect(getCachedEntry(key)).toBeNull();
    setCachedEntry(key, { isStream: false, data, model: "test-model" }, 1000);

    const retrieved = getCachedEntry(key);
    expect(retrieved).toBeTruthy();
    expect(retrieved.data).toEqual(data);
    expect(getCacheStats().hits).toBe(1);
  });

  it("expires cached entries when TTL passes", async () => {
    const key = "expiring-key";
    setCachedEntry(key, { isStream: false, data: { test: true } }, 50); // 50ms TTL

    expect(getCachedEntry(key)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 70));
    expect(getCachedEntry(key)).toBeNull();
  });

  it("synthesizes a cached JSON response with HIT header", async () => {
    const entry = { data: { id: "cached-1", text: "ok" } };
    const res = createCachedJsonResponse(entry);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-9Router-Cache")).toBe("HIT");
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const json = await res.json();
    expect(json).toEqual(entry.data);
  });

  it("synthesizes an SSE stream response from cached chunks", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const res = createCachedStreamResponse({ isStream: true, chunks });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("X-9Router-Cache")).toBe("HIT");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value);
    }

    expect(accumulated).toContain("Hello");
    expect(accumulated).toContain(" world");
    expect(accumulated).toContain("[DONE]");
  });

  it("wraps a readable stream and records chunks on completion", async () => {
    const encoder = new TextEncoder();
    const sourceStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("chunk1;"));
        controller.enqueue(encoder.encode("chunk2;"));
        controller.close();
      },
    });

    let recorded = null;
    const wrapped = wrapStreamWithCacheRecording(sourceStream, (chunks) => {
      recorded = chunks;
    });

    const reader = wrapped.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(recorded).toBeTruthy();
    expect(recorded.join("")).toBe("chunk1;chunk2;");
  });
});
