import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryArtifactStore } from '../src/store/memory-store.js';
import { RedisArtifactStore, type RedisLike } from '../src/store/redis-store.js';
import type { BoundSession } from '../src/types.js';

interface Auth {
  cookie: string;
}
const session: BoundSession<Auth> = { connectionId: 'conn-1', artifacts: { cookie: 'c' } };

test('memory store: put → get returns the session', async () => {
  const store = new MemoryArtifactStore<Auth>();
  await store.put('j1', session, 3600);
  assert.deepEqual(await store.get('j1'), session);
  await store.close();
});

test('memory store: get on an unknown jti returns null (→ 401 upstream)', async () => {
  const store = new MemoryArtifactStore<Auth>();
  assert.equal(await store.get('missing'), null);
  await store.close();
});

test('memory store: an expired entry returns null', async () => {
  const store = new MemoryArtifactStore<Auth>();
  await store.put('j1', session, 0); // expiresAt = now → already expired on read
  assert.equal(await store.get('j1'), null);
  await store.close();
});

test('memory store: delete removes the entry', async () => {
  const store = new MemoryArtifactStore<Auth>();
  await store.put('j1', session, 3600);
  await store.delete('j1');
  assert.equal(await store.get('j1'), null);
  await store.close();
});

test('redis store: serializes with an EX ttl and round-trips via a fake client', async () => {
  const calls: Array<[string, string, string, number]> = [];
  const kv = new Map<string, string>();
  const fake: RedisLike = {
    async set(key, value, mode, ttl) {
      calls.push([key, value, mode, ttl]);
      kv.set(key, value);
    },
    async get(key) {
      return kv.get(key) ?? null;
    },
    async del(key) {
      kv.delete(key);
    },
    async quit() {},
  };
  const store = new RedisArtifactStore<Auth>({ client: fake });
  await store.put('j1', session, 900);
  assert.equal(calls[0]![0], 'diosc:mcp:session:j1');
  assert.equal(calls[0]![2], 'EX');
  assert.equal(calls[0]![3], 900);
  assert.deepEqual(await store.get('j1'), session);
  assert.equal(await store.get('nope'), null);
});
