import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import type {
  BindIdentity,
  BoundSession,
  CallContext,
  CreateMcpServerConfig,
  TestCallContext,
  TestUserEvent,
  ToolContext,
  ToolDefinition,
} from './types.js';
import { defaultLogger, type Logger } from './logger.js';
import { MemoryArtifactStore } from './store/memory-store.js';
import type { ArtifactStore } from './store/artifact-store.js';
import { signHandle, verifyHandle } from './jwt.js';
import { HubClient, HubTestCallError, type HubBinder } from './hub-client.js';
import { requestContext, type RequestContext } from './context.js';
import { ReauthRequired } from './errors.js';
import { assertNoArtifactLeak, toCallToolResult, type CallToolResult } from './result.js';
import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  DEFAULT_IDEMPOTENCY_WAIT_MS,
  IDEMPOTENCY_CAPABILITY,
  IDEMPOTENCY_META_KEY,
  MemoryIdempotencyStore,
  codedError,
  idempotencyScope,
  isValidIdempotencyKey,
  runDeduplicated,
} from './idempotency/index.js';
import {
  AttemptLimiter,
  DEFAULT_TEST_RATE_LIMIT_PER_MINUTE,
  TEST_HANDLE_TTL_SECONDS,
  TEST_USERS_CAPABILITY,
  TestUsersConfigError,
  loadTestUsers,
  readLoginResult,
  type LoadedTestUsers,
} from './test-users.js';

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

  // The cache lives here, on the instance (or its store): buildMcpServer() makes a
  // fresh McpServer per request, so nothing request-scoped can hold dedup state.
  const idem =
    config.idempotency === false
      ? undefined
      : {
          store: config.idempotency?.store ?? new MemoryIdempotencyStore(),
          ttlSeconds: config.idempotency?.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS,
          waitMs: config.idempotency?.waitMs ?? DEFAULT_IDEMPOTENCY_WAIT_MS,
        };

  const base = (config.basePath ?? '').replace(/\/+$/, '');
  const bindPath = base + '/bind';
  const mcpPath = base + '/mcp';
  const testUsersPath = base + '/test-users';
  const testBindPath = base + '/test-bind';
  const testUnbindPath = base + '/test-unbind';

  // ── test users ─────────────────────────────────────────────────────────────
  // Checked here, at start-up, so a bad list stops the server instead of
  // failing on the admin's first click. Messages never quote the list.
  const testConfig = config.testUsers;
  let testUsers: LoadedTestUsers | null = null;
  let limiter: AttemptLimiter | null = null;
  if (testConfig !== undefined) {
    if (typeof testConfig !== 'object' || testConfig === null) {
      throw new TestUsersConfigError('testUsers must be an object');
    }
    if (typeof testConfig.login !== 'function') {
      throw new TestUsersConfigError('testUsers.login must be a function');
    }
    if (testConfig.onEvent !== undefined && typeof testConfig.onEvent !== 'function') {
      throw new TestUsersConfigError('testUsers.onEvent must be a function');
    }
    const perMinute = testConfig.rateLimitPerMinute ?? DEFAULT_TEST_RATE_LIMIT_PER_MINUTE;
    if (!Number.isInteger(perMinute) || perMinute < 1) {
      throw new TestUsersConfigError('testUsers.rateLimitPerMinute must be a positive whole number');
    }
    const loaded = loadTestUsers(testConfig);
    if (!loaded) {
      logger.info('test users off: the list is unset or empty');
    } else if (typeof hub.verifyTestTicket !== 'function' || typeof hub.testBind !== 'function') {
      logger.warn('test users off: the hub client cannot make the test calls (verifyTestTicket, testBind)');
    } else {
      testUsers = loaded;
      limiter = new AttemptLimiter(perMinute);
      logger.info('test users on', { count: loaded.publicList.length, source: loaded.source });
    }
  }

  /** Fire the audit hook. Never awaited: a slow or failing hook cannot hold a call. */
  function emit(event: Omit<TestUserEvent, 'at'>): void {
    const hook = testConfig?.onEvent;
    if (!hook) return;
    const full: TestUserEvent = { ...event, at: new Date().toISOString() };
    const report = (err: unknown) =>
      logger.error('testUsers.onEvent failed; ignored', { event: event.type, error: errorName(err) });
    try {
      const out = hook.call(testConfig, full);
      if (out && typeof (out as Promise<void>).then === 'function') (out as Promise<void>).catch(report);
    } catch (err) {
      report(err);
    }
  }

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
    let jti: string | null = null;
    let test: TestCallContext | undefined;
    let testKey: string | undefined;
    let testReadOnly = false;

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

      try {
        const verified = await verifyHandle(token, secrets, config.name);
        jti = verified.jti;
        if (verified.test === true && verified.tu !== undefined) {
          testKey = verified.tu;
          testReadOnly = verified.ro === true;
        }
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

      if (testKey !== undefined) {
        // The list is the allow-list, and it is read at start-up. A test handle
        // minted before a restart that removed the user (or the whole list)
        // stops working here, even though a shared store still holds its
        // artifacts. Read only is the stricter of the handle and today's list.
        const entry = testUsers?.byKey.get(testKey);
        if (!entry) {
          await store.delete(jti).catch(() => undefined);
          logger.warn('tools/call rejected: test user is no longer listed', { tool, testUser: testKey });
          unauthorized(res, 'unbound');
          return;
        }
        test = Object.freeze({ userKey: testKey, readOnly: testReadOnly || entry.public.readOnly === true });
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

    // JSON-response mode: the transport answers only once the handler has
    // finished, so a handler's ReauthRequired can still become an HTTP 401.
    const server = buildMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // A caller that hangs up aborts the handler (ctx.signal); nothing is written.
    const closed = new Promise<null>((resolve) => {
      res.on('close', () => {
        transport.close().catch(() => undefined);
        server.close().catch(() => undefined);
        resolve(null);
      });
    });

    const rc: RequestContext<TAuth> = { session, jti, ...(test ? { test } : {}) };
    await server.connect(transport);
    const reply = await Promise.race([
      requestContext.run(rc, () => transport.handleRequest(toWebRequest(req), { parsedBody: body })),
      closed,
    ]);
    if (reply === null || res.headersSent) return;

    if (rc.reauth) {
      // The upstream refused the credential: same wire answer as a store miss,
      // so the Hub re-binds and sends this call again.
      logger.info('tool asked for re-bind', { reason: 'upstream_rejected', ...rc.reauth });
      unauthorized(res, 'reauth_required');
      return;
    }

    res.status(reply.status);
    reply.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(Buffer.from(await reply.arrayBuffer()));
  });

  // ── test users routes ──────────────────────────────────────────────────────
  // The Hub calls these. They carry no credential header: the Hub's one-time
  // ticket is the authority, and only the Hub can judge it, so every answer
  // past the rate limit waits for the Hub's word. The handle never goes back
  // on these answers; it goes to the configured Hub URL only.

  // The Hub's list request: public parts only.
  app.post(testUsersPath, async (req: Request, res: Response) => {
    if (!testUsers) return testDisabled(res);
    if (rateLimited(res)) return;
    const ticket = stringField(req.body, 'ticket');
    if (!ticket) {
      send(res, 400, { error: 'bad_request', code: 'missing_fields', detail: 'ticket is required' });
      return;
    }
    const valid = await checkTicket(res, { ticket, purpose: 'list' }, requestSignal(res));
    if (valid === null) return;
    if (!valid) {
      logger.warn('test-users refused: invalid ticket');
      send(res, 401, { error: 'unauthorized', code: 'invalid_ticket' });
      return;
    }
    logger.info('test users listed', { count: testUsers.publicList.length });
    send(res, 200, { users: testUsers.publicList });
  });

  // The Hub's sign-in request for one test user. The handle goes to the Hub by
  // a separate call; this answer carries only the expiry.
  app.post(testBindPath, async (req: Request, res: Response) => {
    if (!testUsers || !testConfig) return testDisabled(res);
    if (rateLimited(res)) return;
    const ticket = stringField(req.body, 'ticket');
    const userKey = stringField(req.body, 'userKey');
    if (!ticket || !userKey) {
      send(res, 400, { error: 'bad_request', code: 'missing_fields', detail: 'ticket and userKey are required' });
      return;
    }
    const signal = requestSignal(res);

    // 1. The Hub vouches for the ticket and the user before anyone signs in.
    const valid = await checkTicket(res, { ticket, purpose: 'bind', userKey }, signal);
    if (valid === null) return;
    if (!valid) {
      logger.warn('test-bind refused: invalid ticket');
      send(res, 401, { error: 'unauthorized', code: 'invalid_ticket' });
      return;
    }
    const user = testUsers.byKey.get(userKey);
    if (!user) {
      logger.warn('test-bind refused: unknown test user');
      emit({ type: 'test-login-failed', userKey, reason: 'unknown_test_user' });
      send(res, 404, { error: 'not_found', code: 'unknown_test_user' });
      return;
    }
    const readOnly = user.public.readOnly === true;
    const userLogger = logger.child({ testUser: userKey });

    // 2. The author's script signs in to the real auth service. Its error is
    // not logged or answered: it may quote what it was given.
    let login: ReturnType<typeof readLoginResult<TAuth>>;
    try {
      login = readLoginResult<TAuth>(
        await testConfig.login(user.credentials, user.public, { logger: userLogger, signal }),
      );
    } catch (err) {
      userLogger.warn('test login failed', { errorType: errorName(err) });
      emit({ type: 'test-login-failed', userKey, reason: 'login_failed' });
      send(res, 502, { error: 'test_bind_failed', code: 'test_login_failed' });
      return;
    }
    if (!login) {
      userLogger.error('test login returned no auth, or an identity without userId, username and role { id, name }');
      emit({ type: 'test-login-failed', userKey, reason: 'invalid_login_result' });
      send(res, 502, { error: 'test_bind_failed', code: 'test_login_failed' });
      return;
    }

    // 3. Store as for a real user, under a fresh jti, for the fixed 60 minutes.
    const jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((now + TEST_HANDLE_TTL_SECONDS) * 1000).toISOString();
    let token: string;
    try {
      await store.put(jti, { connectionId: `test:${jti}`, artifacts: login.auth }, TEST_HANDLE_TTL_SECONDS);
      token = await signHandle(
        { jti, aud: config.name, test: true, tu: userKey, ...(readOnly ? { ro: true as const } : {}) },
        signingSecret,
        TEST_HANDLE_TTL_SECONDS,
        now,
      );
    } catch (err) {
      await dropTestSession(jti, userLogger);
      userLogger.error('test-bind: could not store the session', { errorType: errorName(err) });
      emit({ type: 'test-login-failed', userKey, reason: 'store_failed' });
      send(res, 500, { error: 'internal', code: 'store_failed' });
      return;
    }

    // 4. Deliver the handle to the configured Hub, quoting the ticket.
    try {
      await hub.testBind!({ ticket, userKey, readOnly, identity: login.identity, token, expiresAt }, signal);
    } catch (err) {
      // Roll back: a handle the Hub never took must not stay usable.
      await dropTestSession(jti, userLogger);
      userLogger.error('test-bind: hub delivery failed', hubErrorFields(err));
      emit({ type: 'test-login-failed', userKey, reason: 'hub_delivery_failed' });
      send(res, 502, { error: 'test_bind_failed', code: 'hub_delivery_failed' });
      return;
    }

    // 5. Done. The handle is not in this answer.
    userLogger.info('test user signed in', { readOnly, expiresAt, jti });
    emit({ type: 'test-login', userKey });
    send(res, 200, { ok: true, expiresAt });
  });

  // End a test sign-in early. Only a test handle; a real one is never touched.
  // Answers even when test users are off: a handle minted before the list was
  // removed can still be revoked.
  app.post(testUnbindPath, async (req: Request, res: Response) => {
    const token = bearer(req);
    if (!token) {
      unauthorized(res, 'missing_token');
      return;
    }
    let claims: Awaited<ReturnType<typeof verifyHandle>>;
    try {
      claims = await verifyHandle(token, secrets, config.name);
    } catch {
      logger.warn('test-unbind rejected: handle failed verification');
      unauthorized(res, 'invalid_token');
      return;
    }
    if (claims.test !== true || claims.tu === undefined) {
      logger.warn('test-unbind refused: not a test handle');
      send(res, 403, { error: 'forbidden', code: 'not_a_test_handle' });
      return;
    }
    try {
      await store.delete(claims.jti);
    } catch (err) {
      logger.error('test-unbind: could not drop the session', { testUser: claims.tu, errorType: errorName(err) });
      send(res, 500, { error: 'internal', code: 'store_failed' });
      return;
    }
    logger.info('test user signed out', { testUser: claims.tu, jti: claims.jti });
    emit({ type: 'test-unbind', userKey: claims.tu });
    res.status(204).end();
  });

  function testDisabled(res: Response): void {
    send(res, 404, { error: 'not_found', code: 'test_users_disabled' });
  }

  /** Count the attempt before the Hub is asked; answer 429 past the limit. */
  function rateLimited(res: Response): boolean {
    const wait = limiter!.take();
    if (wait === 0) return false;
    logger.warn('test users route rate limited', { retryAfterSeconds: wait });
    res.set('Retry-After', String(wait));
    send(res, 429, { error: 'too_many_requests', code: 'rate_limited' });
    return true;
  }

  /** The Hub's verdict on a ticket, or null when it could not be asked (answered 502). */
  async function checkTicket(
    res: Response,
    check: { ticket: string; purpose: 'list' | 'bind'; userKey?: string },
    signal: AbortSignal,
  ): Promise<boolean | null> {
    try {
      return await hub.verifyTestTicket!(check, signal);
    } catch (err) {
      logger.error('test users: could not check the ticket with the hub', {
        purpose: check.purpose,
        ...hubErrorFields(err),
      });
      send(res, 502, { error: 'ticket_check_failed', code: 'hub_unreachable' });
      return null;
    }
  }

  async function dropTestSession(jti: string, log: Logger): Promise<void> {
    await store.delete(jti).catch((e: unknown) =>
      log.error('test-bind: could not drop the stored session', { errorType: errorName(e) }),
    );
  }

  // Streamable-HTTP GET/DELETE are for stateful sessions; we run stateless.
  app.get(mcpPath, (_req, res) => {
    send(res, 405, { error: 'method_not_allowed' });
  });
  app.delete(mcpPath, (_req, res) => {
    send(res, 405, { error: 'method_not_allowed' });
  });

  // Build a fresh MCP server per request (connect-per-call) with all tools.
  function buildMcpServer(): McpServer {
    const experimental: Record<string, object> = {
      ...(idem ? { [IDEMPOTENCY_CAPABILITY]: { version: 1 } } : {}),
      ...(testUsers ? { [TEST_USERS_CAPABILITY]: { version: 1 } } : {}),
    };
    const server = new McpServer(
      { name: config.name, version: config.version ?? '0.0.0' },
      Object.keys(experimental).length > 0 ? { capabilities: { experimental } } : undefined,
    );
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
        ...(def.annotations ? { annotations: def.annotations } : {}),
      },
      async (
        args: Record<string, unknown>,
        extra: { signal: AbortSignal; _meta?: Record<string, unknown> },
      ) => {
        const rc = requestContext.getStore() as RequestContext<TAuth> | undefined;
        if (!rc?.session) {
          // Belt-and-braces: the HTTP layer already gated tools/call.
          throw new Error('unauthenticated tool invocation');
        }
        const session = rc.session;
        const test = rc.test;
        const meta: Readonly<Record<string, unknown>> = Object.freeze({ ...(extra._meta ?? {}) });
        const ctx: ToolContext<TAuth> = {
          auth: session.artifacts,
          connectionId: session.connectionId,
          call: callContext(meta),
          meta,
          logger: logger.child({
            tool: def.name,
            connectionId: session.connectionId,
            ...(test ? { testUser: test.userKey } : {}),
          }),
          signal: extra.signal,
          ...(test ? { test } : {}),
        };

        if (test) {
          // Read-only guard: before the handler and before dedup, so nothing runs
          // and nothing is cached. Only an explicit readOnlyHint: true passes.
          if (test.readOnly && def.annotations?.readOnlyHint !== true) {
            ctx.logger.info('test call refused: read-only test user, tool not marked readOnlyHint');
            emit({ type: 'test-call-refused', userKey: test.userKey, tool: def.name, reason: 'read_only' });
            return codedError(
              'test_read_only',
              'this test user is read only, and this tool is not marked read only',
            );
          }
          emit({ type: 'test-call', userKey: test.userKey, tool: def.name });
        }
        const run = async (): Promise<CallToolResult> => {
          let result: unknown;
          try {
            result = await def.handler(args as never, ctx);
          } catch (err) {
            if (!ReauthRequired.is(err)) throw err;
            // Drop the session so no later call reuses the refused credential,
            // then let the HTTP layer answer 401. The result below is never sent.
            rc.reauth = { tool: def.name, message: err.message };
            if (rc.jti) {
              await store.delete(rc.jti).catch((e: unknown) =>
                ctx.logger.error('could not drop the rejected session', { error: (e as Error).message }),
              );
            }
            return codedError('REAUTH_REQUIRED', 'the bound credential was rejected');
          }
          if (devGuard) assertNoArtifactLeak(result, session.artifacts, ctx.logger);
          return toCallToolResult(result);
        };

        if (!idem || !Object.prototype.hasOwnProperty.call(meta, IDEMPOTENCY_META_KEY)) {
          return run();
        }
        const key = meta[IDEMPOTENCY_META_KEY];
        if (!isValidIdempotencyKey(key)) {
          return codedError(
            'INVALID_IDEMPOTENCY_KEY',
            `${IDEMPOTENCY_META_KEY} must be a non-empty string of at most 256 characters`,
          );
        }
        // Scope = verified session's connectionId + tool + key (never from the body).
        return runDeduplicated(
          idem.store,
          idempotencyScope(session.connectionId, def.name, key),
          {
            ttlSeconds: idem.ttlSeconds,
            waitMs: idem.waitMs,
            signal: extra.signal,
            // A re-bind retry carries the same key: it must run, not replay this.
            released: () => rc.reauth !== undefined,
            onStoreError: (err) =>
              ctx.logger.error('idempotency: could not update the store entry', {
                error: (err as Error).message,
              }),
          },
          // A failure is a finished call: cache the error result, never re-run.
          () =>
            run().catch(
              (err: unknown): CallToolResult => ({
                isError: true,
                content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
              }),
            ),
        );
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

/** The `_meta` keys the Hub sends as call context, kept only when they are strings. */
function callContext(meta: Readonly<Record<string, unknown>>): CallContext {
  const call: CallContext = {};
  for (const key of ['currentPath', 'userId', 'tenantId', 'sessionId', 'threadId'] as const) {
    const value = meta[key];
    if (typeof value === 'string') call[key] = value;
  }
  return call;
}

/** The transport only reads the method, URL and headers; the body is passed pre-parsed. */
function toWebRequest(req: Request): globalThis.Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const url = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;
  return new globalThis.Request(url, { method: req.method, headers });
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

/** A non-empty string field of a JSON body, else undefined. */
function stringField(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Aborts when the caller hangs up before we answer. */
function requestSignal(res: Response): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

/** The error's class name only: never its message, which may quote a credential. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Safe fields for a failed Hub call: status and the Hub's code, never a body. */
function hubErrorFields(err: unknown): Record<string, unknown> {
  if (err instanceof HubTestCallError) {
    return { status: err.status, ...(err.code ? { hubCode: err.code } : {}) };
  }
  return { errorType: errorName(err) };
}

function unauthorized(res: Response, code: string): void {
  res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized', code });
}

function send(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}
