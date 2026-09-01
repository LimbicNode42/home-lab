// Shared polling/rate-limit helpers for read-only connectors.
// These enforce bounded polling and connector-local rate limiting without
// mutating any upstream state. All state is in-memory and cursor-safe.

const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_RUNTIME_MS = 30000;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function resolveLimits(limits = {}) {
  return {
    max_messages: clamp(Number(limits.max_messages ?? DEFAULT_MAX_MESSAGES) || DEFAULT_MAX_MESSAGES, 1, 1000),
    max_runtime_ms: clamp(Number(limits.max_runtime_ms ?? DEFAULT_MAX_RUNTIME_MS) || DEFAULT_MAX_RUNTIME_MS, 100, 300000)
  };
}

// Simple fixed-interval limiter: enforces a minimum wall-clock gap between
// upstream fetches. Not a leaky-bucket token model; adequate for the low-rate
// polling phase-1 connectors and easy to reason about in health output.
export class FixedIntervalLimiter {
  constructor({ minIntervalMs = 1000, now = () => Date.now() } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.lastAttemptAt = null;
  }

  // Milliseconds to wait before the next fetch is allowed (0 if ready now).
  delayUntilReadyMs() {
    if (this.lastAttemptAt == null) return 0;
    const elapsed = this.now() - this.lastAttemptAt;
    return Math.max(0, this.minIntervalMs - elapsed);
  }

  async waitUntilReady() {
    const delay = this.delayUntilReadyMs();
    if (delay > 0) await sleep(delay);
    this.lastAttemptAt = this.now();
  }

  // Record a fetch attempt without sleeping (used when a fetch already ran).
  recordAttempt() {
    this.lastAttemptAt = this.now();
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounds a sync pass by wall-clock time. Throws/aborts are handled by the
// caller (IngestService already catches and reports structured errors).
export function startRuntimeClock(maxRuntimeMs, now = () => Date.now()) {
  const start = now();
  return {
    expired() {
      return now() - start >= maxRuntimeMs;
    },
    remainingMs() {
      return Math.max(0, maxRuntimeMs - (now() - start));
    }
  };
}