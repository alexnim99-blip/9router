/**
 * Dynamic Health & Latency-Aware Router
 *
 * Ranks and selects upstream provider accounts based on real-time circuit health,
 * rolling P95 response latency, error history, and priority.
 */

import { getCircuitBreakerStats, isAccountAvailable } from "./circuitBreaker.js";

/**
 * Calculates a composite health score for a provider connection
 *
 * Score components:
 * - Base health: 100 for CLOSED, 30 for HALF_OPEN, 0 for OPEN
 * - Latency penalty: up to -50 pts (scaled by latency, e.g. 5000ms = -50)
 * - Failure penalty: -15 pts per consecutive failure
 * - Priority bonus: (100 - priority) where priority 1 is highest
 */
export function scoreConnection(conn, breakerEntry = null) {
  if (!conn) return 0;
  const connId = conn.id || conn.connectionId;
  const stats = breakerEntry || getCircuitBreakerStats()[connId] || {
    state: "CLOSED",
    failures: 0,
    p95Latency: 0,
  };

  let score = 100;

  // Circuit breaker state
  if (stats.state === "OPEN") {
    score = 0;
  } else if (stats.state === "HALF_OPEN") {
    score = 30;
  }

  // Consecutive failure penalty
  score -= Math.min(stats.failures * 15, 60);

  // Latency penalty: penalize slow connections (e.g. 3000ms -> -30 pts)
  if (stats.p95Latency > 200) {
    const latencyPenalty = Math.min(Math.round((stats.p95Latency - 200) / 100), 40);
    score -= latencyPenalty;
  }

  // Priority bonus: 1-10 (higher priority number in DB usually means preferred or 1 is top)
  const priority = typeof conn.priority === "number" ? conn.priority : 10;
  score += Math.max(0, 10 - priority);

  return Math.max(0, score);
}

/**
 * Ranks an array of provider connections by health score and latency
 *
 * @param {Array<object>} connections
 * @returns {Array<object>} Sorted array (healthiest/lowest-latency first)
 */
export function rankConnections(connections = []) {
  if (!Array.isArray(connections) || connections.length <= 1) {
    return connections || [];
  }

  const allBreakerStats = getCircuitBreakerStats();

  const scored = connections.map((conn) => {
    const connId = conn.id || conn.connectionId;
    const stats = allBreakerStats[connId] || null;
    return {
      conn,
      score: scoreConnection(conn, stats),
      stats,
    };
  });

  // Sort descending by score, then ascending by latency
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    const latA = a.stats?.p95Latency || 500;
    const latB = b.stats?.p95Latency || 500;
    return latA - latB;
  });

  return scored.map((s) => s.conn);
}

/**
 * Filters out accounts that are currently tripped in OPEN state, unless ALL are tripped
 *
 * @param {Array<object>} connections
 * @returns {Array<object>} Available connections
 */
export function filterAvailableConnections(connections = []) {
  if (!Array.isArray(connections) || connections.length === 0) {
    return [];
  }

  const available = connections.filter((conn) => {
    const connId = conn.id || conn.connectionId;
    return isAccountAvailable(connId);
  });

  // If at least one account is available, return those
  if (available.length > 0) {
    return available;
  }

  // Fallback: If all are tripped, find the one closest to cooldown recovery
  const allStats = getCircuitBreakerStats();
  const sortedByRecovery = [...connections].sort((a, b) => {
    const idA = a.id || a.connectionId;
    const idB = b.id || b.connectionId;
    const untilA = allStats[idA]?.trippedUntil || Infinity;
    const untilB = allStats[idB]?.trippedUntil || Infinity;
    return untilA - untilB;
  });

  return sortedByRecovery.slice(0, 1);
}
