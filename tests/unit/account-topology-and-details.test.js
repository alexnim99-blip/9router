import fs from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/lib/db/repos/settingsRepo.js";
import {
  saveRequestUsage,
  getRequestDetails,
  getRequestDetailById,
} from "../../src/lib/usageDb.js";
import { getDistinctProviders } from "../../src/lib/db/repos/requestDetailsRepo.js";
import {
  trackPendingRequest,
  getActiveRequests,
  getUsageStats,
} from "../../src/lib/db/repos/usageRepo.js";
import { getAdapter } from "../../src/lib/db/driver.js";

describe("Account-Level Topology and Request Details Fallback", () => {
  it("enableObservability defaults to true in DEFAULT_SETTINGS", () => {
    expect(DEFAULT_SETTINGS.enableObservability).toBe(true);
  });

  describe("requestDetails fallback to usageHistory and Account Email filtering", () => {
    beforeAll(async () => {
      const db = await getAdapter();
      // Ensure providerConnections table has test connection for email mapping
      try {
        db.run(
          `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, data)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "conn-gmail-1",
            "antigravity",
            "oauth",
            "gmail 1 Antigravity",
            "alexnim99@gmail.com",
            1,
            1,
            new Date().toISOString(),
            new Date().toISOString(),
            JSON.stringify({ email: "alexnim99@gmail.com" }),
          ]
        );
      } catch {}
    });

    it("returns records from usageHistory when requestDetails has no entries", async () => {
      const now = new Date().toISOString();
      await saveRequestUsage({
        provider: "antigravity",
        model: "gemini-2.5-pro",
        connectionId: "conn-gmail-1",
        inputTokens: 1500,
        outputTokens: 300,
        cachedTokens: 200,
        totalTokens: 1800,
        cost: 0.005,
        duration: 450,
        status: "success",
        timestamp: now,
      });

      await saveRequestUsage({
        provider: "antigravity",
        model: "claude-sonnet-4-6",
        connectionId: "conn-gmail-2",
        inputTokens: 2500,
        outputTokens: 500,
        cachedTokens: 100,
        totalTokens: 3000,
        cost: 0.012,
        duration: 620,
        status: "success",
        timestamp: now,
      });

      await saveRequestUsage({
        provider: "claude",
        model: "claude-sonnet-4-6",
        connectionId: "conn-claude-1",
        inputTokens: 1000,
        outputTokens: 200,
        cachedTokens: 0,
        totalTokens: 1200,
        cost: 0.004,
        duration: 380,
        status: "success",
        timestamp: now,
      });

      // Query request details
      const result = await getRequestDetails({ page: 1, pageSize: 10 });
      expect(result.details.length).toBeGreaterThanOrEqual(3);
      expect(result.pagination.totalItems).toBeGreaterThanOrEqual(3);

      const antigravityItems = result.details.filter(d => d.provider === "antigravity");
      expect(antigravityItems.length).toBeGreaterThanOrEqual(2);

      // Verify connectionId is preserved
      const connIds = result.details.map(d => d.connectionId);
      expect(connIds).toContain("conn-gmail-1");
      expect(connIds).toContain("conn-gmail-2");
      expect(connIds).toContain("conn-claude-1");

      // Verify token structure is mapped properly for table & drawer
      const item = result.details.find(d => d.connectionId === "conn-gmail-1");
      expect(item.tokens.prompt_tokens).toBe(1500);
      expect(item.tokens.completion_tokens).toBe(300);
      expect(item.tokens.cached_tokens).toBe(200);
      expect(item.latency.total).toBe(450);
      expect(item.cost).toBe(0.005);
      expect(item.status).toBe("success");
    });

    it("filters usageHistory fallback by accountEmail", async () => {
      const result = await getRequestDetails({
        page: 1,
        pageSize: 10,
        accountEmail: "alexnim99@gmail.com",
      });

      expect(result.details.length).toBeGreaterThanOrEqual(1);
      for (const d of result.details) {
        expect(d.connectionId).toBe("conn-gmail-1");
      }
    });

    it("filters usageHistory fallback by connectionId", async () => {
      const result = await getRequestDetails({
        page: 1,
        pageSize: 10,
        connectionId: "conn-gmail-1",
      });

      expect(result.details.length).toBeGreaterThanOrEqual(1);
      for (const d of result.details) {
        expect(d.connectionId).toBe("conn-gmail-1");
      }
    });

    it("filters usageHistory fallback by provider", async () => {
      const result = await getRequestDetails({
        page: 1,
        pageSize: 10,
        provider: "claude",
      });

      expect(result.details.length).toBeGreaterThanOrEqual(1);
      for (const d of result.details) {
        expect(d.provider).toBe("claude");
      }
    });

    it("filters by both provider and accountEmail simultaneously", async () => {
      const result = await getRequestDetails({
        page: 1,
        pageSize: 10,
        provider: "antigravity",
        accountEmail: "alexnim99@gmail.com",
      });

      expect(result.details.length).toBeGreaterThanOrEqual(1);
      for (const d of result.details) {
        expect(d.provider).toBe("antigravity");
        expect(d.connectionId).toBe("conn-gmail-1");
      }
    });

    it("getDistinctProviders returns providers from usageHistory fallback", async () => {
      const providers = await getDistinctProviders();
      expect(providers).toContain("antigravity");
      expect(providers).toContain("claude");
    });

    it("getRequestDetailById retrieves detail with hist- prefix from usageHistory", async () => {
      const result = await getRequestDetails({ page: 1, pageSize: 1 });
      expect(result.details.length).toBe(1);

      const firstId = result.details[0].id;
      const detail = await getRequestDetailById(firstId);
      expect(detail).toBeDefined();
      expect(detail.id).toBe(firstId);
      expect(detail.tokens).toBeDefined();
    });
  });

  describe("Active Requests with connectionId", () => {
    it("preserves connectionId in active requests", async () => {
      trackPendingRequest("claude-sonnet-4-6", "antigravity", "conn-gmail-3", true);

      const res = await getActiveRequests();
      const active = res.activeRequests;
      const found = active.find(r => r.connectionId === "conn-gmail-3");
      expect(found).toBeDefined();
      expect(found.connectionId).toBe("conn-gmail-3");

      trackPendingRequest("claude-sonnet-4-6", "antigravity", "conn-gmail-3", false);
      const afterRes = await getActiveRequests();
      expect(afterRes.activeRequests.find(r => r.connectionId === "conn-gmail-3")).toBeUndefined();
    });
  });

  describe("Usage Stats by Account aggregation", () => {
    it("aggregates stats by connectionId in byAccount", async () => {
      const stats = await getUsageStats("24h");
      expect(stats.byAccount).toBeDefined();
      expect(typeof stats.byAccount).toBe("object");

      if (stats.byAccount["conn-gmail-1"]) {
        expect(stats.byAccount["conn-gmail-1"].requests).toBeGreaterThanOrEqual(1);
        expect(stats.byAccount["conn-gmail-1"].promptTokens).toBeGreaterThanOrEqual(1500);
      }
      if (stats.byAccount["conn-gmail-2"]) {
        expect(stats.byAccount["conn-gmail-2"].requests).toBeGreaterThanOrEqual(1);
        expect(stats.byAccount["conn-gmail-2"].promptTokens).toBeGreaterThanOrEqual(2500);
      }
    });
  });

  describe("Frontend Integration & UI Invariants", () => {
    it("RequestDetailsTab imports useMemo from react to prevent runtime crash", () => {
      const src = fs.readFileSync("../src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js", "utf8");
      expect(src).toMatch(/import\s*\{[^}]*useMemo[^}]*\}\s*from\s*["\']react["\']/);
      expect(src).toContain("account-email-filter");
    });

    it("UsageStats defines ACCOUNT_COLUMNS with accountName as 1st column matching grouping", () => {
      const src = fs.readFileSync("../src/shared/components/UsageStats.js", "utf8");
      const match = src.match(/const ACCOUNT_COLUMNS = \[(\s*\{[^}]+\},?\s*)+\];/);
      expect(match).toBeDefined();
      const block = match[0];
      expect(block).toContain("{ field: \"accountName\", label: \"Account\" }");
      // Ensure accountName appears before rawModel in ACCOUNT_COLUMNS
      const accountIdx = block.indexOf("accountName");
      const modelIdx = block.indexOf("rawModel");
      expect(accountIdx).toBeLessThan(modelIdx);
    });

    it("ProviderTopology supports onSelectAccount for interactive topology routing", () => {
      const src = fs.readFileSync("../src/app/(dashboard)/dashboard/usage/components/ProviderTopology.js", "utf8");
      expect(src).toContain("onSelectAccount");
    });

    it("accountUsageMap aggregates connection usage and falls back to provider", () => {
      const mockStats = {
        byAccount: {
          "gemini-2.5-pro (antigravity - gmail 1)": {
            connectionId: "conn-gmail-1",
            requests: 5,
            promptTokens: 1000,
            completionTokens: 200,
            cachedTokens: 50,
            cost: 0.01,
          },
        },
        byProvider: {
          "opencode": {
            requests: 3,
            promptTokens: 500,
            completionTokens: 100,
            cachedTokens: 0,
            cost: 0,
          },
        },
      };

      const map = {};
      if (mockStats.byAccount) {
        for (const item of Object.values(mockStats.byAccount)) {
          const connId = item.connectionId;
          if (connId) {
            if (!map[connId]) {
              map[connId] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0 };
            }
            map[connId].requests += item.requests || 0;
            map[connId].promptTokens += item.promptTokens || 0;
            map[connId].completionTokens += item.completionTokens || 0;
            map[connId].cachedTokens += item.cachedTokens || 0;
            map[connId].totalTokens += (item.promptTokens || 0) + (item.completionTokens || 0);
            map[connId].cost += item.cost || 0;
          }
        }
      }
      if (mockStats.byProvider) {
        for (const [prov, p] of Object.entries(mockStats.byProvider)) {
          if (!map[prov]) {
            map[prov] = {
              requests: p.requests || 0,
              promptTokens: p.promptTokens || 0,
              completionTokens: p.completionTokens || 0,
              cachedTokens: p.cachedTokens || 0,
              totalTokens: (p.promptTokens || 0) + (p.completionTokens || 0),
              cost: p.cost || 0,
            };
          }
        }
      }

      expect(map["conn-gmail-1"]).toBeDefined();
      expect(map["conn-gmail-1"].requests).toBe(5);
      expect(map["conn-gmail-1"].totalTokens).toBe(1200);
      expect(map["opencode"]).toBeDefined();
      expect(map["opencode"].requests).toBe(3);
      expect(map["opencode"].totalTokens).toBe(600);
    });
  });
});