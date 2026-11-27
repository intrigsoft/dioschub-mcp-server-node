import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createNorthwindBackend } from '../examples/northwind/backend.js';
import { createNorthwindMcp } from '../examples/northwind/northwind-mcp.js';
import { rpc } from './support.js';
import { fakeHub, post } from './test-users-support.js';

function listen(app: { listen: (port: number, cb: () => void) => Server }): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}
const urlOf = (s: Server) => `http://localhost:${(s.address() as AddressInfo).port}`;

test('northwind test user: the example signs in through the real /login and calls a tool as that user', async () => {
  const backend = createNorthwindBackend();
  const backendServer = await listen(backend.app);
  const hub = fakeHub();
  const mcp = createNorthwindMcp({
    apiUrl: urlOf(backendServer),
    adminKey: 'admin-secret',
    jwtSecret: 'jwt-secret',
    hubClient: hub,
    testUsers: JSON.stringify([
      {
        key: 'alfki',
        name: 'Maria (test)',
        readOnly: true,
        credentials: { username: 'ALFKI', password: 'demo-password-not-real' },
      },
      { key: 'wrong', name: 'Bad password', credentials: { username: 'ALFKI', password: 'nope' } },
    ]),
  });
  const mcpServer = await listen(mcp);
  const url = urlOf(mcpServer);

  hub.tickets.set('t-1', { purpose: 'bind', userKey: 'alfki' });
  const res = await post(url, '/test-bind', { ticket: 't-1', userKey: 'alfki' });
  assert.equal(res.status, 200);
  const token = hub.deliveries[0]!.token;
  assert.deepEqual(hub.deliveries[0]!.identity, {
    userId: 'ALFKI',
    username: 'ALFKI',
    role: { id: 'customer', name: 'Customer' },
  });

  // Read only, and my_orders is marked readOnlyHint: it runs with the test user's own session.
  const orders = await rpc(url, 'tools/call', { name: 'my_orders', arguments: {} }, token);
  assert.equal(orders.status, 200);
  assert.deepEqual(
    JSON.parse(orders.body.result.content[0].text).map((o: { id: number }) => o.id).sort(),
    [10643, 10692],
  );

  hub.tickets.set('t-2', { purpose: 'bind', userKey: 'wrong' });
  const bad = await post(url, '/test-bind', { ticket: 't-2', userKey: 'wrong' });
  assert.equal(bad.status, 502);
  assert.equal(bad.json.code, 'test_login_failed');

  await new Promise<void>((r) => mcpServer.close(() => r()));
  await new Promise<void>((r) => backendServer.close(() => r()));
});
