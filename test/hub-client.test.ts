import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { HubClient } from '../src/hub-client.js';
import { createMcpServer } from '../src/server.js';
import { defaultLogger } from '../src/logger.js';

/**
 * Pins HubClient to the REAL DioscHub bind contract:
 *   POST /api/auth/bind
 *   header x-api-key: <admin key>
 *   body  { wsId, identity, authArtifacts: { headers, perServer } }
 *   → 200 { ok: true }
 * (Verified against libs/realtime AuthBindingController + dto/auth-binding.dto.ts.)
 *
 * The audience-binding tests below are the load-bearing ones: they pin that the
 * bind names its target, so the Hub forwards our handle to us alone rather than
 * to every conduit instance on the assistant.
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
    { url: hub.url, apiKey: 'diosc_ak_secret', instanceName: 'my-server' },
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
    authArtifacts: {
      headers: { Authorization: 'Bearer HANDLE.JWT.VALUE' },
      perServer: { 'my-server': { headers: { Authorization: 'Bearer HANDLE.JWT.VALUE' } } },
    },
  });

  await hub.close();
});

test('HubClient names itself as the per-target key, so the Hub scopes the handle to us', async () => {
  const hub = await mockHub();
  const client = new HubClient(
    { url: hub.url, apiKey: 'k', instanceName: 'meridian-hr' },
    defaultLogger(),
  );

  await client.bind('ws-1', 'H');

  const artifacts = (hub.captured().body as { authArtifacts: Record<string, any> }).authArtifacts;
  assert.deepEqual(Object.keys(artifacts.perServer), ['meridian-hr']);
  assert.equal(artifacts.perServer['meridian-hr'].headers.Authorization, 'Bearer H');
  await hub.close();
});

test('HubClient keeps the session-wide slot too, so an older Hub still works', async () => {
  // A Hub that predates per-target binding ignores `perServer` and reads
  // `headers`. Dropping `headers` would silently un-authenticate every tool
  // call against such a Hub, so both shapes must ride along.
  const hub = await mockHub();
  const client = new HubClient(
    { url: hub.url, apiKey: 'k', instanceName: 'srv' },
    defaultLogger(),
  );

  await client.bind('ws-1', 'H');

  const artifacts = (hub.captured().body as { authArtifacts: Record<string, any> }).authArtifacts;
  assert.equal(artifacts.headers.Authorization, 'Bearer H');
  await hub.close();
});

test('HubClient omits perServer when no instanceName is configured', async () => {
  // Cannot name a target → send only the legacy shape rather than guess a name
  // that would make the Hub fail closed and forward nothing.
  const hub = await mockHub();
  const client = new HubClient({ url: hub.url, apiKey: 'k' }, defaultLogger());

  await client.bind('ws-1', 'H');

  const artifacts = (hub.captured().body as { authArtifacts: Record<string, any> }).authArtifacts;
  assert.deepEqual(artifacts, { headers: { Authorization: 'Bearer H' } });
  assert.equal('perServer' in artifacts, false);
  await hub.close();
});

test('createMcpServer defaults the per-target key to the server name', async () => {
  const hub = await mockHub();
  const server = createMcpServer<string>({
    name: 'auto-named',
    adminKey: 'admin-key',
    jwtSecrets: 'test-secret-value',
    hub: { url: hub.url, apiKey: 'k' },
  });

  const app = server.app;
  const listening: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = listening.address() as AddressInfo;

  const res = await fetch(`http://localhost:${port}/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-key' },
    body: JSON.stringify({ connectionId: 'ws-auto', artifacts: 'session:abc' }),
  });
  assert.equal(res.status, 200);

  const artifacts = (hub.captured().body as { authArtifacts: Record<string, any> }).authArtifacts;
  assert.deepEqual(Object.keys(artifacts.perServer), ['auto-named']);

  await new Promise<void>((r) => listening.close(() => r()));
  await hub.close();
});

test('createMcpServer honours an explicit hub.instanceName over the server name', async () => {
  // The Hub's registered instance name need not equal this server's name; when
  // they differ the Hub's name is the one that must appear as the key.
  const hub = await mockHub();
  const server = createMcpServer<string>({
    name: 'local-name',
    adminKey: 'admin-key',
    jwtSecrets: 'test-secret-value',
    hub: { url: hub.url, apiKey: 'k', instanceName: 'hub-side-name' },
  });

  const listening: Server = await new Promise((resolve) => {
    const s = server.app.listen(0, () => resolve(s));
  });
  const { port } = listening.address() as AddressInfo;

  await fetch(`http://localhost:${port}/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': 'admin-key' },
    body: JSON.stringify({ connectionId: 'ws-x', artifacts: 'session:abc' }),
  });

  const artifacts = (hub.captured().body as { authArtifacts: Record<string, any> }).authArtifacts;
  assert.deepEqual(Object.keys(artifacts.perServer), ['hub-side-name']);

  await new Promise<void>((r) => listening.close(() => r()));
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
