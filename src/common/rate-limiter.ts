// Tiny in-memory sliding-window rate limiter.
//
// Scope: anti-spam guard for sensitive endpoints (OTP send, follow
// action) before more sophisticated infra (Redis, edge-rate-limiter)
// is wired in. Per-process state — fine for a single-replica Railway
// deployment; under N replicas the effective limit becomes N×limit
// because each replica tracks independently. That's documented as
// acceptable for the demo + early scale.
//
// Implementation: keyed map of timestamps. On every check we drop
// timestamps older than `windowMs`, count what remains, accept iff
// count < `max`. Memory grows with active keys — for the surfaces
// we use this on (per-phone, per-userId) the natural churn keeps it
// bounded. We also cap the array per key at `max` to defend against
// pathological flooding.

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  // Returns true if the action is allowed AND records the hit.
  // Returns false if the limit was already reached in the current
  // window — caller should reject.
  hit(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const list = this.hits.get(key) ?? [];
    // Drop expired hits.
    const recent = list.filter((t) => t > cutoff);
    if (recent.length >= this.max) {
      // Save the trimmed list back so memory doesn't accumulate.
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  // Remaining allowance in the current window. Useful for a
  // "Retry-After" header or a soft frontend warning.
  remaining(key: string): number {
    const cutoff = Date.now() - this.windowMs;
    const list = this.hits.get(key) ?? [];
    return Math.max(0, this.max - list.filter((t) => t > cutoff).length);
  }
}
