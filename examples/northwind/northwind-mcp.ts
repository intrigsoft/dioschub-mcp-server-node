/**
 * The Northwind MCP server, built on @dioschub/mcp-server.
 *
 * Imported by the package NAME (not a relative src path) on purpose: this is
 * exactly how an external consumer would use the framework, so it also proves
 * the built `dist` + the package `exports` map actually work.
 */
import { createMcpServer, type DioscMcpServer } from '@dioschub/mcp-server';
import type { HubBinder, HubConfig } from '@dioschub/mcp-server';
import { z } from 'zod';

/** The Northwind app's native artifact: its session cookie header value. */
export interface NorthwindAuth {
  sessionCookie: string;
}

export interface NorthwindMcpConfig {
  apiUrl: string;
  adminKey: string;
  jwtSecret: string;
  /** Provide a fake binder (tests) OR real hub config (live). One is required. */
  hubClient?: HubBinder;
  hub?: HubConfig;
  /**
   * The test users list as JSON. Default: the DIOSC_TEST_USERS variable. Each
   * entry's credentials are `{ username, password }` for Northwind's /login.
   */
  testUsers?: string;
}

/** The private part of a Northwind test user entry. */
interface NorthwindTestCredentials {
  username: string;
  password: string;
}

export function createNorthwindMcp(config: NorthwindMcpConfig): DioscMcpServer<NorthwindAuth> {
  const server = createMcpServer<NorthwindAuth>({
    name: 'northwind-mcp',
    adminKey: config.adminKey,
    jwtSecrets: config.jwtSecret,
    ...(config.hubClient ? { hubClient: config.hubClient } : {}),
    ...(config.hub ? { hub: config.hub } : {}),
    // Test users: the Hub's admin can sign in as one of these to try the tools.
    // Off unless the list (DIOSC_TEST_USERS) has entries.
    testUsers: {
      users: config.testUsers,
      async login(credentials, _entry, ctx) {
        const { username, password } = credentials as NorthwindTestCredentials;
        // Sign in exactly as the app's own login page would.
        const res = await fetch(`${config.apiUrl}/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
          signal: ctx.signal,
        });
        if (!res.ok) throw new Error(`northwind login refused with ${res.status}`);
        const { cookie } = (await res.json()) as { cookie: string };
        return {
          auth: { sessionCookie: cookie },
          identity: { userId: username, username, role: { id: 'customer', name: 'Customer' } },
        };
      },
      onEvent: (event) => process.stderr.write(`[test users] ${JSON.stringify(event)}\n`),
    },
  });

  const call = async (
    ctx: { auth: NorthwindAuth; signal: AbortSignal; logger: { info: (m: string, f?: object) => void } },
    path: string,
  ) => {
    ctx.logger.info('TOOL CALL', {
      path,
      hasCookie: !!ctx.auth?.sessionCookie,
      cookiePreview: ctx.auth?.sessionCookie?.slice(0, 14) + '…',
    });
    const res = await fetch(`${config.apiUrl}${path}`, {
      headers: { cookie: ctx.auth.sessionCookie }, // the replayed native credential
      signal: ctx.signal,
    });
    if (res.status === 401) throw new Error('northwind session expired');
    if (!res.ok) throw new Error(`northwind ${path} failed: ${res.status}`);
    const data = await res.json();
    ctx.logger.info('TOOL RESULT', { path, rows: Array.isArray(data) ? data.length : 'n/a' });
    return data;
  };

  server
    .tool({
      name: 'list_products',
      description: 'List Northwind products',
      input: z.object({}),
      // Read only, so a read-only test user may call it too.
      annotations: { readOnlyHint: true },
      handler: (_args, ctx) => call(ctx, '/api/products'),
    })
    .tool({
      name: 'my_orders',
      description: 'List orders belonging to the signed-in customer',
      input: z.object({}),
      annotations: { readOnlyHint: true },
      handler: (_args, ctx) => call(ctx, '/api/orders'),
    });

  return server;
}
