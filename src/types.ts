import type { z } from 'zod';
import type { ArtifactStore } from './store/artifact-store.js';
import type { Logger } from './logger.js';
import type { HubBinder } from './hub-client.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { IdempotencyConfig } from './idempotency/index.js';

/**
 * A bound session: the opaque native auth artifacts the app handed us at /bind,
 * plus the Hub connection they belong to. The framework NEVER parses `artifacts`
 * — it stashes them verbatim and replays them verbatim into the tool context.
 *
 * `TAuth` is the app's own artifact shape. The framework is generic (and blind)
 * over it; only the concrete MCP server's tool authors know what's inside.
 */
export interface BoundSession<TAuth> {
  connectionId: string;
  artifacts: TAuth;
}

/**
 * Non-credential context the Hub sends with every tool call in `_meta`. Every
 * field is optional: an older Hub, or a call made outside a chat turn, may
 * omit any of them.
 *
 * These are hints for resolving what the user means ("the patient on screen"),
 * NOT authorization. The request body carries them, so always check access
 * with `ctx.auth` against the upstream app.
 */
export interface CallContext {
  /**
   * The page the user was on when the turn started, as the host app reported
   * it. It is not updated if the user navigates while the turn runs.
   */
  currentPath?: string;
  /** The Hub user the call runs for. */
  userId?: string;
  tenantId?: string;
  /** The Hub chat session. Stable across the turns of one conversation. */
  sessionId?: string;
  threadId?: string;
}

/**
 * What every tool handler receives as its second argument. Business args come
 * first (validated against the tool's zod schema); this is everything else.
 */
export interface ToolContext<TAuth> {
  /** The opaque native artifacts, replayed exactly as the app sent them. */
  auth: TAuth;
  /** Which Hub connection this call is bound to — useful for correlation. */
  connectionId: string;
  /** The Hub's call context (current page, user, session). Hints, not authorization. */
  call: CallContext;
  /**
   * The call's raw `params._meta`, read-only, for keys `call` does not model
   * (including `dioschub/*` extensions). Empty when the Hub sent none.
   */
  meta: Readonly<Record<string, unknown>>;
  /** Redaction-aware logger scoped to this tool + connection. Never logs `auth`. */
  logger: Logger;
  /** Aborts when the caller disconnects. Honor at the next boundary (drain-over-abort). */
  signal: AbortSignal;
  /**
   * Set only when the call carries a **test** handle (see `testUsers`): which
   * test user it runs as and whether that user is read only. Absent on every
   * call with a real handle.
   */
  test?: TestCallContext;
}

/** `ctx.test` on a call made with a test handle. */
export interface TestCallContext {
  /** The test user's `key`, as in the test users list. */
  readonly userKey: string;
  /** True when the entry is read only: only `readOnlyHint: true` tools run. */
  readonly readOnly: boolean;
}

/**
 * One entry of the test users list (the `DIOSC_TEST_USERS` variable).
 * `credentials` is the private part: any shape your `login` script needs. It
 * never leaves this process.
 */
export interface TestUserEntry {
  /** Stable id, `^[a-z0-9][a-z0-9._-]{0,63}$`, unique in the list. */
  key: string;
  /** Shown to the admin. 1 to 100 characters. */
  name: string;
  /** Shown to the admin. Up to 200 characters. */
  note?: string;
  /** Only tools annotated `readOnlyHint: true` run for this user. */
  readOnly?: boolean;
  /** The private part, handed only to `login`. */
  credentials: unknown;
}

/** The public part of an entry: what the Hub (and the admin) sees. */
export type PublicTestUser = Omit<TestUserEntry, 'credentials'>;

/** The third argument of `testUsers.login`. */
export interface TestUserLoginContext {
  /** Scoped to this test user. Never log `credentials` with it. */
  logger: Logger;
  /** Aborts when the Hub hangs up on the test-bind request. */
  signal: AbortSignal;
}

/** What `testUsers.login` returns: what a real `/bind` would have carried. */
export interface TestUserLoginResult<TAuth> {
  /** The native auth artifacts, stored and replayed into `ctx.auth` as on a real bind. */
  auth: TAuth;
  /** The identity the app would assert at bind. */
  identity: BindIdentity;
}

export type TestUserEventType =
  | 'test-login'
  | 'test-login-failed'
  | 'test-call'
  | 'test-call-refused'
  | 'test-unbind';

/**
 * Audit event for `testUsers.onEvent`. Never carries credentials or the handle.
 * `reason` is one of the framework's fixed codes, never an upstream message.
 */
export interface TestUserEvent {
  type: TestUserEventType;
  userKey: string;
  /** ISO 8601 time the event happened. */
  at: string;
  /** The tool, for `test-call` and `test-call-refused`. */
  tool?: string;
  /**
   * Why, for `test-login-failed` (`unknown_test_user`, `login_failed`,
   * `invalid_login_result`, `store_failed`, `hub_delivery_failed`) and
   * `test-call-refused` (`read_only`).
   */
  reason?: string;
}

/**
 * Test users: accounts the Hub's admin can sign in as, to test this server's
 * tools as a real user would. See the README section "Test users".
 */
export interface TestUsersConfig<TAuth> {
  /**
   * The list, as JSON text or already parsed. Default: `process.env[env]`.
   * Unset, empty, or `[]`: the feature is off.
   */
  users?: string | TestUserEntry[];
  /** Name of the environment variable holding the list. Default `DIOSC_TEST_USERS`. */
  env?: string;
  /**
   * Your script: sign in to the real auth service with the entry's
   * `credentials`. Throw when the sign-in fails; the error is not logged or
   * sent anywhere (the Hub gets `test_login_failed`), so log what you need
   * yourself, without the credentials.
   */
  login(
    credentials: unknown,
    entry: PublicTestUser,
    ctx: TestUserLoginContext,
  ): Promise<TestUserLoginResult<TAuth>>;
  /** Optional audit hook. A hook that throws or rejects is logged and ignored. */
  onEvent?(event: TestUserEvent): void | Promise<void>;
  /**
   * Attempts allowed on the two ticket routes (`test-users`, `test-bind`)
   * together, per minute, per process. Default 30.
   */
  rateLimitPerMinute?: number;
}

/** A tool the concrete MCP server registers. */
export interface ToolDefinition<
  Schema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  TAuth = unknown,
> {
  name: string;
  title?: string;
  description?: string;
  /** A `z.object({...})` describing the business parameters. Omit for no-arg tools. */
  input?: Schema;
  /**
   * MCP tool annotations (`title`, `readOnlyHint`, `destructiveHint`,
   * `idempotentHint`, `openWorldHint`), listed unchanged in `tools/list`.
   * No defaults are invented: omit them and none are listed.
   */
  annotations?: ToolAnnotations;
  /**
   * The handler. Return plain data — the framework wraps it into an MCP
   * CallToolResult. Return an object with a `content` array to take full control.
   */
  handler: (args: z.infer<Schema>, ctx: ToolContext<TAuth>) => unknown | Promise<unknown>;
}

/**
 * Non-credential identity the Hub uses for role-scoped features. Optional at
 * bind (null = anonymous). Mirrors the Hub's BindIdentityDto.
 */
export interface BindIdentity {
  userId: string;
  username: string;
  role: { id: string; name: string };
}

export interface HubConfig {
  /** Base URL of the DioscHub instance, e.g. https://hub.example.com */
  url: string;
  /**
   * The admin API key (`diosc_ak_…`, scope `auth:bind`) — the same
   * server-to-server channel used for file operations. NOT the public embed key.
   */
  apiKey: string;
  /** Override the Hub bind path. Default: `/api/auth/bind`. */
  bindPath?: string;
  /** Override the Hub's test ticket check path. Default: `/api/auth/test-tickets/verify`. */
  testTicketVerifyPath?: string;
  /** Override the Hub's test bind path. Default: `/api/auth/test-bind`. */
  testBindPath?: string;
  /** Header the Hub expects the API key in. Default: `x-api-key`. */
  apiKeyHeader?: string;
  /**
   * This server's MCP instance name **as registered in the Hub** (the name on
   * the Hub's Servers page). The Hub keys per-target credentials by it, so it
   * must match exactly.
   *
   * Why it matters: without a per-target key the Hub stores our handle
   * session-wide and replays it to *every* credential-less MCP instance the
   * assistant has attached — so a handle minted for this server is handed to
   * unrelated servers too. Naming ourselves lets the Hub forward it to us
   * alone.
   *
   * Defaults to the framework's `name`, which is correct whenever the Hub
   * instance was registered under the same name (the usual case). Override it
   * when they differ.
   *
   * A Hub that predates per-target binding ignores this and falls back to the
   * session-wide behaviour, so setting it is always safe.
   */
  instanceName?: string;
}

export interface CreateMcpServerConfig<TAuth> {
  /** Server name. Also used as the JWT audience (`aud`). */
  name: string;
  version?: string;

  /**
   * Admin bind key. Authenticates the APP's call to `/bind`. This MUST be an
   * admin-scoped key — an embed key here is a misconfiguration and is rejected
   * with 403, never a downstream opaque failure.
   */
  adminKey: string;

  /**
   * HS256 secret(s) that sign the handle-JWT. The first signs; all verify — so
   * you can rotate without downtime (add the new secret at the front, drop the
   * old one a TTL later). Distinct from `adminKey` on purpose.
   */
  jwtSecrets: string | string[];

  /**
   * How the framework reaches the Hub to bind (server-to-server). Provide this,
   * or `hubClient` for a custom binder. One of the two is required.
   */
  hub?: HubConfig;

  /** Bring your own Hub binder (custom retry/transport, or a test fake). */
  hubClient?: HubBinder;

  /** Where bound sessions live. Default: in-process MemoryArtifactStore. */
  store?: ArtifactStore<TAuth>;

  /** Lifetime of a bound session and its JWT, in seconds. Default: 8h. */
  ttlSeconds?: number;

  /** Replace the default stderr logger. */
  logger?: Logger;

  /** Mount prefix for the framework's routes. Default: '' (routes at /bind, /mcp). */
  basePath?: string;

  /**
   * Scan tool results for leaked artifact values and scream if found.
   * Default: on unless NODE_ENV === 'production'.
   */
  devGuard?: boolean;

  /**
   * Duplicate-call protection. On by default: a `tools/call` carrying
   * `params._meta["dioschub/idempotencyKey"]` runs its handler once per
   * (connection, tool, key); duplicates get the first call's result. The
   * `dioschub/idempotency` capability is advertised on initialize. Pass `false`
   * to turn it off (no capability, no dedup). Use a `RedisIdempotencyStore`
   * for more than one replica.
   */
  idempotency?: false | IdempotencyConfig;

  /**
   * Test users the Hub's admin can sign in as (off by default). On only when
   * this is set, the list has at least one entry, and the Hub client can make
   * the test calls (`hub` config, or a `hubClient` with `verifyTestTicket` and
   * `testBind`). The list is checked at start-up; a bad list throws
   * `TestUsersConfigError`. See the README section "Test users".
   */
  testUsers?: TestUsersConfig<TAuth>;
}
