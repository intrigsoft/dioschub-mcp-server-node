import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { z } from 'zod';
import * as api from '../src/index.js';
import {
  bind,
  bindAndToken,
  callWithKey,
  deferred,
  initialize,
  sleep,
  startHarness,
  startHarnessWith,
  toolCall,
  type Harness,
} from './support.js';

// Namespace import so a missing export fails only the tests that use it (C11 tests stay green on base).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MemoryIdempotencyStore = (api as any).MemoryIdempotencyStore as new () => object;

const IN_PROGRESS_MSG =
  'the call with this idempotency key is still running; its outcome is not known yet';

/** A counting tool. `gate` (optional) blocks the handler until resolved. */
function counting(h: { count: number }, gate?: Promise<void>) {
  return (s: Harness['server']) => {
    s.tool({
      name: 'count',
      input: z.object({ n: z.number().optional() }),
      handler: async (args) => {
        h.count += 1;
        // Capped so a missing dedup (handler re-run on a never-released gate) fails the test instead of hanging.
        if (gate) await Promise.race([gate, new Promise<void>((r) => setTimeout(r, 4000))]);
        return { run: h.count, echoed: args.n ?? null };
      },
    });
  };
}

const result = (r: { body: any }) => r.body.result;

// ---------------------------------------------------------------- IDEM-001 / C2

test('IDEM-001 C2: initialize advertises experimental["dioschub/idempotency"] by default', async () => {
  const h = await startHarness(counting({ count: 0 }));
  const res = await initialize(h.url);
  const caps = res.body.result.capabilities;
  assert.equal(typeof caps.experimental?.['dioschub/idempotency'], 'object');
  assert.notEqual(caps.experimental['dioschub/idempotency'], null);
  assert.deepEqual(caps.experimental['dioschub/idempotency'], { version: 1 });
  assert.ok(caps.tools, 'tools capability unchanged');
  await h.close();
});

test('IDEM-001 C2: idempotency:false removes the capability and runs no dedup', async () => {
  const c = { count: 0 };
  const h = await startHarnessWith({ idempotency: false }, counting(c));
  const caps = (await initialize(h.url)).body.result.capabilities;
  assert.equal(caps.experimental?.['dioschub/idempotency'], undefined);
  assert.ok(caps.tools, 'tools capability unchanged');
  const token = await bindAndToken(h, 'c1');
  await callWithKey(h.url, token, 'count', {}, 'k1');
  await callWithKey(h.url, token, 'count', {}, 'k1');
  assert.equal(c.count, 2, 'no dedup when disabled');
  await h.close();
});

// ---------------------------------------------------------------- IDEM-002 / C3, R8

test('IDEM-002 C3: a call with no key runs the handler every time', async () => {
  const c = { count: 0 };
  const h = await startHarness(counting(c));
  const token = await bindAndToken(h, 'c1');
  await callWithKey(h.url, token, 'count', {});
  await callWithKey(h.url, token, 'count', {});
  assert.equal(c.count, 2);
  await h.close();
});

for (const [label, bad] of [
  ['number', 42],
  ['empty string', ''],
  ['257 chars', 'x'.repeat(257)],
  ['object', { a: 1 }],
  ['null', null],
] as const) {
  test(`IDEM-002 C3 R8: malformed key (${label}) gets INVALID_IDEMPOTENCY_KEY and the handler does not run`, async () => {
    const c = { count: 0 };
    const h = await startHarness(counting(c));
    const token = await bindAndToken(h, 'c1');
    const r = result(await callWithKey(h.url, token, 'count', {}, bad));
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.success, false);
    assert.equal(r.structuredContent.code, 'INVALID_IDEMPOTENCY_KEY');
    assert.equal(typeof r.structuredContent.message, 'string');
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
    assert.equal(c.count, 0);
    await h.close();
  });
}

test('IDEM-002 C3: a 256-char key is valid', async () => {
  const c = { count: 0 };
  const h = await startHarness(counting(c));
  const token = await bindAndToken(h, 'c1');
  const r = result(await callWithKey(h.url, token, 'count', {}, 'k'.repeat(256)));
  assert.notEqual(r.isError, true);
  assert.equal(c.count, 1);
  await h.close();
});

// ---------------------------------------------------------------- IDEM-003 / C4, C5, R3

test('IDEM-003 C4: same key after finish returns the first result byte-for-byte; handler ran once', async () => {
  const c = { count: 0 };
  const h = await startHarness(counting(c));
  const token = await bindAndToken(h, 'c1');
  const first = result(await callWithKey(h.url, token, 'count', { n: 1 }, 'k1'));
  const second = result(await callWithKey(h.url, token, 'count', { n: 1 }, 'k1'));
  assert.equal(c.count, 1);
  assert.equal(JSON.stringify(second.content), JSON.stringify(first.content));
  assert.equal(JSON.stringify(second.structuredContent), JSON.stringify(first.structuredContent));
  assert.equal(second.isError, first.isError);
  await h.close();
});

test('IDEM-003 C4: arguments are not compared; the key identifies the call', async () => {
  const c = { count: 0 };
  const h = await startHarness(counting(c));
  const token = await bindAndToken(h, 'c1');
  const first = result(await callWithKey(h.url, token, 'count', { n: 1 }, 'k1'));
  const second = result(await callWithKey(h.url, token, 'count', { n: 999 }, 'k1'));
  assert.equal(c.count, 1);
  assert.equal(JSON.stringify(second.content), JSON.stringify(first.content));
  await h.close();
});

test('IDEM-003 C4: a different key runs the handler again', async () => {
  const c = { count: 0 };
  const h = await startHarness(counting(c));
  const token = await bindAndToken(h, 'c1');
  await callWithKey(h.url, token, 'count', {}, 'k1');
  await callWithKey(h.url, token, 'count', {}, 'k2');
  assert.equal(c.count, 2);
  await h.close();
});

test('IDEM-003 C5 R3: a throwing handler is finished; the duplicate gets the same error, no re-run', async () => {
  let runs = 0;
  const h = await startHarness((s) => {
    s.tool({
      name: 'boom',
      input: z.object({}),
      handler: () => {
        runs += 1;
        throw new Error('kaboom');
      },
    });
  });
  const token = await bindAndToken(h, 'c1');
  const first = result(await callWithKey(h.url, token, 'boom', {}, 'k1'));
  const second = result(await callWithKey(h.url, token, 'boom', {}, 'k1'));
  assert.equal(first.isError, true);
  assert.equal(second.isError, true);
  assert.equal(JSON.stringify(second.content), JSON.stringify(first.content));
  assert.equal(runs, 1);
  await h.close();
});

test('IDEM-003 C5 R3: a handler returning isError:true is finished and cached', async () => {
  let runs = 0;
  const h = await startHarness((s) => {
    s.tool({
      name: 'soft',
      input: z.object({}),
      handler: () => {
        runs += 1;
        return { isError: true, content: [{ type: 'text', text: 'nope' }] } as never;
      },
    });
  });
  const token = await bindAndToken(h, 'c1');
  const first = result(await callWithKey(h.url, token, 'soft', {}, 'k1'));
  const second = result(await callWithKey(h.url, token, 'soft', {}, 'k1'));
  assert.equal(runs, 1);
  assert.equal(second.isError, true);
  assert.equal(JSON.stringify(second.content), JSON.stringify(first.content));
  await h.close();
});

test('IDEM-003 C5 R3: a rejecting async handler never leaves the entry running (duplicate is not IN_PROGRESS)', async () => {
  let runs = 0;
  const h = await startHarnessWith({ idempotency: { waitMs: 100 } }, (s) => {
    s.tool({
      name: 'rej',
      input: z.object({}),
      handler: async () => {
        runs += 1;
        await sleep(10);
        throw new Error('late failure');
      },
    });
  });
  const token = await bindAndToken(h, 'c1');
  await callWithKey(h.url, token, 'rej', {}, 'k1');
  const second = result(await callWithKey(h.url, token, 'rej', {}, 'k1'));
  assert.equal(runs, 1);
  assert.notEqual(second.structuredContent?.code, 'IN_PROGRESS');
  assert.equal(second.isError, true);
  await h.close();
});

// ---------------------------------------------------------------- IDEM-004 / C6, R2

test('IDEM-004 C6: a duplicate that arrives while the first runs waits and gets the first result (finishes within waitMs)', async () => {
  const c = { count: 0 };
  const gate = deferred();
  const h = await startHarnessWith({ idempotency: { waitMs: 3000 } }, counting(c, gate.promise));
  const token = await bindAndToken(h, 'c1');
  const a = callWithKey(h.url, token, 'count', {}, 'k1');
  await sleep(100);
  const b = callWithKey(h.url, token, 'count', {}, 'k1');
  await sleep(100);
  gate.resolve();
  const [ra, rb] = [result(await a), result(await b)];
  assert.equal(c.count, 1);
  assert.equal(JSON.stringify(rb.content), JSON.stringify(ra.content));
  assert.notEqual(rb.isError, true);
  await h.close();
});

test('IDEM-004 C6: duplicate past waitMs gets IN_PROGRESS with the exact shape; handler not re-run', async () => {
  const c = { count: 0 };
  const gate = deferred();
  const h = await startHarnessWith({ idempotency: { waitMs: 100 } }, counting(c, gate.promise));
  const token = await bindAndToken(h, 'c1');
  const a = callWithKey(h.url, token, 'count', {}, 'k1');
  await sleep(100);
  const r = result(await callWithKey(h.url, token, 'count', {}, 'k1'));
  assert.equal(r.isError, true);
  assert.deepEqual(r.structuredContent, { success: false, code: 'IN_PROGRESS', message: IN_PROGRESS_MSG });
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, 'text');
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  assert.equal(c.count, 1);
  gate.resolve();
  await a;
  await h.close();
});

test('IDEM-004 C6 R2: late completion still lands in the entry; the next duplicate gets the real result', async () => {
  const c = { count: 0 };
  const gate = deferred();
  const h = await startHarnessWith({ idempotency: { waitMs: 80 } }, counting(c, gate.promise));
  const token = await bindAndToken(h, 'c1');
  const a = callWithKey(h.url, token, 'count', {}, 'k1');
  await sleep(100);
  const timedOut = result(await callWithKey(h.url, token, 'count', {}, 'k1'));
  assert.equal(timedOut.structuredContent.code, 'IN_PROGRESS');
  gate.resolve();
  const first = result(await a);
  const later = result(await callWithKey(h.url, token, 'count', {}, 'k1'));
  assert.equal(c.count, 1);
  assert.equal(JSON.stringify(later.content), JSON.stringify(first.content));
  await h.close();
});

test('IDEM-004 C6: the default waitMs is 30000 (a duplicate is still waiting after 1s)', async () => {
  const c = { count: 0 };
  const gate = deferred();
  const h = await startHarness(counting(c, gate.promise));
  const token = await bindAndToken(h, 'c1');
  const a = callWithKey(h.url, token, 'count', {}, 'k1');
  await sleep(100);
  let settled = false;
  const b = callWithKey(h.url, token, 'count', {}, 'k1').then((r) => {
    settled = true;
    return r;
  });
  await sleep(1000);
  assert.equal(settled, false, 'duplicate must still be waiting (default waitMs 30s)');
  gate.resolve();
  await a;
  const rb = result(await b);
  assert.notEqual(rb.isError, true);
  assert.equal(c.count, 1);
  await h.close();
});

// ---------------------------------------------------------------- IDEM-005 / C7, R5, R6

test('IDEM-005 C7 R5: the same key from a different connection runs as a fresh call', async () => {
  const c = { count: 0 };
  const h = await startHarness(counting(c));
  const tokenA = await bindAndToken(h, 'conn-A');
  const tokenB = await bindAndToken(h, 'conn-B');
  const a = result(await callWithKey(h.url, tokenA, 'count', {}, 'shared'));
  const b = result(await callWithKey(h.url, tokenB, 'count', {}, 'shared'));
  assert.equal(c.count, 2);
  assert.notEqual(JSON.stringify(a.content), JSON.stringify(b.content));
  // each connection still dedups on its own
  await callWithKey(h.url, tokenA, 'count', {}, 'shared');
  await callWithKey(h.url, tokenB, 'count', {}, 'shared');
  assert.equal(c.count, 2);
  await h.close();
});

test('IDEM-005 C7 R5: scope comes from the verified handle, not the request body', async () => {
  const c = { count: 0 };
  const h = await startHarness(counting(c));
  const tokenA = await bindAndToken(h, 'conn-A');
  const tokenB = await bindAndToken(h, 'conn-B');
  await callWithKey(h.url, tokenA, 'count', {}, 'k');
  // B claims to be A in the body (_meta / arguments); must still be a fresh call
  const res = await fetch(`${h.url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tokenB}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'count',
        arguments: { connectionId: 'conn-A' },
        _meta: { 'dioschub/idempotencyKey': 'k', connectionId: 'conn-A' },
      },
    }),
  });
  await res.text();
  assert.equal(c.count, 2);
  await h.close();
});

test('IDEM-005 C7 R6: the same key for a different tool name runs as a fresh call', async () => {
  const runs = { a: 0, b: 0 };
  const h = await startHarness((s) => {
    s.tool({ name: 'toolA', input: z.object({}), handler: () => ({ who: 'a', n: ++runs.a }) });
    s.tool({ name: 'toolB', input: z.object({}), handler: () => ({ who: 'b', n: ++runs.b }) });
  });
  const token = await bindAndToken(h, 'c1');
  const a = result(await callWithKey(h.url, token, 'toolA', {}, 'k'));
  const b = result(await callWithKey(h.url, token, 'toolB', {}, 'k'));
  assert.equal(runs.a, 1);
  assert.equal(runs.b, 1);
  assert.match(a.content[0].text, /"a"/);
  assert.match(b.content[0].text, /"b"/);
  await h.close();
});

// ---------------------------------------------------------------- IDEM-006 / C8, R1

test('IDEM-006 C8 R1: 5 concurrent calls, same scope and key: exactly one handler run, all get its result', async () => {
  const c = { count: 0 };
  const h = await startHarnessWith({ idempotency: { waitMs: 3000 } }, (s) => {
    s.tool({
      name: 'count',
      input: z.object({}),
      handler: async () => {
        c.count += 1;
        await sleep(200);
        return { run: c.count };
      },
    });
  });
  const token = await bindAndToken(h, 'c1');
  const rs = (await Promise.all(Array.from({ length: 5 }, () => callWithKey(h.url, token, 'count', {}, 'k')))).map(result);
  assert.equal(c.count, 1);
  const first = JSON.stringify(rs[0].content);
  for (const r of rs) {
    assert.notEqual(r.isError, true);
    assert.equal(JSON.stringify(r.content), first);
  }
  await h.close();
});

test('IDEM-006 C8: of N concurrent duplicates past waitMs, one runs and the rest get IN_PROGRESS', async () => {
  const c = { count: 0 };
  const gate = deferred();
  const h = await startHarnessWith({ idempotency: { waitMs: 80 } }, counting(c, gate.promise));
  const token = await bindAndToken(h, 'c1');
  const all = Promise.all(Array.from({ length: 5 }, () => callWithKey(h.url, token, 'count', {}, 'k')));
  await sleep(400);
  gate.resolve();
  const rs = (await all).map(result);
  assert.equal(c.count, 1);
  assert.equal(rs.filter((r) => r.structuredContent?.code === 'IN_PROGRESS').length, 4);
  await h.close();
});

// ---------------------------------------------------------------- IDEM-007 / C9, R4 (memory)

test('IDEM-007 C9: MemoryIdempotencyStore is exported and constructible', () => {
  assert.equal(typeof MemoryIdempotencyStore, 'function');
  assert.ok(new MemoryIdempotencyStore());
});

test('IDEM-007 C9: an entry expires after ttlSeconds (same key then runs fresh)', async () => {
  const c = { count: 0 };
  const h = await startHarnessWith({ idempotency: { ttlSeconds: 1 } }, counting(c));
  const token = await bindAndToken(h, 'c1');
  await callWithKey(h.url, token, 'count', {}, 'k');
  await callWithKey(h.url, token, 'count', {}, 'k');
  assert.equal(c.count, 1);
  await sleep(1300);
  await callWithKey(h.url, token, 'count', {}, 'k');
  assert.equal(c.count, 2);
  await h.close();
});

test('IDEM-007 C9 R4: a running (never-finishing) entry keeps answering IN_PROGRESS within its TTL, never a re-run', async () => {
  const c = { count: 0 };
  const gate = deferred();
  const h = await startHarnessWith({ idempotency: { ttlSeconds: 30, waitMs: 50 } }, counting(c, gate.promise));
  const token = await bindAndToken(h, 'c1');
  const a = callWithKey(h.url, token, 'count', {}, 'k');
  await sleep(100);
  for (let i = 0; i < 3; i += 1) {
    const r = result(await callWithKey(h.url, token, 'count', {}, 'k'));
    assert.equal(r.structuredContent.code, 'IN_PROGRESS');
  }
  assert.equal(c.count, 1);
  gate.resolve();
  await a;
  await h.close();
});

test('IDEM-007 C9: a custom store passed in config is used (store option accepted)', async () => {
  const c = { count: 0 };
  const store = new MemoryIdempotencyStore();
  const h = await startHarnessWith({ idempotency: { store } }, counting(c));
  const token = await bindAndToken(h, 'c1');
  await callWithKey(h.url, token, 'count', {}, 'k');
  await callWithKey(h.url, token, 'count', {}, 'k');
  assert.equal(c.count, 1);
  await h.close();
});

// ---------------------------------------------------------------- IDEM-008 / C10 (memory)

test('IDEM-008 C10: the memory store holds neither the bearer token nor the auth artifacts', async () => {
  const c = { count: 0 };
  const store = new MemoryIdempotencyStore();
  const h = await startHarnessWith({ idempotency: { store } }, counting(c));
  const token = await bindAndToken(h, 'conn-secret');
  await callWithKey(h.url, token, 'count', {}, 'k');
  const dump = inspect(store, { depth: null, maxArrayLength: null, showHidden: true });
  assert.equal(dump.includes(token), false, 'bearer token must not be stored');
  assert.equal(dump.includes('cookie-conn-secret'), false, 'auth artifacts must not be stored');
  assert.ok(dump.includes('"run"') || dump.includes('run'), 'the handler result is stored');
  await h.close();
});

// ---------------------------------------------------------------- C11 (also green on base)

test('IDEM-001 C11 R7: an unauthenticated tools/call with a key gets 401 and runs nothing', async () => {
  const c = { count: 0 };
  const h = await startHarnessWith({}, counting(c));
  const noToken = await callWithKey(h.url, undefined, 'count', {}, 'k');
  assert.equal(noToken.status, 401);
  const badToken = await callWithKey(h.url, 'not-a-jwt', 'count', {}, 'k');
  assert.equal(badToken.status, 401);
  assert.equal(c.count, 0);
  // no entry was created: a later authenticated call with the same key runs
  const token = await bindAndToken(h, 'c1');
  await callWithKey(h.url, token, 'count', {}, 'k');
  assert.equal(c.count, 1);
  await h.close();
});

test('IDEM-001 C11: a bound-but-revoked/unbound handle with a key still gets 401 before dedup', async () => {
  const c = { count: 0 };
  const h = await startHarness(counting(c));
  const res = await toolCall(h.url, 'count', {}, 'not-a-jwt');
  assert.equal(res.status, 401);
  await res.text();
  assert.equal(c.count, 0);
  await h.close();
});

test('IDEM-001 C11: bind and a plain tool call (no key) keep working unchanged', async () => {
  const c = { count: 0 };
  const h = await startHarness(counting(c));
  const res = await bind(h.url, 'c1', { sessionCookie: 'x' });
  assert.equal(res.status, 200);
  const token = h.hub.lastToken();
  const r = result(await callWithKey(h.url, token, 'count', { n: 7 }));
  assert.match(r.content[0].text, /"echoed":7/);
  await h.close();
});
