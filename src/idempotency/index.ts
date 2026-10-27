import { createHash } from 'node:crypto';
import type { CallToolResult } from '../result.js';
import type { IdempotencyStore } from './idempotency-store.js';

export { MemoryIdempotencyStore } from './memory-idempotency-store.js';
export { RedisIdempotencyStore } from './redis-idempotency-store.js';
export type {
  IdempotencyRedisLike,
  RedisIdempotencyStoreOptions,
} from './redis-idempotency-store.js';
export type { IdempotencyEntry, IdempotencyStore } from './idempotency-store.js';

/** `tools/call` `params._meta` key carrying the idempotency key. */
export const IDEMPOTENCY_META_KEY = 'dioschub/idempotencyKey';
/** `capabilities.experimental` entry advertised on initialize. */
export const IDEMPOTENCY_CAPABILITY = 'dioschub/idempotency';

export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 3600;
export const DEFAULT_IDEMPOTENCY_WAIT_MS = 30_000;
const MAX_KEY_LENGTH = 256;
const POLL_MS = 25;

export interface IdempotencyConfig {
  /** Where entries live. Default: in-process MemoryIdempotencyStore. */
  store?: IdempotencyStore;
  /** Entry lifetime (running and done), seconds. Default: 3600. */
  ttlSeconds?: number;
  /** How long a duplicate of a running call waits before IN_PROGRESS. Default: 30000. */
  waitMs?: number;
}

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH;
}

/** Coded error result. Same shape for IN_PROGRESS and INVALID_IDEMPOTENCY_KEY. */
export function codedError(code: string, message: string): CallToolResult {
  const structuredContent = { success: false, code, message };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/**
 * Opaque digest of (connectionId, tool, key). The connectionId comes from the
 * verified session, never the request body. Hashing keeps delimiters from
 * colliding scopes and keeps raw ids out of the store's keys.
 */
export function idempotencyScope(connectionId: string, tool: string, key: string): string {
  return createHash('sha256').update(JSON.stringify([connectionId, tool, key])).digest('hex');
}

export const IN_PROGRESS_MESSAGE =
  'the call with this idempotency key is still running; its outcome is not known yet';

/**
 * Run `execute` at most once per scope. `execute` must not throw (it returns an
 * error result instead), so a failure is a finished call, never a re-run.
 */
export async function runDeduplicated(
  store: IdempotencyStore,
  scope: string,
  opts: { ttlSeconds: number; waitMs: number; signal?: AbortSignal; onStoreError?: (err: unknown) => void },
  execute: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    if (await store.claim(scope, opts.ttlSeconds)) {
      const result = await execute();
      try {
        await store.complete(scope, result, opts.ttlSeconds);
      } catch (err) {
        // The entry stays `running` until its TTL: a duplicate gets IN_PROGRESS, never a re-run.
        opts.onStoreError?.(err);
      }
      return result;
    }
    const entry = await store.get(scope);
    if (entry?.state === 'done') return entry.result;
    if (entry === null) continue; // expired between claim and get: claim again
    if (Date.now() >= deadline || opts.signal?.aborted) {
      return codedError('IN_PROGRESS', IN_PROGRESS_MESSAGE);
    }
    await new Promise<void>((r) => setTimeout(r, Math.min(POLL_MS, Math.max(1, deadline - Date.now()))));
  }
}
