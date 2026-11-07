const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 30 * 1000; // 30 seconds
const LATENCY_WINDOW_SIZE = 10;

const STATES = {
  CLOSED: "CLOSED",       // Normal healthy state
  OPEN: "OPEN",           // Tripped, cooling down
  HALF_OPEN: "HALF_OPEN", // Probing with 1 request
};

const accountCircuits = new Map();

function getOrCreateCircuit(connectionId) {
  if (!accountCircuits.has(connectionId)) {
    accountCircuits.set(connectionId, {
      state: STATES.CLOSED,
      consecutiveFailures: 0,
      trippedUntil: 0,
      recentLatencies: [],
      averageLatencyMs: 0,
      totalRequests: 0,
      totalFailures: 0,
    });
  }
  return accountCircuits.get(connectionId);
}

function getFailureThreshold() {
  if (process.env.CIRCUIT_BREAKER_THRESHOLD) {
    const val = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD, 10);
    if (!Number.isNaN(val) && val > 0) return val;
  }
  return DEFAULT_FAILURE_THRESHOLD;
}

function getCooldownMs() {
  if (process.env.CIRCUIT_BREAKER_COOLDOWN_MS) {
    const val = parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS, 10);
    if (!Number.isNaN(val) && val > 0) return val;
  }
  return DEFAULT_COOLDOWN_MS;
}

function isTripWorthyError(status) {
  if (!status) return true;
  const s = Number(status);
  // Rate limits (429), Overloaded (503), Server errors (500, 502, 504), or Gateway timeouts
  return s === 429 || s === 500 || s === 502 || s === 503 || s === 504;
}

/**
 * Checks whether an account is available or tripped
 */
export function isAccountAvailable(connectionId) {
  if (!connectionId) return true;
  if (process.env.ENABLE_CIRCUIT_BREAKER === "false" || process.env.ENABLE_CIRCUIT_BREAKER === "0") {
    return true;
  }

  const circuit = getOrCreateCircuit(connectionId);

  if (circuit.state === STATES.CLOSED) {
    return true;
  }

  if (circuit.state === STATES.OPEN) {
    if (Date.now() >= circuit.trippedUntil) {
      circuit.state = STATES.HALF_OPEN;
      return true; // Allow one test/probe request
    }
    return false; // Still cooling down, skip account
  }

  if (circuit.state === STATES.HALF_OPEN) {
    return true;
  }

  return true;
}

/**
 * Records a successful request for this account
 */
export function recordSuccess(connectionId, { latencyMs } = {}) {
  if (!connectionId) return;
  const circuit = getOrCreateCircuit(connectionId);

  circuit.state = STATES.CLOSED;
  circuit.consecutiveFailures = 0;
  circuit.trippedUntil = 0;
  circuit.totalRequests++;

  if (typeof latencyMs === "number" && latencyMs >= 0) {
    circuit.recentLatencies.push(latencyMs);
    if (circuit.recentLatencies.length > LATENCY_WINDOW_SIZE) {
      circuit.recentLatencies.shift();
    }
    const sum = circuit.recentLatencies.reduce((acc, l) => acc + l, 0);
    circuit.averageLatencyMs = Math.round(sum / circuit.recentLatencies.length);
  }
}

/**
 * Records a failed request (429 / 5xx) for this account
 */
export function recordFailure(connectionId, { status, error } = {}) {
  if (!connectionId) return;
  if (!isTripWorthyError(status)) {
    return;
  }

  const circuit = getOrCreateCircuit(connectionId);
  circuit.consecutiveFailures++;
  circuit.totalRequests++;
  circuit.totalFailures++;

  const threshold = getFailureThreshold();
  const cooldownMs = getCooldownMs();

  if (circuit.state === STATES.HALF_OPEN || circuit.consecutiveFailures >= threshold) {
    circuit.state = STATES.OPEN;
    circuit.trippedUntil = Date.now() + cooldownMs;
    console.warn(`[CircuitBreaker] ⚡ Account ${connectionId} TRIPPED (OPEN) for ${Math.round(cooldownMs / 1000)}s due to status ${status || error}`);
  }
}

/**
 * Returns health summary for an account
 */
export function getAccountHealth(connectionId) {
  if (!connectionId) return null;
  const circuit = getOrCreateCircuit(connectionId);
  return {
    connectionId,
    state: circuit.state,
    isAvailable: isAccountAvailable(connectionId),
    consecutiveFailures: circuit.consecutiveFailures,
    averageLatencyMs: circuit.averageLatencyMs,
    trippedUntil: circuit.trippedUntil,
    cooldownRemainingMs: Math.max(0, circuit.trippedUntil - Date.now()),
  };
}

/**
 * Resets all circuit breaker states (for tests or manual reset)
 */
export function resetCircuitBreaker() {
  accountCircuits.clear();
}

/**
 * Overrides account circuit state (used in testing or manual overrides)
 */
export function setAccountCircuitState(connectionId, { state, trippedUntil } = {}) {
  if (!connectionId) return;
  const circuit = getOrCreateCircuit(connectionId);
  if (state) circuit.state = state;
  if (trippedUntil !== undefined) circuit.trippedUntil = trippedUntil;
}

/**
 * Returns overall statistics for all tracked accounts
 */
export function getCircuitBreakerStats() {
  const result = [];
  for (const [id, circuit] of accountCircuits.entries()) {
    result.push({
      connectionId: id,
      state: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures,
      averageLatencyMs: circuit.averageLatencyMs,
      totalRequests: circuit.totalRequests,
      totalFailures: circuit.totalFailures,
      trippedUntil: circuit.trippedUntil,
    });
  }
  return result;
}

export { STATES };
