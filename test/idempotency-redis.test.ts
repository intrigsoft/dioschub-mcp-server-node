import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import * as api from '../src/index.js';
import { MemoryArtifactStore } from '../src/store/memory-store.js';
import { bind, callWithKey, deferred, sleep, startHarnessWith, capturingHub, type Harness } from './support.js';

// Namespace import: a missing export fails only the tests that use it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RedisIdempotencyStore = (api as any).RedisIdempotencyStore as new (o: object) => object;

/**
 * Fake Redis. ASSUMED SHAPE (see tests.md): the store talks ioredis-style positional
 * commands: set(key, value, ...args) where args may hold 'EX'|'PX' <n> and 'NX'|'XX';
 * get(key); del(key); quit(). Tests assert only on the observable commands recorded
 * here (NX claim, key prefix, TTL) and drive everything through the HTTP server.
 */
class FakeRedis {
  readonly kv = new Map<string, { v: string; exp: number }>();
  readonly commands: Array<{ cmd: string; args: unknown[] }> = [];

  private live(key: string) {
    const e = this.kv.get(key);
    if (!e) return undefined;
    if (e.exp <= Date.now()) {
      this.kv.delete(key);
      return undefined;
    }
    return e;
  }
  async set(key: string, value: string, ...rest: unknown[]) {
    this.commands.push({ cmd: 'set', args: [key, value, ...rest] });
    const flags = rest.map((x) => String(x).toUpperCase());
    const nx = flags.includes('NX');
    const xx = flags.includes('XX');
    let ttlMs = Infinity;
    const ex = flags.indexOf('EX');
    if (ex >= 0) ttlMs = Number(rest[ex + 1]) * 1000;
    const px = flags.indexOf('PX');
    if (px >= 0) ttlMs = Number(rest[px + 1]);
    const exists = this.live(key) !== undefined;
    if (nx && exists) return null;
    if (xx && !exists) return null;
    this.kv.set(key, { v: value, exp: Date.now() + ttlMs });
    return 'OK';
  }
  async get(key: string) {
    this.commands.push({ cmd: 'get', args: [key] });
    return this.live(key)?.v ?? null;
  }
  async del(key: string) {
    this.commands.push({ cmd: 'del', args: [key] });
    return this.kv.delete(key) ? 1 : 0;
  }
  async quit() {
    return 'OK';
  }
  setCalls() {
    return this.commands.filter((c) => c.cmd === 'set');
  }
  nxClaims() {
    return this.setCalls().filter((c) => c.args.some((a) => String(a).toUpperCase() === 'NX'));
  }
}

function counting(c: { count: number }, gate?: Promise<void>, delayMs = 0) {
  return (s: Harness['server']) => {
    s.tool({
      name: 'count',
      input: z.object({}),
      handler: async () => {
        c.count += 1;
        if (delayMs) await sleep(delayMs);
        if (gate) await gate;
        return { run: c.count };
      },
    });
  };
}

const result = (r: { body: any }) => r.body.result;

async function boot(
  fake: FakeRedis,
  c: { count: number },
  opts: { prefix?: string; ttlSeconds?: number; waitMs?: number; gate?: Promise<void>; delayMs?: number; artifacts?: MemoryArtifactStore<{ sessionCookie: string }> } = {},
) {
  const store = new RedisIdempotencyStore({ client: fake, ...(opts.prefix ? { keyPrefix: opts.prefix } : {}) });
  return startHarnessWith(
    {
      ...(opts.artifacts ? { store: opts.artifacts } : {}),
      idempotency: { store, ttlSeconds: opts.ttlSeconds, waitMs: opts.waitMs },
    },
    counting(c, opts.gate, opts.delayMs),
  );
}

async function tokenFor(h: Harness, conn: string) {
  assert.equal((await bind(h.url, conn, { sessionCookie: `cookie-${conn}` })).status, 200);
  return h.hub.lastToken();
}

test('IDEM-007 C9: RedisIdempotencyStore is exported from the package index', () => {
  assert.equal(typeof RedisIdempotencyStore, 'function');
  assert.equal(typeof (api as any).MemoryIdempotencyStore, 'function');
});

test('IDEM-007 C9: construction with a url is lazy (no ioredis load / connection until used)', () => {
  assert.doesNotThrow(() => new RedisIdempotencyStore({ url: 'redis://127.0.0.1:1' }));
});

test('IDEM-006 C8: the claim is an atomic SET … NX with an EX ttl (default 3600)', async () => {
  const fake = new FakeRedis();
  const c = { count: 0 };
  const h = await boot(fake, c);
  const token = await tokenFor(h, 'c1');
  await callWithKey(h.url, token, 'count', {}, 'k1');
  const claims = fake.nxClaims();
  assert.ok(claims.length >= 1, 'a SET … NX claim was issued');
  const args = claims[0]!.args.map((a) => String(a).toUpperCase());
  const ex = args.indexOf('EX');
  assert.ok(ex >= 0, 'claim carries an EX ttl');
  assert.equal(Number(claims[0]!.args[ex + 1]), 3600);
  await h.close();
});

test('IDEM-007 C9: ttlSeconds from config is the Redis EX on every write (running and done)', async () => {
  const fake = new FakeRedis();
  const c = { count: 0 };
  const h = await boot(fake, c, { ttlSeconds: 77 });
  const token = await tokenFor(h, 'c1');
  await callWithKey(h.url, token, 'count', {}, 'k1');
  const sets = fake.setCalls();
  assert.ok(sets.length >= 2, 'a running write and a done write');
  for (const s of sets) {
    const flags = s.args.map((a) => String(a).toUpperCase());
    const ex = flags.indexOf('EX');
    assert.ok(ex >= 0, 'every write has an EX ttl');
    assert.equal(Number(s.args[ex + 1]), 77);
  }
  await h.close();
});

test('IDEM-007 C9: every key is under the configured keyPrefix', async () => {
  const fake = new FakeRedis();
  const c = { count: 0 };
  const h = await boot(fake, c, { prefix: 'tst:idem:' });
  const token = await tokenFor(h, 'c1');
  await callWithKey(h.url, token, 'count', {}, 'k1');
  assert.ok(fake.commands.length > 0);
  for (const cmd of fake.commands) assert.ok(String(cmd.args[0]).startsWith('tst:idem:'), `key ${String(cmd.args[0])}`);
  await h.close();
});

test('IDEM-007 C9: default keyPrefix is namespaced under diosc:mcp: (and not the session prefix)', async () => {
  const fake = new FakeRedis();
  const c = { count: 0 };
  const h = await boot(fake, c);
  const token = await tokenFor(h, 'c1');
  await callWithKey(h.url, token, 'count', {}, 'k1');
  for (const cmd of fake.commands) {
    const key = String(cmd.args[0]);
    assert.ok(key.startsWith('diosc:mcp:'), key);
    assert.ok(!key.startsWith('diosc:mcp:session:'), key);
  }
  await h.close();
});

test('IDEM-004 C4 (redis): second call with the same key returns the cached result, handler ran once', async () => {
  const fake = new FakeRedis();
  const c = { count: 0 };
  const h = await boot(fake, c);
  const token = await tokenFor(h, 'c1');
  const a = result(await callWithKey(h.url, token, 'count', {}, 'k1'));
  const b = result(await callWithKey(h.url, token, 'count', {}, 'k1'));
  assert.equal(c.count, 1);
  assert.equal(JSON.stringify(b.content), JSON.stringify(a.content));
  await h.close();
});

test('IDEM-006 C8 R1: two replicas sharing one Redis: concurrent same key runs the handler once', async () => {
  const fake = new FakeRedis();
  const c = { count: 0 };
  const sessions = new MemoryArtifactStore<{ sessionCookie: string }>();
  const hub = capturingHub();
  const mk = async () => {
    const store = new RedisIdempotencyStore({ client: fake });
    return startHarnessWith(
      { store: sessions, idempotency: { store, waitMs: 3000 } },
      counting(c, undefined, 250),
      hub,
    );
  };
  const r1 = await mk();
  const r2 = await mk();
  const token = await tokenFor(r1, 'c1'); // handle resolves on both replicas (shared session store)
  const [a, b] = await Promise.all([
    callWithKey(r1.url, token, 'count', {}, 'k1'),
    callWithKey(r2.url, token, 'count', {}, 'k1'),
  ]);
  assert.equal(c.count, 1);
  assert.equal(JSON.stringify(result(a).content), JSON.stringify(result(b).content));
  assert.notEqual(result(a).isError, true);
  assert.equal(fake.nxClaims().length >= 2, true, 'both replicas attempted the NX claim');
  await r1.close();
  await r2.close();
});

test('IDEM-004 C6 R4 (redis): past waitMs the duplicate gets IN_PROGRESS; a late finish serves the next duplicate', async () => {
  const fake = new FakeRedis();
  const c = { count: 0 };
  const gate = deferred();
  const h = await boot(fake, c, { waitMs: 80, gate: gate.promise });
  const token = await tokenFor(h, 'c1');
  const a = callWithKey(h.url, token, 'count', {}, 'k1');
  await sleep(120);
  const r = result(await callWithKey(h.url, token, 'count', {}, 'k1'));
  assert.equal(r.structuredContent.code, 'IN_PROGRESS');
  assert.equal(c.count, 1);
  gate.resolve();
  const first = result(await a);
  const later = result(await callWithKey(h.url, token, 'count', {}, 'k1'));
  assert.equal(c.count, 1);
  assert.equal(JSON.stringify(later.content), JSON.stringify(first.content));
  await h.close();
});

test('IDEM-005 C7 R5 R6 (redis): scope is (connectionId, tool, key): different connection never sees the entry', async () => {
  const fake = new FakeRedis();
  const c = { count: 0 };
  const h = await boot(fake, c);
  const tA = await tokenFor(h, 'conn-A');
  const tB = await tokenFor(h, 'conn-B');
  await callWithKey(h.url, tA, 'count', {}, 'shared');
  await callWithKey(h.url, tB, 'count', {}, 'shared');
  assert.equal(c.count, 2);
  await h.close();
});

test('IDEM-008 C10 (redis): no key or value written to Redis contains the bearer token or the auth artifacts', async () => {
  const fake = new FakeRedis();
  const c = { count: 0 };
  const h = await boot(fake, c);
  const token = await tokenFor(h, 'conn-secret');
  await callWithKey(h.url, token, 'count', {}, 'k1');
  assert.ok(fake.setCalls().length > 0);
  for (const cmd of fake.commands) {
    const blob = cmd.args.map((a) => String(a)).join('\n');
    assert.equal(blob.includes(token), false, 'bearer token must not reach Redis');
    assert.equal(blob.includes('cookie-conn-secret'), false, 'auth artifacts must not reach Redis');
  }
  // the handler result (after the dev guard) is what is stored
  assert.ok(fake.setCalls().some((s) => String(s.args[1]).includes('run')));
  await h.close();
});

test('IDEM-001 C11 R7 (redis): an unauthenticated call with a key gets 401 and touches Redis not at all', async () => {
  const fake = new FakeRedis();
  const c = { count: 0 };
  const h = await boot(fake, c);
  const res = await callWithKey(h.url, undefined, 'count', {}, 'k1');
  assert.equal(res.status, 401);
  assert.equal(fake.commands.length, 0);
  assert.equal(c.count, 0);
  await h.close();
});
