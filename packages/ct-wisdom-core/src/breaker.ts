/**
 * breaker.ts — circuit breaker for the CT subprocess (port of the Hermes
 * `_Breaker`). After BREAKER_FAILS consecutive failures the breaker opens for
 * BREAKER_PAUSE_MS: live delivery stops attempting spawns, and the user-turn
 * path degrades to a silent no-op (never an error surfaced to the host).
 */

import { BREAKER_FAILS, BREAKER_PAUSE_MS } from './constants.js';

export class Breaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly fails: number = BREAKER_FAILS,
    private readonly pauseMs: number = BREAKER_PAUSE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True while the breaker is open (pausing after repeated failures). */
  isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (this.now() - this.openedAt >= this.pauseMs) {
      // Pause elapsed: half-open — allow one attempt by closing again.
      this.openedAt = null;
      this.failures = 0;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    if (this.openedAt !== null) return; // already open; wait out the pause
    this.failures += 1;
    if (this.failures >= this.fails) {
      this.openedAt = this.now();
    }
  }

  /** Test/diagnostic reset. */
  reset(): void {
    this.failures = 0;
    this.openedAt = null;
  }
}
