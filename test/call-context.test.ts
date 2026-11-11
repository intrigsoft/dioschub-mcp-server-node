import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { ToolContext } from '../src/index.js';
import { bindAndToken, rpc, startHarness } from './support.js';

type Ctx = ToolContext<{ sessionCookie: string }>;

/** A tool that records the context it was called with. */
async function recording() {
  const seen: Ctx[] = [];
  const h = await startHarness((s) => {
    s.tool({
      name: 'whoami',
      input: z.object({}),
      handler: (_args, ctx) => {
        seen.push(ctx);
        return { ok: true };
      },
    });
  });
  const token = await bindAndToken(h, 'conn-ctx');
  return { h, token, seen };
}

test('CTX-001: ctx.call carries the page and identity the Hub sends in _meta', async () => {
  const { h, token, seen } = await recording();
  const reply = await rpc(
    h.url,
    'tools/call',
    {
      name: 'whoami',
      arguments: {},
      _meta: {
        currentPath: '/patients/42?tab=meds',
        userId: 'u-1',
        tenantId: 'default',
        sessionId: 's-1',
        threadId: 't-1',
        'dioschub/idempotencyKey': 'k-1',
      },
    },
    token,
  );
  assert.equal(reply.status, 200);
  assert.notEqual(reply.body.result.isError, true);
  assert.deepEqual(seen[0]!.call, {
    currentPath: '/patients/42?tab=meds',
    userId: 'u-1',
    tenantId: 'default',
    sessionId: 's-1',
    threadId: 't-1',
  });
  await h.close();
});

test('CTX-002: ctx.meta is the raw _meta, read-only, including keys ctx.call does not model', async () => {
  const { h, token, seen } = await recording();
  await rpc(
    h.url,
    'tools/call',
    { name: 'whoami', arguments: {}, _meta: { currentPath: '/x', 'dioschub/future': { a: 1 } } },
    token,
  );
  const meta = seen[0]!.meta;
  assert.deepEqual(meta, { currentPath: '/x', 'dioschub/future': { a: 1 } });
  assert.ok(Object.isFrozen(meta));
  await h.close();
});

test('CTX-003: no _meta gives an empty call context and empty meta, not undefined', async () => {
  const { h, token, seen } = await recording();
  await rpc(h.url, 'tools/call', { name: 'whoami', arguments: {} }, token);
  assert.deepEqual(seen[0]!.call, {});
  assert.deepEqual(seen[0]!.meta, {});
  await h.close();
});

test('CTX-004: non-string context values are left out of ctx.call (still visible in ctx.meta)', async () => {
  const { h, token, seen } = await recording();
  await rpc(
    h.url,
    'tools/call',
    { name: 'whoami', arguments: {}, _meta: { currentPath: 42, userId: null, sessionId: 's-1' } },
    token,
  );
  assert.deepEqual(seen[0]!.call, { sessionId: 's-1' });
  assert.equal(seen[0]!.meta.currentPath, 42);
  await h.close();
});
