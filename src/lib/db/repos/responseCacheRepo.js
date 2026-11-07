import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

/**
 * Retrieves a cached entry by its SHA-256 hash.
 * If found but expired, the stale entry is automatically deleted and null is returned.
 *
 * @param {string} hash
 * @returns {Promise<object|null>}
 */
export async function getCacheEntry(hash) {
  if (!hash) return null;
  try {
    const db = await getAdapter();
    const row = db.get(
      "SELECT data, expiresAt FROM responseCache WHERE hash = ?",
      [hash]
    );
    if (!row) return null;

    if (Date.now() > row.expiresAt) {
      db.run("DELETE FROM responseCache WHERE hash = ?", [hash]);
      return null;
    }

    return parseJson(row.data, null);
  } catch (err) {
    console.warn(`[ResponseCacheRepo] getCacheEntry error: ${err.message}`);
    return null;
  }
}

/**
 * Stores or updates a cached entry in SQLite.
 *
 * @param {string} hash - SHA-256 key
 * @param {object} data - Cached response payload (chunks, text, metadata)
 * @param {number} [ttlMs=3600000] - Expiration time in milliseconds
 * @returns {Promise<void>}
 */
export async function setCacheEntry(hash, data, ttlMs = 3600000) {
  if (!hash || !data) return;
  try {
    const db = await getAdapter();
    const now = Date.now();
    const expiresAt = now + (ttlMs > 0 ? ttlMs : 3600000);
    const serialized = stringifyJson(data);

    db.run(
      `INSERT INTO responseCache(hash, data, createdAt, expiresAt)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET
         data = excluded.data,
         expiresAt = excluded.expiresAt`,
      [hash, serialized, now, expiresAt]
    );
  } catch (err) {
    console.warn(`[ResponseCacheRepo] setCacheEntry error: ${err.message}`);
  }
}

/**
 * Removes a specific cache entry.
 *
 * @param {string} hash
 * @returns {Promise<void>}
 */
export async function deleteCacheEntry(hash) {
  if (!hash) return;
  try {
    const db = await getAdapter();
    db.run("DELETE FROM responseCache WHERE hash = ?", [hash]);
  } catch (err) {
    console.warn(`[ResponseCacheRepo] deleteCacheEntry error: ${err.message}`);
  }
}

/**
 * Clears all cached response entries.
 *
 * @returns {Promise<void>}
 */
export async function clearCache() {
  try {
    const db = await getAdapter();
    db.run("DELETE FROM responseCache");
  } catch (err) {
    console.warn(`[ResponseCacheRepo] clearCache error: ${err.message}`);
  }
}

/**
 * Prunes expired entries from the database.
 *
 * @returns {Promise<number>} Number of pruned records
 */
export async function pruneExpiredCache() {
  try {
    const db = await getAdapter();
    const res = db.run("DELETE FROM responseCache WHERE expiresAt < ?", [Date.now()]);
    return res?.changes || 0;
  } catch (err) {
    console.warn(`[ResponseCacheRepo] pruneExpiredCache error: ${err.message}`);
    return 0;
  }
}

/**
 * Returns cache metrics and count.
 *
 * @returns {Promise<{ count: number }>}
 */
export async function getCacheStats() {
  try {
    const db = await getAdapter();
    const row = db.get("SELECT COUNT(*) AS count FROM responseCache WHERE expiresAt >= ?", [Date.now()]);
    return { count: row?.count || 0 };
  } catch (err) {
    return { count: 0 };
  }
}
