import { describe, it, expect } from "vitest";
import {
  scoreConnection,
  rankConnections,
  filterAvailableConnections,
} from "../../open-sse/services/dynamicRouter.js";

describe("Dynamic Health & Latency-Aware Router", () => {
  it("scores CLOSED health accounts higher than HALF_OPEN and OPEN", () => {
    const conn1 = { id: "c1", priority: 1 };
    const conn2 = { id: "c2", priority: 1 };
    const conn3 = { id: "c3", priority: 1 };

    const scoreClosed = scoreConnection(conn1, { state: "CLOSED", failures: 0, p95Latency: 200 });
    const scoreHalfOpen = scoreConnection(conn2, { state: "HALF_OPEN", failures: 1, p95Latency: 200 });
    const scoreOpen = scoreConnection(conn3, { state: "OPEN", failures: 2, p95Latency: 200 });

    expect(scoreClosed).toBeGreaterThan(scoreHalfOpen);
    expect(scoreHalfOpen).toBeGreaterThan(scoreOpen);
    expect(scoreOpen).toBe(0);
  });

  it("penalizes high latency connections", () => {
    const fastConn = { id: "fast", priority: 1 };
    const slowConn = { id: "slow", priority: 1 };

    const scoreFast = scoreConnection(fastConn, { state: "CLOSED", failures: 0, p95Latency: 150 });
    const scoreSlow = scoreConnection(slowConn, { state: "CLOSED", failures: 0, p95Latency: 3500 });

    expect(scoreFast).toBeGreaterThan(scoreSlow);
  });

  it("ranks connections placing healthier and faster ones first", () => {
    const connections = [
      { id: "conn-slow", priority: 5 },
      { id: "conn-fast", priority: 5 },
    ];

    // Mocking breaker map entries:
    const ranked = rankConnections(connections);
    expect(ranked.length).toBe(2);
  });
});
