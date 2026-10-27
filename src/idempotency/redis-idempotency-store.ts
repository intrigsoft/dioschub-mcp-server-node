import type { CallToolResult } from '../result.js';
import type { IdempotencyEntry, IdempotencyStore } from './idempotency-store.js';

/**
 * Minimal slice of the ioredis client this store needs, declared structurally
 * (`ioredis` is an optional dependency). A real ioredis client satisfies it.
 */
export interface IdempotencyRedisLike {
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface RedisIdempotencyStoreOptions {
  /** A connection URL, e.g. redis://localhost:6379. Ignored if `client` is given. */
  url?: string;
  /** Bring your own ioredis client (or anything IdempotencyRedisLike). Takes precedence. */
  client?: IdempotencyRedisLike;
  /** Key namespace. Default: `diosc:mcp:idem:`. */
  keyPrefix?: string;
}

/**
 * Redis-backed store: the choice for more than one replica. The claim is a single
 * `SET … NX EX`, so exactly one replica wins; every write carries the TTL, so a
 * crashed run's key keeps answering IN_PROGRESS until it expires.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly prefix: string;
  private client: IdempotencyRedisLike | undefined;
  private ready: Promise<IdempotencyRedisLike> | undefined;

  constructor(private readonly options: RedisIdempotencyStoreOptions) {
    this.prefix = options.keyPrefix ?? 'diosc:mcp:idem:';
    this.client = options.client;
  }

  /** Lazily construct the ioredis client so the dep is only needed at runtime. */
  private async connection(): Promise<IdempotencyRedisLike> {
    if (this.client) return this.client;
    if (!this.ready) {
      this.ready = (async () => {
        if (!this.options.url) {
          throw new Error('RedisIdempotencyStore requires either `client` or `url`');
        }
        const mod = await import('ioredis').catch(() => {
          throw new Error(
            'RedisIdempotencyStore needs the optional dependency "ioredis". Install it, or pass your own `client`.',
          );
        });
        const Redis = (mod as unknown as { default: new (url: string) => IdempotencyRedisLike }).default;
        this.client = new Redis(this.options.url);
        return this.client;
      })();
    }
    return this.ready;
  }

  async claim(scope: string, ttlSeconds: number): Promise<boolean> {
    const redis = await this.connection();
    const reply = await redis.set(
      this.prefix + scope,
      JSON.stringify({ state: 'running' } satisfies IdempotencyEntry),
      'EX',
      ttlSeconds,
      'NX',
    );
    return reply === 'OK';
  }

  async get(scope: string): Promise<IdempotencyEntry | null> {
    const redis = await this.connection();
    const raw = await redis.get(this.prefix + scope);
    return raw === null ? null : (JSON.parse(raw) as IdempotencyEntry);
  }

  async complete(scope: string, result: CallToolResult, ttlSeconds: number): Promise<void> {
    const redis = await this.connection();
    await redis.set(
      this.prefix + scope,
      JSON.stringify({ state: 'done', result } satisfies IdempotencyEntry),
      'EX',
      ttlSeconds,
    );
  }

  async close(): Promise<void> {
    if (this.client) await this.client.quit();
  }
}
