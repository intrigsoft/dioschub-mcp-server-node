import { AsyncLocalStorage } from 'node:async_hooks';
import type { BoundSession } from './types.js';

/**
 * Carries the resolved session from the HTTP layer (where the JWT is verified
 * and the store is read) down into the MCP tool handler, without threading it
 * through the SDK's transport. Because transport is connect-per-call, each HTTP
 * request runs the whole MCP exchange inside one `run()`.
 */
export interface RequestContext<TAuth> {
  /** Null for non-tool requests (initialize, tools/list) that need no auth. */
  session: BoundSession<TAuth> | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext<unknown>>();
