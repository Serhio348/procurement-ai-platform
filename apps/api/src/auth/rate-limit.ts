/**
 * Sliding-window rate limiter for the public auth endpoints (R38).
 * Keys are caller-chosen (per-IP, per-account); each key keeps only the
 * timestamps still inside its window, so the map stays bounded by live
 * traffic rather than by total distinct keys seen.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Registers an attempt. Returns the retry delay in milliseconds when the
   * window is already full, or 0 when the attempt is allowed.
   */
  hit(key: string, limit: number, windowMs: number): number {
    const now = this.now();
    const cutoff = now - windowMs;
    const entries = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (entries.length >= limit) {
      this.hits.set(key, entries);
      return entries[0]! + windowMs - now;
    }
    entries.push(now);
    this.hits.set(key, entries);
    this.sweep(cutoff);
    return 0;
  }

  /** Drops a key — a successful sign-in should not inherit earlier misses. */
  clear(key: string): void {
    this.hits.delete(key);
  }

  private sweep(cutoff: number): void {
    if (this.hits.size < 4096) return;
    for (const [key, entries] of this.hits) {
      if (entries.length === 0 || entries[entries.length - 1]! <= cutoff) {
        this.hits.delete(key);
      }
    }
  }
}
