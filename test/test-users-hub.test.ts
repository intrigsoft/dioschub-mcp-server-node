import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { SignJWT } from 'jose';
import { HubClient, HubTestCallError } from '../src/hub-client.js';
import { signHandle, verifyHandle } from '../src/jwt.js';
import { createMcpServer } from '../src/index.js';
import { capturingLogger, post, SENTINEL } from './test-users-support.js';

/**
 * Pins HubClient to the test users wire contract (test-users-contract.md):
 *   POST /api/auth/test-tickets/verify { ticket, purpose, instanceName?, userKey? } → { valid }
 *   POST /api/auth/test-bind { ticket, instanceName?, userKey, readOnly, identity,
 *                              authArtifacts: { headers: { Authorization } }, expiresAt } → { ok: true }
 * with the hub API key in the configured header.
 */
async function mockHub(answer: (path: string, body: any) => { status: number; body: unknown }) {
  const seen: Array<{ path: string; headers: Record<string, unknown>; body: any }> = [];
  const app = express();
  app.use(express.json());
  app.post(/.*/, (req, res) => {
    seen.push({ path: req.path, headers: req.headers, body: req.body });
    const a = answer(req.path, req.body);
    res.status(a.status).json(a.body);
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const identity = { userId: 'u1', username: 'alice', role: { id: 'r1', name: 'Clerk' } };

test('TU-HUB: verifyTestTicket posts the contract body with the api key and reads { valid }', async () => {
  const hub = await mockHub((_p, body) => ({ status: 200, body: { valid: body.ticket === 'good' } }));
  const client = new HubClient({ url: hub.url, apiKey: 'diosc_ak_x', instanceName: 'srv' }, capturingLogger());
  assert.equal(await client.verifyTestTicket({ ticket: 'good', purpose: 'bind', userKey: 'alice' }), true);
  assert.equal(await client.verifyTestTicket({ ticket: 'bad', purpose: 'list' }), false);
  assert.equal(hub.seen[0]!.path, '/api/auth/test-tickets/verify');
  assert.equal(hub.seen[0]!.headers['x-api-key'], 'diosc_ak_x');
  assert.deepEqual(hub.seen[0]!.body, { ticket: 'good', purpose: 'bind', instanceName: 'srv', userKey: 'alice' });
  assert.deepEqual(hub.seen[1]!.body, { ticket: 'bad', purpose: 'list', instanceName: 'srv' });
  await hub.close();
});

test('TU-HUB: without an instanceName the body has none, as on the real bind', async () => {
  const hub = await mockHub(() => ({ status: 200, body: { valid: true } }));
  const client = new HubClient({ url: hub.url, apiKey: 'k' }, capturingLogger());
  await client.verifyTestTicket({ ticket: 't', purpose: 'list' });
  assert.deepEqual(hub.seen[0]!.body, { ticket: 't', purpose: 'list' });
  await hub.close();
});

test('TU-HUB: testBind posts the handle as the forwarded header, with readOnly, identity and expiry', async () => {
  const hub = await mockHub(() => ({ status: 200, body: { ok: true } }));
  const client = new HubClient(
    { url: hub.url, apiKey: 'k', apiKeyHeader: 'x-admin-token', instanceName: 'srv' },
    capturingLogger(),
  );
  await client.testBind({
    ticket: 't-1',
    userKey: 'alice',
    readOnly: true,
    identity,
    token: 'HANDLE.JWT.VALUE',
    expiresAt: '2026-11-27T12:00:00.000Z',
  });
  assert.equal(hub.seen[0]!.path, '/api/auth/test-bind');
  assert.equal(hub.seen[0]!.headers['x-admin-token'], 'k');
  assert.deepEqual(hub.seen[0]!.body, {
    ticket: 't-1',
    instanceName: 'srv',
    userKey: 'alice',
    readOnly: true,
    identity,
    authArtifacts: { headers: { Authorization: 'Bearer HANDLE.JWT.VALUE' } },
    expiresAt: '2026-11-27T12:00:00.000Z',
  });
  await hub.close();
});

test('TU-HUB: the test paths can be overridden like bindPath', async () => {
  const hub = await mockHub((p) => ({ status: 200, body: p === '/v/check' ? { valid: true } : { ok: true } }));
  const client = new HubClient(
    { url: hub.url + '/', apiKey: 'k', testTicketVerifyPath: '/v/check', testBindPath: '/v/bind' },
    capturingLogger(),
  );
  await client.verifyTestTicket({ ticket: 't', purpose: 'list' });
  await client.testBind({ ticket: 't', userKey: 'a', readOnly: false, identity, token: 'H', expiresAt: 'x' });
  assert.deepEqual(hub.seen.map((s) => s.path), ['/v/check', '/v/bind']);
  await hub.close();
});

test('TU-HUB: a refused test-bind throws HubTestCallError with the status and code, never the handle', async () => {
  for (const [status, code] of [
    [409, 'ticket_used'],
    [410, 'ticket_expired'],
    [404, 'ticket_unknown'],
  ] as const) {
    const hub = await mockHub(() => ({ status, body: { error: 'x', code, echo: 'HANDLE.SECRET' } }));
    const client = new HubClient({ url: hub.url, apiKey: 'k' }, capturingLogger());
    await assert.rejects(
      client.testBind({ ticket: 't', userKey: 'a', readOnly: false, identity, token: 'HANDLE.SECRET', expiresAt: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof HubTestCallError);
        assert.equal(err.status, status);
        assert.equal(err.code, code);
        assert.ok(!err.message.includes('HANDLE.SECRET'));
        return true;
      },
    );
    await hub.close();
  }
});

test('TU-HUB: a verify answer that is not 2xx, or 200 without { valid }, throws', async () => {
  const hub = await mockHub((_p, body) =>
    body.ticket === 'e' ? { status: 500, body: {} } : { status: 200, body: { hello: 'world' } },
  );
  const client = new HubClient({ url: hub.url, apiKey: 'k' }, capturingLogger());
  await assert.rejects(client.verifyTestTicket({ ticket: 'e', purpose: 'list' }), HubTestCallError);
  await assert.rejects(client.verifyTestTicket({ ticket: 'f', purpose: 'list' }), HubTestCallError);
  await hub.close();
});

test('TU-HUB: end to end through the real HubClient, the handle goes only to the hub', async () => {
  let delivered: any;
  const hub = await mockHub((p, body) => {
    if (p === '/api/auth/test-tickets/verify') return { status: 200, body: { valid: body.ticket === 'tk' } };
    delivered = body;
    return { status: 200, body: { ok: true } };
  });
  const logger = capturingLogger();
  const server = createMcpServer<{ c: string }>({
    name: 'e2e-mcp',
    adminKey: 'a',
    jwtSecrets: 's',
    hub: { url: hub.url, apiKey: 'k' },
    logger,
    testUsers: {
      users: [{ key: 'alice', name: 'Alice', credentials: { password: SENTINEL } }],
      login: async () => ({ auth: { c: 'x' }, identity }),
    },
  });
  const http: Server = await new Promise((resolve) => {
    const s = server.listen(0, () => resolve(s));
  });
  const url = `http://localhost:${(http.address() as AddressInfo).port}`;

  const res = await post(url, '/test-bind', { ticket: 'tk', userKey: 'alice' });
  assert.equal(res.status, 200);
  assert.equal(hub.seen[0]!.body.instanceName, 'e2e-mcp', 'instanceName defaults to the server name');
  const token = (delivered.authArtifacts.headers.Authorization as string).replace(/^Bearer /, '');
  assert.equal((await verifyHandle(token, ['s'], 'e2e-mcp')).tu, 'alice');
  assert.ok(!res.text.includes(token));
  assert.ok(!logger.text().includes(token) && !logger.text().includes(SENTINEL));

  await new Promise<void>((r) => http.close(() => r()));
  await hub.close();
});

// ------------------------------------------------------------------ handle claims

test('TU-JWT: a test handle round-trips test, tu and ro; a real one returns none of them', async () => {
  const t = await signHandle({ jti: 'j', aud: 'srv', test: true, tu: 'bob.ro', ro: true }, 'sec', 3600);
  const v = await verifyHandle(t, ['sec'], 'srv');
  assert.equal(v.jti, 'j');
  assert.equal(v.test, true);
  assert.equal(v.tu, 'bob.ro');
  assert.equal(v.ro, true);
  assert.equal(v.exp! - v.iat!, 3600);

  const real = await verifyHandle(await signHandle({ jti: 'r', aud: 'srv' }, 'sec', 60), ['sec'], 'srv');
  assert.equal(real.test, undefined);
  assert.equal(real.tu, undefined);
  assert.equal(real.ro, undefined);
});

test('TU-JWT: signHandle refuses tu or ro without test, and test without a valid key', async () => {
  await assert.rejects(signHandle({ jti: 'j', aud: 'a', tu: 'x' }, 's', 60));
  await assert.rejects(signHandle({ jti: 'j', aud: 'a', ro: true }, 's', 60));
  await assert.rejects(signHandle({ jti: 'j', aud: 'a', test: true }, 's', 60));
  await assert.rejects(signHandle({ jti: 'j', aud: 'a', test: true, tu: 'BAD KEY' }, 's', 60));
});

test('TU-JWT: verifyHandle fails closed on test claims not exactly as minted', async () => {
  const forge = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setJti('j')
      .setAudience('srv')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('sec'));
  for (const claims of [
    { test: 'true', tu: 'alice' },
    { test: true },
    { test: true, tu: 'Not A Key' },
    { test: true, tu: 'alice', ro: false },
    { tu: 'alice' },
    { ro: true },
  ]) {
    await assert.rejects(verifyHandle(await forge(claims), ['sec'], 'srv'), /malformed test claims/, JSON.stringify(claims));
  }
});
