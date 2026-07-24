import type { BoundSession } from '../types.js';
import type { ArtifactStore } from './artifact-store.js';

/**
 * Minimal slice of the ioredis client this store needs. Declared structurally so
 * the framework doesn't hard-depend on ioredis' types — `ioredis` is an optional
 * dependency, pulled in only when you actually run clustered.
 */
export interface RedisLike {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface RedisArtifactStoreOptions {
  /** A connection URL, e.g. redis://localhost:6379. Ignored if `client` is given. */
  url?: string;
  /** Bring your own ioredis client (or anything RedisLike). Takes precedence. */
  client?: RedisLike;
  /** Key namespace. Default: `diosc:mcp:session:`. */
  keyPrefix?: string;
}

/**
 * Redis-backed store — the production choice for multi-replica servers. A JWT
 * minted on any replica resolves on any other. Native artifacts are serialized
 * as JSON under a namespaced key with a Redis TTL matching the session TTL.
 */
export class RedisArtifactStore<TAuth> implements ArtifactStore<TAuth> {
  private readonly prefix: string;
  private client: RedisLike | undefined;
  private ready: Promise<RedisLike> | undefined;

  constructor(private readonly options: RedisArtifactStoreOptions) {
    this.prefix = options.keyPrefix ?? 'diosc:mcp:session:';
    this.client = options.client;
  }

  private key(jti: string): string {
    return this.prefix + jti;
  }

  /** Lazily construct the ioredis client so the dep is only needed at runtime. */
  private async connection(): Promise<RedisLike> {
    if (this.client) return this.client;
    if (!this.ready) {
      this.ready = (async () => {
        if (!this.options.url) {
          throw new Error('RedisArtifactStore requires either `client` or `url`');
        }
        const mod = await import('ioredis').catch(() => {
          throw new Error(
            'RedisArtifactStore needs the optional dependency "ioredis". Install it, or pass your own `client`.',
          );
        });
        const Redis = (mod as unknown as { default: new (url: string) => RedisLike }).default;
        this.client = new Redis(this.options.url);
        return this.client;
      })();
    }
    return this.ready;
  }

  async put(jti: string, session: BoundSession<TAuth>, ttlSeconds: number): Promise<void> {
    const redis = await this.connection();
    await redis.set(this.key(jti), JSON.stringify(session), 'EX', ttlSeconds);
  }

  async get(jti: string): Promise<BoundSession<TAuth> | null> {
    const redis = await this.connection();
    const raw = await redis.get(this.key(jti));
    if (raw === null) return null;
    return JSON.parse(raw) as BoundSession<TAuth>;
  }

  async delete(jti: string): Promise<void> {
    const redis = await this.connection();
    await redis.del(this.key(jti));
  }

  async close(): Promise<void> {
    if (this.client) await this.client.quit();
  }
}
