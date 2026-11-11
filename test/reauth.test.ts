import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MemoryIdempotencyStore, ReauthRequired, type IdempotencyStore } from '../src/index.js';
import { runDeduplicated } from '../src/idempotency/index.js';
import { bindAndToken, callWithKey, rpc, startHarness } from './support.js';

/**
 * An upstream that accepts one cookie value. A handler that sees any other
 * value throws ReauthRequired, as a real tool would on the upstream's 401.
 */
async function upstream() {
  const state = { accepted: 'cookie-conn-B', runs: 0, writes: 0 };
  const h = await startHarness((s) => {
    s.tool({
      name: 'read_patient',
      input: z.object({}),
      handler: (_args, ctx) => {
        state.runs += 1;
        if (ctx.auth.sessionCookie !== state.accepted) throw new ReauthRequired('upstream said 401');
        state.writes += 1;
        return { patient: 'p-42' };
      },
    });
    s.tool({
      name: 'broken',
      input: z.object({}),
      handler: () => {
        throw new Error('upstream said 500');
      },
    });
  });
  return { h, state };
}

test('REAUTH-001: a handler that throws ReauthRequired gets HTTP 401 reauth_required, not a tool result', async () => {
  const { h } = await upstream();
  const token = await bindAndToken(h, 'conn-A');
  const reply = await callWithKey(h.url, token, 'read_patient', {});
  assert.equal(reply.status, 401);
  assert.deepEqual(reply.body, { error: 'unauthorized', code: 'reauth_required' });
  await h.close();
});

test('REAUTH-002: the rejected session is dropped, so the same handle gets a clean 401 unbound', async () => {
  const { h, state } = await upstream();
  const token = await bindAndToken(h, 'conn-A');
  await callWithKey(h.url, token, 'read_patient', {});
  const again = await callWithKey(h.url, token, 'read_patient', {});
  assert.equal(again.status, 401);
  assert.equal(again.body.code, 'unbound');
  assert.equal(state.runs, 1, 'the handler never sees the dropped session again');
  await h.close();
});

test('REAUTH-003: after a re-bind the same call runs with the fresh credential', async () => {
  const { h, state } = await upstream();
  const stale = await bindAndToken(h, 'conn-A');
  assert.equal((await callWithKey(h.url, stale, 'read_patient', {})).status, 401);
  const fresh = await bindAndToken(h, 'conn-B');
  const reply = await callWithKey(h.url, fresh, 'read_patient', {});
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.result.structuredContent, { patient: 'p-42' });
  await h.close();
});

test('REAUTH-004: the re-bind retry with the same idempotency key runs; the 401 is never replayed', async () => {
  const { h, state } = await upstream();
  // Both binds are for one Hub connection, so the dedup scope is the same.
  const stale = await bindAndToken(h, 'conn-A');
  assert.equal((await callWithKey(h.url, stale, 'read_patient', {}, 'call-1')).status, 401);
  state.accepted = 'cookie-conn-A';
  const fresh = await bindAndToken(h, 'conn-A');
  const retry = await callWithKey(h.url, fresh, 'read_patient', {}, 'call-1');
  assert.equal(retry.status, 200);
  assert.notEqual(retry.body.result.isError, true);
  assert.equal(state.runs, 2);
  // ...and the successful run is now the one that is deduplicated.
  const dup = await callWithKey(h.url, fresh, 'read_patient', {}, 'call-1');
  assert.deepEqual(dup.body.result.structuredContent, { patient: 'p-42' });
  assert.equal(state.runs, 2);
  await h.close();
});

test('REAUTH-005: any other thrown error is still a 200 tool error, and the session stays bound', async () => {
  const { h, state } = await upstream();
  const token = await bindAndToken(h, 'conn-B');
  const reply = await rpc(h.url, 'tools/call', { name: 'broken', arguments: {} }, token);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.result.isError, true);
  const next = await callWithKey(h.url, token, 'read_patient', {});
  assert.equal(next.status, 200);
  assert.equal(state.writes, 1);
  await h.close();
});

test('REAUTH-006: the Hub (an MCP SDK client) sees a transport-level 401, the "never sent" signal', async () => {
  const { h } = await upstream();
  const token = await bindAndToken(h, 'conn-A');
  const client = new Client({ name: 'test-hub', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  // The Hub's isHttp401 reads `code === 401` off the SDK's StreamableHTTPError.
  await assert.rejects(client.callTool({ name: 'read_patient', arguments: {} }), (err: { code?: unknown }) => {
    assert.equal(err.code, 401);
    return true;
  });
  await client.close();
  await h.close();
});

test('REAUTH-007: ReauthRequired.is recognises one thrown by another copy of the package', () => {
  const foreign = Object.assign(new Error('x'), { [Symbol.for('dioschub.mcp-server.ReauthRequired')]: true });
  assert.equal(ReauthRequired.is(foreign), true);
  assert.equal(ReauthRequired.is(new ReauthRequired()), true);
  assert.equal(ReauthRequired.is(new Error('Unauthorized')), false);
  assert.equal(ReauthRequired.is(null), false);
});

test('REAUTH-008: runDeduplicated releases the entry when the call is released', async () => {
  const store = new MemoryIdempotencyStore();
  const opts = { ttlSeconds: 60, waitMs: 10, released: () => true };
  await runDeduplicated(store, 'scope', opts, async () => ({ content: [{ type: 'text', text: 'x' }] }));
  assert.equal(await store.get('scope'), null);
});

test('REAUTH-009: a custom store without release() reports it instead of failing the call', async () => {
  const inner = new MemoryIdempotencyStore();
  const store: IdempotencyStore = {
    claim: (s, t) => inner.claim(s, t),
    get: (s) => inner.get(s),
    complete: (s, r, t) => inner.complete(s, r, t),
  };
  const errors: unknown[] = [];
  const result = await runDeduplicated(
    store,
    'scope',
    { ttlSeconds: 60, waitMs: 10, released: () => true, onStoreError: (e) => errors.push(e) },
    async () => ({ content: [{ type: 'text', text: 'x' }] }),
  );
  assert.equal(result.content[0]!.text, 'x');
  assert.equal(errors.length, 1);
  assert.deepEqual(await inner.get('scope'), { state: 'running' });
});
