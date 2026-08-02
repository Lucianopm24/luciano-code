const DEFAULT_LIMIT = 35;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 70_000;

export class RateLimitProtectionError extends Error {
  constructor({ retryAfterMs, limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS } = {}) {
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1_000));
    super(`Rate Limit Protection: wait ${retryAfterSeconds} seconds before sending more NVIDIA NIM requests.`);
    this.name = 'RateLimitProtectionError';
    this.code = 'NVIDIA_RATE_LIMIT_PROTECTION';
    this.retryAfterMs = retryAfterMs;
    this.retryAfterSeconds = retryAfterSeconds;
    this.limit = limit;
    this.windowMs = windowMs;
  }
}

export class RequestRateLimiter {
  constructor({
    limit = DEFAULT_LIMIT,
    windowMs = DEFAULT_WINDOW_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    now = () => Date.now(),
  } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.timestamps = [];
    this.blockedUntil = 0;
  }

  prune(now = this.now()) {
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((timestamp) => timestamp > cutoff);
  }

  consume() {
    const now = this.now();
    this.prune(now);

    if (now < this.blockedUntil) {
      throw new RateLimitProtectionError({
        retryAfterMs: this.blockedUntil - now,
        limit: this.limit,
        windowMs: this.windowMs,
      });
    }

    if (this.timestamps.length >= this.limit) {
      this.blockedUntil = now + this.cooldownMs;
      throw new RateLimitProtectionError({
        retryAfterMs: this.cooldownMs,
        limit: this.limit,
        windowMs: this.windowMs,
      });
    }

    this.timestamps.push(now);
    return this.status();
  }

  status() {
    const now = this.now();
    this.prune(now);
    return {
      count: this.timestamps.length,
      limit: this.limit,
      remaining: Math.max(0, this.limit - this.timestamps.length),
      blocked: now < this.blockedUntil,
      retryAfterMs: Math.max(0, this.blockedUntil - now),
      retryAfterSeconds: Math.max(0, Math.ceil(Math.max(0, this.blockedUntil - now) / 1_000)),
      windowMs: this.windowMs,
    };
  }

  reset() {
    this.timestamps = [];
    this.blockedUntil = 0;
  }
}

export const globalNvidiaRequestLimiter = new RequestRateLimiter();

export function consumeNvidiaRequest() {
  return globalNvidiaRequestLimiter.consume();
}

export function getNvidiaRequestRateLimitStatus() {
  return globalNvidiaRequestLimiter.status();
}
