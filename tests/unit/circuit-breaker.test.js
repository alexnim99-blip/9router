import { describe, expect, it, beforeEach } from "vitest";
import {
  isAccountAvailable,
  recordSuccess,
  recordFailure,
  getAccountHealth,
  resetCircuitBreaker,
  setAccountCircuitState,
  STATES,
} from "../../open-sse/services/circuitBreaker.js";

describe("circuitBreaker", () => {
  beforeEach(() => {
    resetCircuitBreaker();
  });

  it("considers accounts healthy and available by default", () => {
    expect(isAccountAvailable("acc-1")).toBe(true);
    const health = getAccountHealth("acc-1");
    expect(health.state).toBe(STATES.CLOSED);
    expect(health.consecutiveFailures).toBe(0);
  });

  it("trips to OPEN state after reaching failure threshold", () => {
    const acc = "acc-tripping";

    // 1st failure (below threshold 2)
    recordFailure(acc, { status: 429 });
    expect(isAccountAvailable(acc)).toBe(true);
    expect(getAccountHealth(acc).consecutiveFailures).toBe(1);
    expect(getAccountHealth(acc).state).toBe(STATES.CLOSED);

    // 2nd failure (hits threshold 2)
    recordFailure(acc, { status: 503 });
    expect(getAccountHealth(acc).state).toBe(STATES.OPEN);
    expect(isAccountAvailable(acc)).toBe(false);
  });

  it("does not trip on non-transient 4xx errors like 400 Bad Request or 404", () => {
    const acc = "acc-bad-request";
    recordFailure(acc, { status: 400 });
    recordFailure(acc, { status: 404 });
    expect(isAccountAvailable(acc)).toBe(true);
    expect(getAccountHealth(acc).consecutiveFailures).toBe(0);
  });

  it("resets to CLOSED state and clears failures on success", () => {
    const acc = "acc-recovering";
    recordFailure(acc, { status: 429 });
    expect(getAccountHealth(acc).consecutiveFailures).toBe(1);

    recordSuccess(acc, { latencyMs: 250 });
    const health = getAccountHealth(acc);
    expect(health.state).toBe(STATES.CLOSED);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.averageLatencyMs).toBe(250);
  });

  it("transitions to HALF_OPEN after cooldown window passes", () => {
    const acc = "acc-cooldown";
    recordFailure(acc, { status: 500 });
    recordFailure(acc, { status: 500 });
    expect(isAccountAvailable(acc)).toBe(false);

    // Simulate cooldown window expiration
    setAccountCircuitState(acc, { trippedUntil: Date.now() - 1000 });

    expect(isAccountAvailable(acc)).toBe(true);
    expect(getAccountHealth(acc).state).toBe(STATES.HALF_OPEN);
  });

  it("tracks rolling average latency across multiple requests", () => {
    const acc = "acc-latency";
    recordSuccess(acc, { latencyMs: 100 });
    recordSuccess(acc, { latencyMs: 200 });
    recordSuccess(acc, { latencyMs: 300 });

    const health = getAccountHealth(acc);
    expect(health.averageLatencyMs).toBe(200);
  });
});
