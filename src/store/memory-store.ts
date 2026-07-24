import type { BoundSession } from '../types.js';
import type { ArtifactStore } from './artifact-store.js';

interface Entry<TAuth> {
  session: BoundSession<TAuth>;
  expiresAt: number;
}

/**
 * In-process store. Fine for a single instance and local development. NOT safe
 * across replicas — a restart or a second replica means a JWT minted here won't
 * resolve, which (correctly) yields a 401 and a re-bind, but every user re-binds
 * on deploy. Use RedisArtifactStore for anything horizontally scaled.
 */
export class MemoryArtifactStore<TAuth> implements ArtifactStore<TAuth> {
  private readonly entries = new Map<string, Entry<TAuth>>();
  private readonly sweep: NodeJS.Timeout;

  constructor(sweepIntervalMs = 60_000) {
    this.sweep = setInterval(() => this.evictExpired(), sweepIntervalMs);
    // Don't keep the event loop alive just for the sweeper.
    this.sweep.unref?.();
  }

  async put(jti: string, session: BoundSession<TAuth>, ttlSeconds: number): Promise<void> {
    this.entries.set(jti, { session, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async get(jti: string): Promise<BoundSession<TAuth> | null> {
    const entry = this.entries.get(jti);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(jti);
      return null;
    }
    return entry.session;
  }

  async delete(jti: string): Promise<void> {
    this.entries.delete(jti);
  }

  async close(): Promise<void> {
    clearInterval(this.sweep);
    this.entries.clear();
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [jti, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(jti);
    }
  }
}
