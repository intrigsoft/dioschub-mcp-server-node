/**
 * Live harness: runs the Northwind mock backend + the framework MCP server
 * configured to bind against a REAL DioscHub (default http://localhost:3333).
 *
 *   HUB_API_KEY=diosc_ak_... npx tsx examples/northwind/run-live.ts
 *
 * Env:
 *   HUB_URL       default http://localhost:3333
 *   HUB_API_KEY   required — admin key scoped `auth:bind`
 *   MCP_PORT      default 8080  (the URL you register as a conduit MCP instance)
 *   BACKEND_PORT  default 3010
 *
 * It logs in a demo user and prints that user's session cookie, so the
 * "host backend" step (POST {mcp}/bind with the wsId + cookie) can be driven
 * externally (e.g. from the Playwright script) once a wsId exists.
 */
import type { AddressInfo } from 'node:net';
import { createNorthwindBackend } from './backend.js';
import { createNorthwindMcp } from './northwind-mcp.js';

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:3333';
// Default to the local dev admin-token bypass; override with a real diosc_ak_ key.
const HUB_API_KEY = process.env.HUB_API_KEY ?? 'dev-admin-token-12345';
const HUB_API_KEY_HEADER = process.env.HUB_API_KEY_HEADER ?? 'x-admin-token';
const MCP_PORT = Number(process.env.MCP_PORT ?? 8080);
const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? 3010);
const ADMIN_KEY = process.env.MCP_ADMIN_KEY ?? 'northwind-admin-key';

const backend = createNorthwindBackend();
const backendServer = backend.app.listen(BACKEND_PORT, () => {
  const apiUrl = `http://localhost:${(backendServer.address() as AddressInfo).port}`;
  const cookie = backend.login('ALFKI', 'ALFKI');

  const mcp = createNorthwindMcp({
    apiUrl,
    adminKey: ADMIN_KEY,
    jwtSecret: 'live-jwt-secret',
    hub: { url: HUB_URL, apiKey: HUB_API_KEY, apiKeyHeader: HUB_API_KEY_HEADER },
  });

  const mcpServer = mcp.listen(MCP_PORT, () => {
    const mcpUrl = `http://localhost:${(mcpServer.address() as AddressInfo).port}`;
    process.stderr.write(
      [
        '',
        '=== Northwind live harness ready ===',
        `Hub          : ${HUB_URL}`,
        `Backend      : ${apiUrl}`,
        `MCP (conduit): ${mcpUrl}/mcp   <-- register this URL as a conduit MCP instance`,
        `MCP admin key: ${ADMIN_KEY}    <-- used for the host→MCP /bind call`,
        `Demo cookie  : ${cookie}`,
        '',
        'Host-backend bind (run after you have a wsId from the kit):',
        `  curl -s ${mcpUrl}/bind -H 'content-type: application/json' -H 'x-admin-key: ${ADMIN_KEY}' \\`,
        `    -d '{"connectionId":"<WS_ID>","artifacts":{"sessionCookie":"${cookie}"},` +
          `"identity":{"userId":"ALFKI","username":"Maria","role":{"id":"customer","name":"Customer"}}}'`,
        '',
      ].join('\n'),
    );
  });
});
