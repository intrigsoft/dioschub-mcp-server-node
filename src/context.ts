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
  /** The verified handle's jti, so a handler's ReauthRequired can drop the session. */
  jti: string | null;
  /**
   * Set when a handler threw ReauthRequired. The HTTP layer then answers 401
   * instead of the transport's tool result.
   */
  reauth?: { tool: string; message: string };
}

export const requestContext = new AsyncLocalStorage<RequestContext<unknown>>();
