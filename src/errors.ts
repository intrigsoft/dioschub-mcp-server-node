const REAUTH_BRAND = Symbol.for('dioschub.mcp-server.ReauthRequired');

/**
 * Throw from a tool handler when the upstream app refused the bound credential
 * (it expired early, the user logged out and back in, it was revoked) BEFORE
 * the handler changed anything.
 *
 * The framework then drops this bound session and answers the call with HTTP
 * 401 instead of a tool result. The Hub treats a 401 as "never sent": it asks
 * the host app to re-bind and runs the same call again with the fresh
 * credential. Because of that re-run, throw this only when the upstream
 * refused the request outright. If a multi-step handler already wrote
 * something, return an ordinary error instead.
 *
 * `message` goes to the server log only, never to the Hub or the model, so
 * keep credentials out of it.
 */
export class ReauthRequired extends Error {
  readonly [REAUTH_BRAND] = true;

  constructor(message = 'the upstream app rejected the bound credential') {
    super(message);
    this.name = 'ReauthRequired';
  }

  /** True for a ReauthRequired, including one from another copy of this package. */
  static is(err: unknown): err is ReauthRequired {
    return (
      err instanceof ReauthRequired ||
      (typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[REAUTH_BRAND] === true)
    );
  }
}

/**
 * Thrown by the file helpers when the call carries no
 * `_meta["dioschub/fileAccess"]` token (an older Hub, a call outside a chat
 * session, or a session-less call). The helpers never fall back to sending the
 * session id alone: that legacy path is deprecated on the Hub.
 */
export class FileAccessTokenMissing extends Error {
  constructor() {
    super('this tool call carries no file access token (_meta["dioschub/fileAccess"]); the Hub did not grant file access for it');
    this.name = 'FileAccessTokenMissing';
  }
}

/**
 * Thrown when the Hub refuses or fails a file call. `status` is the HTTP status
 * (403 for an invalid or expired token, a mismatched session, a session that is
 * no longer live, or a server no longer attached; 404 for an unknown file;
 * 413/415 for a refused upload). `code` is the Hub's `code` field when it sent
 * one. The message never contains the token.
 */
export class FileAccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly operation: 'fetch' | 'upload',
  ) {
    super(`Hub refused file ${operation} with ${status}${code ? ` (${code})` : ''}`);
    this.name = 'FileAccessError';
  }
}
