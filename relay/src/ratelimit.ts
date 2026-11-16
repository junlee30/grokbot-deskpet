/** Simple token bucket keyed by an opaque string (token hash or client IP). */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perMs: number;
  private readonly burst: number;
  private readonly now: () => number;

  constructor(perMin: number, burst: number, now: () => number) {
    this.perMs = perMin / 60_000;
    this.burst = Math.max(1, burst);
    this.now = now;
  }

  /** Returns 0 if allowed, otherwise the number of seconds to wait. */
  take(key: string): number {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + (t - b.at) * this.perMs);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    if (this.perMs <= 0) return 60;
    return Math.max(1, Math.ceil((1 - b.tokens) / this.perMs / 1000));
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }

  /** Drop full buckets so the map can't grow without bound. */
  sweep(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.at) * this.perMs >= this.burst) this.buckets.delete(k);
    }
  }
}

/**
 * Global brake on failed pairing-code redemptions, across all client IPs. Once `max` failures
 * land inside `windowMs`, every redemption gets 429 for `lockMs` (per-IP limits alone don't
 * stop a distributed brute force against the 31^6 code space).
 */
export class GlobalFailureLock {
  private failures: number[] = [];
  private lockedUntil = 0;
  private readonly max: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, lockMs: number, now: () => number) {
    this.max = Math.max(1, max);
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    this.now = now;
  }

  /** Seconds until the lock lifts, or 0 if not locked. */
  locked(): number {
    const left = this.lockedUntil - this.now();
    return left > 0 ? Math.max(1, Math.ceil(left / 1000)) : 0;
  }

  fail(): void {
    const t = this.now();
    this.failures.push(t);
    while (this.failures.length && this.failures[0]! <= t - this.windowMs) this.failures.shift();
    if (this.failures.length >= this.max) {
      this.lockedUntil = t + this.lockMs;
      this.failures = [];
    }
  }
}
