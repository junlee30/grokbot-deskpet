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
