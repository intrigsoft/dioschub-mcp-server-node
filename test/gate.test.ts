import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { signHandle } from '../src/jwt.js';
import type { DioscMcpServer } from '../src/index.js';
import { JWT_SECRET, startHarness, toolCall } from './support.js';

const withTool = (s: DioscMcpServer<{ sessionCookie: string }>) => {
  s.tool({ name: 'noop', input: z.object({}), handler: () => ({ ok: true }) });
};

test('tools/call with no token → 401', async () => {
  const h = await startHarness(withTool);
  const res = await toolCall(h.url, 'noop', {});
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'missing_token');
  await h.close();
});

test('tools/call with a malformed token → 401 invalid_token', async () => {
  const h = await startHarness(withTool);
  const res = await toolCall(h.url, 'noop', {}, 'not-a-jwt');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'invalid_token');
  await h.close();
});

test('tools/call with a valid token whose jti is not in the store → 401 unbound', async () => {
  // The critical path: a well-formed handle that resolves to nothing must be a
  // clean 401 (→ Hub re-auth), never a 500.
  const h = await startHarness(withTool);
  const orphan = await signHandle({ jti: 'never-stored', aud: 'test-mcp' }, JWT_SECRET, 3600);
  const res = await toolCall(h.url, 'noop', {}, orphan);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'unbound');
  await h.close();
});
