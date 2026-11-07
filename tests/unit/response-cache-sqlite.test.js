import { describe, it, expect, beforeEach } from "vitest";
import {
  setCacheStorageBackend,
  setCachedEntryAsync,
  getCachedEntryAsync,
  getCachedEntry,
  clearResponseCache,
  getResponseCacheStats,
  generateCacheKey,
} from "../../open-sse/cache/responseCache.js";

describe("Response Cache Multi-Storage (Hybrid, Memory & SQLite)", () => {
  // In-memory mock SQLite repository
  const mockDb = new Map();
  const mockSqliteRepo = {
    async getCacheEntry(hash) {
      const row = mockDb.get(hash);
      if (!row) return null;
      if (Date.now() > row.expiresAt) {
        mockDb.delete(hash);
        return null;
      }
      return row.data;
    },
    async setCacheEntry(hash, data, ttlMs = 3600000) {
      mockDb.set(hash, {
        data,
        expiresAt: Date.now() + ttlMs,
      });
    },
    async deleteCacheEntry(hash) {
      mockDb.delete(hash);
    },
    async clearCache() {
      mockDb.clear();
    },
  };

  beforeEach(async () => {
    mockDb.clear();
    setCacheStorageBackend("hybrid", mockSqliteRepo);
    await clearResponseCache();
  });

  it("stores and retrieves from hybrid cache", async () => {
    const key = generateCacheKey({ model: "gpt-4o", messages: [{ role: "user", content: "hello" }] });
    const payload = { isStream: false, json: { text: "cached answer" } };

    await setCachedEntryAsync(key, payload, 60000);

    // Fast synchronous L1 hit
    const syncHit = getCachedEntry(key);
    expect(syncHit).toBeDefined();
    expect(syncHit.json.text).toBe("cached answer");

    // Async L1/L2 hit
    const asyncHit = await getCachedEntryAsync(key);
    expect(asyncHit).toBeDefined();
    expect(asyncHit.json.text).toBe("cached answer");
  });

  it("falls back to SQLite L2 when L1 memory cache misses", async () => {
    const key = "test-hash-l2-fallback";
    // Directly seed SQLite L2 storage
    await mockSqliteRepo.setCacheEntry(key, { isStream: true, chunks: ["chunk-1", "chunk-2"] }, 60000);

    // L1 memory initially does not have it
    expect(getCachedEntry(key)).toBeNull();

    // Async get fetches from SQLite L2 and backfills L1
    const l2Hit = await getCachedEntryAsync(key);
    expect(l2Hit).toBeDefined();
    expect(l2Hit.chunks).toEqual(["chunk-1", "chunk-2"]);

    // Subsequent sync lookup now hits L1 memory!
    const backfilledHit = getCachedEntry(key);
    expect(backfilledHit).toBeDefined();
    expect(backfilledHit.chunks).toEqual(["chunk-1", "chunk-2"]);
  });

  it("respects TTL expiration in SQLite storage", async () => {
    const key = "expired-hash-test";
    await mockSqliteRepo.setCacheEntry(key, { isStream: false, json: { hello: "world" } }, -100);

    const hit = await getCachedEntryAsync(key);
    expect(hit).toBeNull();
  });

  it("supports memory-only mode without calling SQLite", async () => {
    setCacheStorageBackend("memory", mockSqliteRepo);
    const key = "memory-only-key";

    await setCachedEntryAsync(key, { data: "pure memory" }, 60000);

    expect(getCachedEntry(key)).toBeDefined();
    expect(mockDb.has(key)).toBe(false); // was never written to SQLite mock
  });
});
