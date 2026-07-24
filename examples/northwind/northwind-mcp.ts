/**
 * The Northwind MCP server, built on @intrigsoft/dioschub-mcp-server.
 *
 * Imported by the package NAME (not a relative src path) on purpose: this is
 * exactly how an external consumer would use the framework, so it also proves
 * the built `dist` + the package `exports` map actually work.
 */
import { createMcpServer, type DioscMcpServer } from '@intrigsoft/dioschub-mcp-server';
import type { HubBinder, HubConfig } from '@intrigsoft/dioschub-mcp-server';
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
}

export function createNorthwindMcp(config: NorthwindMcpConfig): DioscMcpServer<NorthwindAuth> {
  const server = createMcpServer<NorthwindAuth>({
    name: 'northwind-mcp',
    adminKey: config.adminKey,
    jwtSecrets: config.jwtSecret,
    ...(config.hubClient ? { hubClient: config.hubClient } : {}),
    ...(config.hub ? { hub: config.hub } : {}),
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
      handler: (_args, ctx) => call(ctx, '/api/products'),
    })
    .tool({
      name: 'my_orders',
      description: 'List orders belonging to the signed-in customer',
      input: z.object({}),
      handler: (_args, ctx) => call(ctx, '/api/orders'),
    });

  return server;
}
