import type { BoundSession } from '../types.js';

/**
 * Where bound sessions live, keyed by the handle-JWT's `jti` (never the raw
 * token — a leaked store key must not be a usable bearer token).
 *
 * A `get` that returns `null` is the load-bearing signal in this framework: the
 * dispatcher turns it into an HTTP 401, which is exactly what trips the Hub's
 * mid-turn re-auth → the kit re-binds → a fresh session lands. A store miss must
 * NEVER surface as a 500.
 *
 * Swap the default in-process store for RedisArtifactStore the moment you run
 * more than one replica: a JWT minted on replica A must resolve on replica B.
 */
export interface ArtifactStore<TAuth> {
  put(jti: string, session: BoundSession<TAuth>, ttlSeconds: number): Promise<void>;
  get(jti: string): Promise<BoundSession<TAuth> | null>;
  delete(jti: string): Promise<void>;
  /** Optional cleanup hook (e.g. close a Redis connection). */
  close?(): Promise<void>;
}
