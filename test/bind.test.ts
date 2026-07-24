import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { MemoryArtifactStore } from '../src/store/memory-store.js';
import { verifyHandle } from '../src/jwt.js';
import { createMcpServer } from '../src/index.js';
import type { AddressInfo } from 'node:net';
import type { DioscMcpServer } from '../src/index.js';
import { ADMIN_KEY, JWT_SECRET, bind, capturingHub, startHarness } from './support.js';

const noop = (s: DioscMcpServer<{ sessionCookie: string }>) => {
  s.tool({ name: 'noop', input: z.object({}), handler: () => ({ ok: true }) });
};

test('bind rejects a bad admin key with 403 (the embed-key trap)', async () => {
  const h = await startHarness(noop);
  const res = await bind(h.url, 'conn-1', { sessionCookie: 'c' }, 'wrong-key');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'admin_key');
  await h.close();
});

test('bind rejects missing fields with 400', async () => {
  const h = await startHarness(noop);
  const res = await fetch(`${h.url}/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ connectionId: 'conn-1' }), // no artifacts
  });
  assert.equal(res.status, 400);
  await h.close();
});

test('bind mints a handle, stores the session, and calls the Hub exactly once', async () => {
  const h = await startHarness(noop);
  const res = await bind(h.url, 'conn-42', { sessionCookie: 'c' });
  assert.equal(res.status, 200);

  assert.equal(h.hub.calls.length, 1);
  assert.equal(h.hub.calls[0]!.connectionId, 'conn-42');
  // The token handed to the Hub is a valid handle for this server.
  const { jti } = await verifyHandle(h.hub.lastToken(), [JWT_SECRET], 'test-mcp');
  assert.ok(jti);
  await h.close();
});

test('a failed Hub bind rolls back the store entry and returns 502', async () => {
  const store = new MemoryArtifactStore<{ sessionCookie: string }>();
  const deleted: string[] = [];
  const originalDelete = store.delete.bind(store);
  store.delete = async (jti) => {
    deleted.push(jti);
    return originalDelete(jti);
  };

  const hub = capturingHub(() => {
    throw new Error('hub down');
  });
  const server = createMcpServer<{ sessionCookie: string }>({
    name: 'test-mcp',
    adminKey: ADMIN_KEY,
    jwtSecrets: JWT_SECRET,
    hubClient: hub,
    store,
  });
  server.tool({ name: 'noop', input: z.object({}), handler: () => ({ ok: true }) });

  const httpServer = await new Promise<import('node:http').Server>((resolve) => {
    const s = server.listen(0, () => resolve(s));
  });
  const { port } = httpServer.address() as AddressInfo;

  const res = await bind(`http://localhost:${port}`, 'conn-1', { sessionCookie: 'c' });
  assert.equal(res.status, 502);
  assert.equal(deleted.length, 1); // the put was rolled back — no orphaned session

  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});
