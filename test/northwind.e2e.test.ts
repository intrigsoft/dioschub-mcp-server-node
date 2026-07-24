import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createNorthwindBackend } from '../examples/northwind/backend.js';
import { createNorthwindMcp } from '../examples/northwind/northwind-mcp.js';
import { capturingHub } from './support.js';

function listen(app: { listen: (port: number, cb: () => void) => Server }): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}
const urlOf = (s: Server) => `http://localhost:${(s.address() as AddressInfo).port}`;

test('northwind end-to-end: framework fronts a real cookie-guarded backend', async () => {
  // 1. The Northwind app, with its own cookie auth.
  const backend = createNorthwindBackend();
  const backendServer = await listen(backend.app);
  const cookie = backend.login('ALFKI', 'ALFKI'); // the user's native session

  // 2. The MCP server built on the framework (consumed as @intrigsoft/dioschub-mcp-server).
  const hub = capturingHub();
  const mcp = createNorthwindMcp({
    apiUrl: urlOf(backendServer),
    adminKey: 'admin-secret',
    jwtSecret: 'jwt-secret',
    hubClient: hub,
  });
  const mcpServer = await listen(mcp);
  const mcpUrl = urlOf(mcpServer);

  // 3. The app binds the user's native cookie (server-to-server, admin-keyed).
  const bindRes = await fetch(`${mcpUrl}/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-secret' },
    body: JSON.stringify({ connectionId: 'conn-1', artifacts: { sessionCookie: cookie } }),
  });
  assert.equal(bindRes.status, 200);
  const token = hub.lastToken(); // the opaque handle the Hub now holds

  // 4. Speak MCP as the Hub would, carrying only the handle-JWT — never the cookie.
  const transport = new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test-hub', version: '0.0.0' });
  await client.connect(transport);
  const seenText: string[] = [];
  const callJson = async (name: string) => {
    const r = (await client.callTool({ name, arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    r.content.forEach((c) => c.text && seenText.push(c.text));
    return r;
  };

  // 5. Products come back — the backend accepted the replayed cookie.
  const products = JSON.parse((await callJson('list_products')).content[0]!.text) as Array<{
    name: string;
  }>;
  assert.ok(products.some((p) => p.name === 'Chai'), 'expected real product data');

  // 6. Orders are scoped by the cookie's user: ALFKI's two orders, not ANATR's.
  const orders = JSON.parse((await callJson('my_orders')).content[0]!.text) as Array<{ id: number }>;
  assert.deepEqual(
    orders.map((o) => o.id).sort(),
    [10643, 10692],
    'orders must be scoped to the bound user via the replayed credential',
  );

  // 7. Credential-blind: the cookie must never appear in anything the client saw.
  assert.ok(!seenText.some((t) => t.includes(cookie)), 'session cookie leaked into a tool result');

  // 8. The credential is real: kill the native session, the backend rejects, the
  //    tool surfaces an error (which is what drives the Hub's re-auth path).
  backend.invalidate(cookie);
  const afterLogout = await callJson('my_orders');
  assert.equal(afterLogout.isError, true, 'a dead upstream session must surface as a tool error');

  await client.close();
  await new Promise<void>((r) => mcpServer.close(() => r()));
  await new Promise<void>((r) => backendServer.close(() => r()));
});
