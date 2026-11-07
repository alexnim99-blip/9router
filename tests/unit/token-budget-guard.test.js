import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimitAndBudget,
  recordTokenUsage,
  getBudgetStats,
  resetBudgetTracking,
} from "../../open-sse/services/tokenBudgetGuard.js";

describe("Token Budget & Runaway Agent Guard", () => {
  beforeEach(() => {
    resetBudgetTracking();
  });

  it("allows normal requests within budget", () => {
    const res = checkRateLimitAndBudget("key-1", 500, { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hi" }] });
    expect(res.allowed).toBe(true);
  });

  it("detects runaway agent loop when repeated requests occur rapidly", () => {
    const key = "agent-loop-test";
    const payload = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Repeat tool call execution" }],
    };

    // Simulate 8 rapid near-identical requests
    let trippedResult = null;
    for (let i = 0; i < 9; i++) {
      const res = checkRateLimitAndBudget(key, 100, payload);
      if (!res.allowed) {
        trippedResult = res;
        break;
      }
    }

    expect(trippedResult).not.toBeNull();
    expect(trippedResult.allowed).toBe(false);
    expect(trippedResult.status).toBe(429);
    expect(trippedResult.reason).toContain("Runaway agent loop detected");
  });

  it("tracks tokens and provides statistics", () => {
    const key = "key-stats-test";
    checkRateLimitAndBudget(key, 250);
    recordTokenUsage(key, 800);

    const stats = getBudgetStats(key);
    expect(stats.requestsInLastMinute).toBe(1);
    expect(stats.tokensInLastMinute).toBe(250);
    expect(stats.tokensInLast24Hours).toBe(800);
  });
});
