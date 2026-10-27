import type { CallToolResult } from '../result.js';

/**
 * What a scope holds. `running`: a call claimed the key and has not finished
 * (it may still be running, or its process may have died: either way it is never
 * re-run until the entry expires). `done`: the finished result, success or error.
 */
export type IdempotencyEntry =
  | { state: 'running' }
  | { state: 'done'; result: CallToolResult };

/**
 * Where dedup state lives. A scope is an opaque digest of (connectionId, tool,
 * key); it never contains the bearer token or the auth artifacts, and only the
 * handler's result is ever stored.
 */
export interface IdempotencyStore {
  /** Atomically create a `running` entry. True if this caller won the claim. */
  claim(scope: string, ttlSeconds: number): Promise<boolean>;
  /** Current entry, or null if absent or expired. */
  get(scope: string): Promise<IdempotencyEntry | null>;
  /** Move the entry to `done` with the finished result. */
  complete(scope: string, result: CallToolResult, ttlSeconds: number): Promise<void>;
  close?(): Promise<void>;
}
