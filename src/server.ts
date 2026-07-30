import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type {
  BindIdentity,
  BoundSession,
  CreateMcpServerConfig,
  ToolContext,
  ToolDefinition,
} from './types.js';
import { defaultLogger, type Logger } from './logger.js';
import { MemoryArtifactStore } from './store/memory-store.js';
import type { ArtifactStore } from './store/artifact-store.js';
import { signHandle, verifyHandle } from './jwt.js';
import { HubClient, type HubBinder } from './hub-client.js';
import { requestContext, type RequestContext } from './context.js';
import { assertNoArtifactLeak, toCallToolResult } from './result.js';

const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

export interface DioscMcpServer<TAuth> {
  /** Register a tool. Business args are validated; `ctx.auth` is injected. */
  tool<Schema extends z.ZodObject<z.ZodRawShape>>(def: ToolDefinition<Schema, TAuth>): this;
  /** Start listening. Returns the Node http.Server. */
  listen(port: number, callback?: () => void): Server;
  /** Escape hatch: mount your own routes (health checks, etc.). */
  readonly app: Express;
}

export function createMcpServer<TAuth = unknown>(
  config: CreateMcpServerConfig<TAuth>,
): DioscMcpServer<TAuth> {
  const logger: Logger = config.logger ?? defaultLogger({ server: config.name });
  const secrets = Array.isArray(config.jwtSecrets) ? config.jwtSecrets : [config.jwtSecrets];
  if (secrets.length === 0) throw new Error('jwtSecrets must contain at least one secret');
  const signingSecret = secrets[0]!;

  const store: ArtifactStore<TAuth> = config.store ?? new MemoryArtifactStore<TAuth>();
  const ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const devGuard = config.devGuard ?? process.env.NODE_ENV !== 'production';
  const hub: HubBinder =
    config.hubClient ??
    (config.hub
      ? // Default the Hub instance name to this server's name so per-target
        // binding works out of the box: the handle is minted with `aud: name`,
        // and the Hub instance is conventionally registered under the same name.
        // Operators whose Hub instance name differs override `hub.instanceName`.
        new HubClient({ instanceName: config.name, ...config.hub }, logger)
      : (() => {
          throw new Error('createMcpServer requires either `hub` config or a `hubClient`');
        })());

  const base = (config.basePath ?? '').replace(/\/+$/, '');
  const bindPath = base + '/bind';
  const mcpPath = base + '/mcp';

  const tools: ToolDefinition<z.ZodObject<z.ZodRawShape>, TAuth>[] = [];

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // ── /bind ──────────────────────────────────────────────────────────────────
  // The APP calls this (server-to-server) with the Hub connectionId + its native
  // auth artifacts, authenticated by the admin key. We mint a handle-JWT, stash
  // the artifacts under its jti, and bind the JWT to the Hub connection.
  app.post(bindPath, async (req: Request, res: Response) => {
    const presented = bearer(req) ?? req.header('x-admin-key');
    if (presented !== config.adminKey) {
      // 403, not 401: the caller authenticated but isn't authorized to bind.
      // This is the "embed key where an admin key was required" trap — caught
      // here, loudly, instead of failing opaquely downstream.
      logger.warn('bind rejected: bad admin key');
      send(res, 403, { error: 'forbidden', code: 'admin_key' });
      return;
    }

    const body = req.body as {
      connectionId?: unknown;
      artifacts?: unknown;
      identity?: BindIdentity | null;
    };
    if (typeof body?.connectionId !== 'string' || body.artifacts === undefined) {
      send(res, 400, {
        error: 'bad_request',
        code: 'missing_fields',
        detail: 'connectionId and artifacts are required',
      });
      return;
    }

    const jti = randomUUID();
    const session: BoundSession<TAuth> = {
      connectionId: body.connectionId,
      artifacts: body.artifacts as TAuth,
    };

    try {
      await store.put(jti, session, ttlSeconds);
      const token = await signHandle({ jti, aud: config.name }, signingSecret, ttlSeconds);
      // connectionId is the Hub wsId; identity is optional non-credential metadata.
      await hub.bind(body.connectionId, token, body.identity ?? null);
      logger.info('bound session', { connectionId: body.connectionId });
      send(res, 200, { ok: true });
    } catch (err) {
      // Roll back the store entry so a failed Hub bind doesn't leak a session.
      await store.delete(jti).catch(() => undefined);
      logger.error('bind failed', { error: (err as Error).message });
      send(res, 502, { error: 'bind_failed', code: 'hub_unreachable' });
    }
  });

  // ── /mcp ─────────────────────────────────────────────────────────────────────
  // Every protocol request. For tools/call we resolve auth up front so a store
  // miss becomes a clean 401 (→ Hub re-auth), never a 500. Other methods
  // (initialize, tools/list) need no auth and pass straight through.
  app.post(mcpPath, async (req: Request, res: Response) => {
    const body = req.body as { method?: string } | undefined;
    let session: BoundSession<TAuth> | null = null;

    if (body?.method === 'tools/call') {
      const tool = toolName(body);
      const token = bearer(req);
      if (!token) {
        // The Hub sent no bearer. Almost always a Hub-side config issue: the MCP
        // instance isn't a credential-less "conduit" (it has static authConfig), so
        // the Hub drops the per-user handle instead of forwarding it. Logged because
        // the wire answer (401) is otherwise silent and this is hard to diagnose.
        logger.warn('tools/call rejected: no bearer token (is the Hub instance a conduit?)', { tool });
        unauthorized(res, 'missing_token');
        return;
      }

      let jti: string;
      try {
        ({ jti } = await verifyHandle(token, secrets, config.name));
      } catch (err) {
        // Surface WHY the handle failed — wrong audience, expired, bad signature —
        // by decoding (NOT verifying) its claims. This is the log that turns a
        // silent, mystifying 401 into a one-line diagnosis. Safe: the handle-JWT
        // carries only {jti, aud, exp}, never the native credential.
        logger.warn('tools/call rejected: handle failed verification', {
          tool,
          expectedAud: config.name,
          gotClaims: peekClaims(token),
          error: (err as Error).message,
        });
        unauthorized(res, 'invalid_token');
        return;
      }

      session = await store.get(jti);
      if (!session) {
        // Store miss: evicted, expired, or minted on a replica we can't see.
        // Distinguish for operators, but the wire answer is the same 401.
        logger.info('unbound tool call', { reason: 'store_miss', jti });
        unauthorized(res, 'unbound');
        return;
      }
    }

    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    const rc: RequestContext<TAuth> = { session };
    await server.connect(transport);
    await requestContext.run(rc, () => transport.handleRequest(req, res, body));
  });

  // Streamable-HTTP GET/DELETE are for stateful sessions; we run stateless.
  app.get(mcpPath, (_req, res) => {
    send(res, 405, { error: 'method_not_allowed' });
  });
  app.delete(mcpPath, (_req, res) => {
    send(res, 405, { error: 'method_not_allowed' });
  });

  // Build a fresh MCP server per request (connect-per-call) with all tools.
  function buildMcpServer(): McpServer {
    const server = new McpServer({ name: config.name, version: config.version ?? '0.0.0' });
    for (const def of tools) registerTool(server, def);
    return server;
  }

  function registerTool(
    server: McpServer,
    def: ToolDefinition<z.ZodObject<z.ZodRawShape>, TAuth>,
  ): void {
    const inputShape = def.input?.shape ?? {};
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: inputShape,
      },
      async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
        const rc = requestContext.getStore() as RequestContext<TAuth> | undefined;
        if (!rc?.session) {
          // Belt-and-braces: the HTTP layer already gated tools/call.
          throw new Error('unauthenticated tool invocation');
        }
        const ctx: ToolContext<TAuth> = {
          auth: rc.session.artifacts,
          connectionId: rc.session.connectionId,
          logger: logger.child({ tool: def.name, connectionId: rc.session.connectionId }),
          signal: extra.signal,
        };
        const result = await def.handler(args as never, ctx);
        if (devGuard) assertNoArtifactLeak(result, rc.session.artifacts, ctx.logger);
        return toCallToolResult(result);
      },
    );
  }

  const instance: DioscMcpServer<TAuth> = {
    tool(def) {
      tools.push(def as unknown as ToolDefinition<z.ZodObject<z.ZodRawShape>, TAuth>);
      return instance;
    },
    listen(port, callback) {
      return app.listen(port, callback);
    },
    app,
  };

  return instance;
}

function bearer(req: Request): string | undefined {
  const header = req.header('authorization');
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}

function toolName(body: unknown): string | undefined {
  return (body as { params?: { name?: string } } | undefined)?.params?.name;
}

/**
 * Decode — but do NOT verify — a token's JWT payload, for the auth-failure logs.
 * Never used for authorization. Returns a short, non-secret claim summary so an
 * operator can see what the Hub actually forwarded (e.g. a wrong `aud`, an expired
 * `exp`, or a non-JWT string from a misconfigured static authConfig).
 */
function peekClaims(token: string): string {
  try {
    const payload = token.split('.')[1];
    if (!payload) return '<not-a-jwt>';
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    return json.length > 200 ? json.slice(0, 200) + '…' : json;
  } catch {
    return '<unparseable>';
  }
}

function unauthorized(res: Response, code: string): void {
  res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized', code });
}

function send(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}
