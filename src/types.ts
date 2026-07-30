import type { z } from 'zod';
import type { ArtifactStore } from './store/artifact-store.js';
import type { Logger } from './logger.js';
import type { HubBinder } from './hub-client.js';

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
 * What every tool handler receives as its second argument. Business args come
 * first (validated against the tool's zod schema); this is everything else.
 */
export interface ToolContext<TAuth> {
  /** The opaque native artifacts, replayed exactly as the app sent them. */
  auth: TAuth;
  /** Which Hub connection this call is bound to — useful for correlation. */
  connectionId: string;
  /** Redaction-aware logger scoped to this tool + connection. Never logs `auth`. */
  logger: Logger;
  /** Aborts when the caller disconnects. Honor at the next boundary (drain-over-abort). */
  signal: AbortSignal;
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
}
