import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envRequestLogs = process.env.ENABLE_REQUEST_LOGS;
    if (envRequestLogs !== undefined) {
      const enabled = envRequestLogs.toLowerCase() === "true";
      cachedConfig = {
        enabled,
        maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
        batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
        flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
        maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
      };
      cachedConfigTs = Date.now();
      return cachedConfig;
    }
    const envFallback = process.env.OBSERVABILITY_ENABLED !== "false";
    const uiFlag = typeof settings.enableObservability === "boolean";
    const enabled = uiFlag
      ? settings.enableObservability
      : envFallback;

    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

export const __test__ = { sanitizeHeaders };

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      db.transaction(() => {
        for (const item of items) {
          if (!item.id) item.id = generateDetailId(item.model);
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

          const record = {
            id: item.id,
            provider: item.provider || null,
            model: item.model || null,
            connectionId: item.connectionId || null,
            timestamp: item.timestamp,
            status: item.status || null,
            latency: item.latency || {},
            tokens: item.tokens || {},
            request: truncateField(item.request, config.maxJsonSize),
            providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
            providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
            response: truncateField(item.response, config.maxJsonSize),
            pxpipe: item.pxpipe || undefined,
          };

          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
            [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)]
          );
        }

        const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
        if (cnt && cnt.c > config.maxRecords) {
          db.run(
            `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
            [cnt.c - config.maxRecords]
          );
        }
      });
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {return;}

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  const emailFilter = filter.accountEmail || filter.email;
  if (emailFilter) {
    const cleanEmail = String(emailFilter).trim().toLowerCase();
    try {
      const matchingConns = db.all(
        `SELECT id FROM providerConnections WHERE LOWER(COALESCE(email, '')) = ? OR LOWER(COALESCE(name, '')) = ? OR data LIKE ?`,
        [cleanEmail, cleanEmail, `%${cleanEmail}%`]
      );
      const matchingIds = matchingConns.map((r) => r.id);
      if (matchingIds.length > 0) {
        const placeholders = matchingIds.map(() => "?").join(",");
        conds.push(`connectionId IN (${placeholders})`);
        params.push(...matchingIds);
      } else {
        conds.push("(LOWER(connectionId) = ? OR LOWER(connectionId) LIKE ?)");
        params.push(cleanEmail, `%${cleanEmail}%`);
      }
    } catch {
      conds.push("(LOWER(connectionId) = ? OR LOWER(connectionId) LIKE ?)");
      params.push(cleanEmail, `%${cleanEmail}%`);
    }
  }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  // Fallback to usageHistory when requestDetails has no records
  if (totalItems === 0) {
    const histCntRow = db.get(`SELECT COUNT(*) as c FROM usageHistory ${where}`, params);
    const histTotal = histCntRow ? histCntRow.c : 0;
    if (histTotal > 0) {
      const page = filter.page || 1;
      const pageSize = filter.pageSize || 50;
      const histTotalPages = Math.ceil(histTotal / pageSize);
      const offset = (page - 1) * pageSize;
      const histRows = db.all(
        `SELECT id, timestamp, provider, model, connectionId, status, tokens, meta, cost, promptTokens, completionTokens FROM usageHistory ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      const histDetails = histRows.map((r) => {
        const tokensObj = parseJson(r.tokens, {}) || {};
        const metaObj = parseJson(r.meta, {}) || {};
        return {
          id: `hist-${r.id}`,
          timestamp: r.timestamp,
          provider: r.provider,
          model: r.model,
          connectionId: r.connectionId,
          status: r.status || "ok",
          tokens: {
            prompt_tokens: tokensObj.prompt_tokens || tokensObj.input_tokens || r.promptTokens || 0,
            completion_tokens: tokensObj.completion_tokens || tokensObj.output_tokens || r.completionTokens || 0,
            cached_tokens: tokensObj.cached_tokens || tokensObj.cache_read_input_tokens || 0,
            cache_creation_input_tokens: tokensObj.cache_creation_input_tokens || 0,
          },
          latency: metaObj.latency || (metaObj.duration ? { total: metaObj.duration } : {}),
          cost: r.cost || 0,
        };
      });

      return {
        details: histDetails,
        pagination: { page, pageSize, totalItems: histTotal, totalPages: histTotalPages, hasNext: page < histTotalPages, hasPrev: page > 1 },
      };
    }
  }

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getDistinctProviders() {
  const db = await getAdapter();
  let rows = db.all(`SELECT DISTINCT provider FROM requestDetails WHERE provider IS NOT NULL ORDER BY provider ASC`);
  if (!rows || rows.length === 0) {
    rows = db.all(`SELECT DISTINCT provider FROM usageHistory WHERE provider IS NOT NULL ORDER BY provider ASC`);
  }
  return rows.map((r) => r.provider);
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  if (row) return parseJson(row.data, null);
  if (typeof id === "string" && id.startsWith("hist-")) {
    const rawId = parseInt(id.slice(5), 10);
    const histRow = db.get(`SELECT id, timestamp, provider, model, connectionId, status, tokens, meta, cost, promptTokens, completionTokens FROM usageHistory WHERE id = ?`, [rawId]);
    if (histRow) {
      const tokensObj = parseJson(histRow.tokens, {}) || {};
      const metaObj = parseJson(histRow.meta, {}) || {};
      return {
        id: `hist-${histRow.id}`,
        timestamp: histRow.timestamp,
        provider: histRow.provider,
        model: histRow.model,
        connectionId: histRow.connectionId,
        status: histRow.status || "ok",
        tokens: {
          prompt_tokens: tokensObj.prompt_tokens || tokensObj.input_tokens || histRow.promptTokens || 0,
          completion_tokens: tokensObj.completion_tokens || tokensObj.output_tokens || histRow.completionTokens || 0,
          cached_tokens: tokensObj.cached_tokens || tokensObj.cache_read_input_tokens || 0,
          cache_creation_input_tokens: tokensObj.cache_creation_input_tokens || 0,
        },
        latency: metaObj.latency || (metaObj.duration ? { total: metaObj.duration } : {}),
        cost: histRow.cost || 0,
      };
    }
  }
  return null;
}

const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();
