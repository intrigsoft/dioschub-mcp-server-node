import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { HubClient } from '../src/hub-client.js';
import { defaultLogger } from '../src/logger.js';

/**
 * Pins HubClient to the REAL DioscHub bind contract:
 *   POST /api/auth/bind
 *   header x-api-key: <admin key>
 *   body  { wsId, identity, authArtifacts: { headers: { Authorization: 'Bearer <handle>' } } }
 *   → 200 { ok: true }
 * (Verified against libs/realtime AuthBindingController + dto/auth-binding.dto.ts.)
 */
async function mockHub(): Promise<{
  url: string;
  captured: () => { path: string; apiKey?: string; body: unknown };
  close: () => Promise<void>;
}> {
  let captured: { path: string; apiKey?: string; body: unknown } = { path: '', body: undefined };
  const app = express();
  app.use(express.json());
  app.post('/api/auth/bind', (req, res) => {
    captured = { path: req.path, apiKey: req.header('x-api-key'), body: req.body };
    res.status(200).json({ ok: true });
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    captured: () => captured,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test('HubClient posts the real /api/auth/bind wire contract', async () => {
  const hub = await mockHub();
  const client = new HubClient(
    { url: hub.url, apiKey: 'diosc_ak_secret' },
    defaultLogger(),
  );

  await client.bind('ws-123', 'HANDLE.JWT.VALUE', {
    userId: 'u1',
    username: 'alice',
    role: { id: 'r1', name: 'operator' },
  });

  const c = hub.captured();
  assert.equal(c.path, '/api/auth/bind');
  assert.equal(c.apiKey, 'diosc_ak_secret');
  assert.deepEqual(c.body, {
    wsId: 'ws-123',
    identity: { userId: 'u1', username: 'alice', role: { id: 'r1', name: 'operator' } },
    authArtifacts: { headers: { Authorization: 'Bearer HANDLE.JWT.VALUE' } },
  });

  await hub.close();
});

test('HubClient sends identity: null when the app binds anonymously', async () => {
  const hub = await mockHub();
  const client = new HubClient({ url: hub.url, apiKey: 'diosc_ak_secret' }, defaultLogger());

  await client.bind('ws-9', 'H');

  const body = hub.captured().body as { identity: unknown };
  assert.equal(body.identity, null);
  await hub.close();
});

test('HubClient throws HubBindError on a non-2xx Hub response', async () => {
  const app = express();
  app.use(express.json());
  app.post('/api/auth/bind', (_req, res) => res.status(403).json({ error: 'forbidden' }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  const client = new HubClient({ url: `http://localhost:${port}`, apiKey: 'bad' }, defaultLogger());
  await assert.rejects(() => client.bind('ws-1', 'H'), /Hub bind failed with 403/);

  await new Promise<void>((r) => server.close(() => r()));
});
