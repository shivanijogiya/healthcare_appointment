/** Trips after N consecutive failures, stays open for a cooldown, then half-opens. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (this.now() - this.openedAt >= this.cooldownMs) {
      this.openedAt = null;
      this.failures = this.threshold - 1; // half-open: one more failure re-trips
      return false;
    }
    return true;
  }

  recordSuccess() {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure() {
    this.failures += 1;
    if (this.failures >= this.threshold && this.openedAt === null) {
      this.openedAt = this.now();
    }
  }

  get state(): 'closed' | 'open' {
    return this.isOpen() ? 'open' : 'closed';
  }

  get consecutiveFailures() {
    return this.failures;
  }
}
