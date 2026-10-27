import type { CallToolResult } from '../result.js';
import type { IdempotencyEntry, IdempotencyStore } from './idempotency-store.js';

const SWEEP_EVERY_MS = 60_000;

/** In-process store. Correct for a single replica; use Redis for more than one. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { entry: IdempotencyEntry; expiresAt: number }>();
  private lastSweep = Date.now();

  private live(scope: string): IdempotencyEntry | null {
    const hit = this.entries.get(scope);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(scope);
      return null;
    }
    return hit.entry;
  }

  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    for (const [scope, hit] of this.entries) if (hit.expiresAt <= now) this.entries.delete(scope);
  }

  async claim(scope: string, ttlSeconds: number): Promise<boolean> {
    this.sweep();
    // Single-threaded: check-and-set with no await between is atomic.
    if (this.live(scope)) return false;
    this.entries.set(scope, { entry: { state: 'running' }, expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async get(scope: string): Promise<IdempotencyEntry | null> {
    return this.live(scope);
  }

  async complete(scope: string, result: CallToolResult, ttlSeconds: number): Promise<void> {
    this.entries.set(scope, {
      entry: { state: 'done', result },
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }
}
