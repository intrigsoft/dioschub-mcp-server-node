import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer, TestUsersConfigError, type TestUsersConfig } from '../src/index.js';
import { ADMIN_KEY, JWT_SECRET, bind, capturingHub, initialize, rpc } from './support.js';
import {
  SENTINEL,
  USERS,
  capturingLogger,
  decode,
  fakeHub,
  post,
  startTestUsers,
  testSignIn,
  type Auth,
} from './test-users-support.js';

const login: TestUsersConfig<Auth>['login'] = async () => ({
  auth: { sessionCookie: 'c' },
  identity: { userId: 'u', username: 'n', role: { id: 'r', name: 'R' } },
});

/** createMcpServer with a given list; returns the thrown error (or null) and the log text. */
function boot(users: unknown, extra: Partial<TestUsersConfig<Auth>> = {}) {
  const logger = capturingLogger();
  try {
    createMcpServer<Auth>({
      name: 'test-mcp',
      adminKey: ADMIN_KEY,
      jwtSecrets: JWT_SECRET,
      hubClient: fakeHub(),
      logger,
      testUsers: { users: users as string, login, ...extra },
    });
    return { error: null as Error | null, logs: logger.text() };
  } catch (err) {
    return { error: err as Error, logs: logger.text() };
  }
}

const entry = (over: Record<string, unknown> = {}) => ({
  key: 'alice',
  name: 'Alice',
  credentials: { password: SENTINEL },
  ...over,
});

// ------------------------------------------------------------------ config validation

const invalidLists: Array<[string, unknown]> = [
  // V8 quotes the start of the text in a JSON.parse message: put the credential there.
  ['not valid JSON', `${SENTINEL}[{"key":"alice"}]`],
  ['truncated JSON', `[{"key":"alice","name":"A","credentials":"${SENTINEL}"`],
  ['not a list', JSON.stringify({ key: 'alice', credentials: SENTINEL })],
  ['an entry that is not an object', JSON.stringify([SENTINEL])],
  ['a key with capitals', JSON.stringify([entry({ key: 'Alice' })])],
  ['a key starting with a dot', JSON.stringify([entry({ key: '.alice' })])],
  ['an empty key', JSON.stringify([entry({ key: '' })])],
  ['a key of 65 characters', JSON.stringify([entry({ key: 'a'.repeat(65) })])],
  ['a key that is not a string', JSON.stringify([entry({ key: 7 })])],
  ['a missing key', JSON.stringify([{ name: 'A', credentials: SENTINEL }])],
  ['a duplicate key', JSON.stringify([entry(), entry({ name: 'Other' })])],
  ['an empty name', JSON.stringify([entry({ name: '' })])],
  ['a name of 101 characters', JSON.stringify([entry({ name: 'n'.repeat(101) })])],
  ['a name that is not a string', JSON.stringify([entry({ name: 5 })])],
  ['a note of 201 characters', JSON.stringify([entry({ note: 'n'.repeat(201) })])],
  ['a note that is not a string', JSON.stringify([entry({ note: 1 })])],
  ['readOnly that is not a boolean', JSON.stringify([entry({ readOnly: 'yes' })])],
  ['missing credentials', JSON.stringify([{ key: 'alice', name: 'Alice' }])],
  ['null credentials', JSON.stringify([{ key: 'alice', name: 'Alice', credentials: null }])],
  [
    'more than 50 entries',
    JSON.stringify(Array.from({ length: 51 }, (_, i) => entry({ key: `user-${i}` }))),
  ],
  ['a parsed list with a bad key', [entry({ key: 'BAD' })]],
];

for (const [what, users] of invalidLists) {
  test(`TU-CFG: start-up fails closed on ${what}, without quoting the list`, () => {
    const { error, logs } = boot(users);
    assert.ok(error instanceof TestUsersConfigError, `expected TestUsersConfigError, got ${error}`);
    // Even a fragment: the first 8 characters of the sentinel.
    assert.ok(!error.message.includes(SENTINEL.slice(0, 8)), 'the error quotes a credential');
    assert.ok(!String(error.stack).includes(SENTINEL.slice(0, 8)), 'the stack quotes a credential');
    assert.equal((error as Error & { cause?: unknown }).cause, undefined);
    assert.ok(!logs.includes(SENTINEL.slice(0, 8)), 'a log line quotes a credential');
  });
}

test('TU-CFG: a duplicate key error names positions, not the key or other values', () => {
  const { error } = boot(JSON.stringify([entry({ key: 'zed-unique-key' }), entry({ key: 'zed-unique-key' })]));
  assert.ok(error instanceof TestUsersConfigError);
  assert.match(error.message, /entry 1/);
  assert.ok(!error.message.includes('zed-unique-key'));
});

test('TU-CFG: the limits are inclusive (50 entries, 64-char key, 100-char name, 200-char note)', () => {
  const list = Array.from({ length: 50 }, (_, i) =>
    entry({ key: `u${i}-${'k'.repeat(60)}`.slice(0, 64), name: 'n'.repeat(100), note: 'm'.repeat(200) }),
  );
  assert.equal(new Set(list.map((e) => e.key)).size, 50);
  assert.equal(boot(JSON.stringify(list)).error, null);
});

test('TU-CFG: login must be a function, onEvent a function, rateLimitPerMinute a positive integer', () => {
  const good = JSON.stringify([entry()]);
  assert.ok(boot(good, { login: 'nope' as never }).error instanceof TestUsersConfigError);
  assert.ok(boot(good, { onEvent: 5 as never }).error instanceof TestUsersConfigError);
  assert.ok(boot(good, { rateLimitPerMinute: 0 }).error instanceof TestUsersConfigError);
  assert.ok(boot(good, { rateLimitPerMinute: 1.5 }).error instanceof TestUsersConfigError);
});

test('TU-CFG: the list is read from DIOSC_TEST_USERS by default, or the named variable', async (t) => {
  const saved = { a: process.env.DIOSC_TEST_USERS, b: process.env.MY_TEST_USERS };
  t.after(() => {
    for (const [k, v] of [['DIOSC_TEST_USERS', saved.a], ['MY_TEST_USERS', saved.b]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  process.env.DIOSC_TEST_USERS = JSON.stringify([entry({ key: 'from-default-env' })]);
  const a = await startTestUsers({ testUsers: { users: undefined } });
  a.hub.tickets.set('L', { purpose: 'list' });
  assert.deepEqual((await post(a.url, '/test-users', { ticket: 'L' })).json.users.map((u: any) => u.key), [
    'from-default-env',
  ]);
  await a.close();

  process.env.MY_TEST_USERS = JSON.stringify([entry({ key: 'from-named-env' })]);
  const b = await startTestUsers({ testUsers: { users: undefined, env: 'MY_TEST_USERS' } });
  b.hub.tickets.set('L', { purpose: 'list' });
  assert.deepEqual((await post(b.url, '/test-users', { ticket: 'L' })).json.users.map((u: any) => u.key), [
    'from-named-env',
  ]);
  await b.close();

  process.env.DIOSC_TEST_USERS = SENTINEL + ' not json';
  const { error, logs } = boot(undefined);
  assert.ok(error instanceof TestUsersConfigError);
  assert.match(error.message, /DIOSC_TEST_USERS is not valid JSON/);
  assert.ok(!error.message.includes(SENTINEL.slice(0, 8)) && !logs.includes(SENTINEL.slice(0, 8)));
});

// ------------------------------------------------------------------ feature off

async function assertOff(h: Awaited<ReturnType<typeof startTestUsers>>) {
  for (const path of ['/test-users', '/test-bind']) {
    const res = await post(h.url, path, { ticket: 't', userKey: 'alice' });
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.json, { error: 'not_found', code: 'test_users_disabled' }, path);
  }
  const caps = (await initialize(h.url)).body.result.capabilities;
  assert.equal(caps.experimental?.['dioschub/testUsers'], undefined);
  assert.deepEqual(caps.experimental?.['dioschub/idempotency'], { version: 1 }, 'idempotency unaffected');
  assert.equal(h.hub.verifies.length, 0, 'the hub is never asked');
}

test('TU-OFF: without testUsers every test route answers 404 test_users_disabled, no capability', async () => {
  const h = await startTestUsers({ testUsers: null });
  await assertOff(h);
  await h.close();
});

for (const [what, users] of [
  ['an empty string', ''],
  ['whitespace', '   '],
  ['an empty list', '[]'],
  ['an empty parsed list', []],
] as const) {
  test(`TU-OFF: a list that is ${what} turns the feature off`, async () => {
    const h = await startTestUsers({ testUsers: { users: users as never } });
    await assertOff(h);
    await h.close();
  });
}

test('TU-OFF: an unset variable turns the feature off', async (t) => {
  const saved = process.env.DIOSC_TEST_USERS;
  delete process.env.DIOSC_TEST_USERS;
  t.after(() => {
    if (saved !== undefined) process.env.DIOSC_TEST_USERS = saved;
  });
  const h = await startTestUsers({ testUsers: { users: undefined } });
  await assertOff(h);
  await h.close();
});

test('TU-OFF: a hub client without the test calls turns the feature off, with a warning', async () => {
  const h = await startTestUsers({ hub: capturingHub() });
  await assertOff(h);
  assert.match(h.logger.text(), /test users off: the hub client cannot make the test calls/);
  await h.close();
});

test('TU-CAP: when on, initialize declares dioschub/testUsers next to dioschub/idempotency', async () => {
  const h = await startTestUsers();
  const caps = (await initialize(h.url)).body.result.capabilities;
  assert.deepEqual(caps.experimental['dioschub/testUsers'], { version: 1 });
  assert.deepEqual(caps.experimental['dioschub/idempotency'], { version: 1 });
  await h.close();
});

test('TU-CAP: with idempotency off the test users capability is still declared alone', async () => {
  const h = await startTestUsers({ extra: { idempotency: false } });
  const caps = (await initialize(h.url)).body.result.capabilities;
  assert.deepEqual(caps.experimental, { 'dioschub/testUsers': { version: 1 } });
  await h.close();
});

// ------------------------------------------------------------------ list

test('TU-LIST: a list ticket confirmed by the hub returns the public parts only', async () => {
  const h = await startTestUsers();
  h.hub.tickets.set('t-list', { purpose: 'list' });
  const res = await post(h.url, '/test-users', { ticket: 't-list' });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json), ['users']);
  assert.deepEqual(res.json.users, [
    { key: 'alice', name: 'Alice (test)', readOnly: false },
    { key: 'bob.ro', name: 'Bob, read only', note: 'Sees everything, changes nothing', readOnly: true },
  ]);
  for (const u of res.json.users) {
    assert.ok(Object.keys(u).every((k) => ['key', 'name', 'note', 'readOnly'].includes(k)));
  }
  assert.ok(!res.text.includes(SENTINEL), 'a credential is in the answer');
  assert.ok(!res.text.includes('credentials'));
  assert.deepEqual(h.hub.verifies, [{ ticket: 't-list', purpose: 'list' }]);
  assert.ok(!h.logger.text().includes(SENTINEL));
  assert.ok(!h.logger.text().includes('t-list'), 'the ticket is logged');
  await h.close();
});

test('TU-LIST: an unknown, reused or bind-purpose ticket gets 401 invalid_ticket and no list', async () => {
  const h = await startTestUsers();
  h.hub.tickets.set('t-list', { purpose: 'list' });
  h.hub.tickets.set('t-bind', { purpose: 'bind', userKey: 'alice' });
  assert.equal((await post(h.url, '/test-users', { ticket: 't-list' })).status, 200);
  for (const ticket of ['t-list' /* consumed */, 'nope', 't-bind']) {
    const res = await post(h.url, '/test-users', { ticket });
    assert.equal(res.status, 401, ticket);
    assert.deepEqual(res.json, { error: 'unauthorized', code: 'invalid_ticket' });
  }
  await h.close();
});

test('TU-LIST: a missing ticket is 400; a hub that cannot be asked is 502 hub_unreachable', async () => {
  const h = await startTestUsers();
  const missing = await post(h.url, '/test-users', {});
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'missing_fields');
  assert.equal(h.hub.verifies.length, 0);
  h.hub.failVerify = true;
  const down = await post(h.url, '/test-users', { ticket: 'x' });
  assert.equal(down.status, 502);
  assert.deepEqual(down.json, { error: 'ticket_check_failed', code: 'hub_unreachable' });
  await h.close();
});

// ------------------------------------------------------------------ bind

test('TU-BIND: checks the ticket, then logs in, then delivers the handle; the answer has no handle', async () => {
  const h = await startTestUsers();
  const before = Math.floor(Date.now() / 1000);
  h.hub.tickets.set('t-1', { purpose: 'bind', userKey: 'alice' });
  const res = await post(h.url, '/test-bind', { ticket: 't-1', userKey: 'alice' });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['expiresAt', 'ok']);
  assert.equal(res.json.ok, true);
  assert.deepEqual(h.order, ['verify:bind', 'login', 'testBind']);
  assert.deepEqual(h.hub.verifies, [{ ticket: 't-1', purpose: 'bind', userKey: 'alice' }]);

  // login got the private part and the public part, separately.
  assert.deepEqual(h.logins, [
    {
      credentials: { username: 'alice', password: SENTINEL },
      entry: { key: 'alice', name: 'Alice (test)', readOnly: false },
    },
  ]);

  const d = h.hub.deliveries[0]!;
  assert.equal(d.ticket, 't-1');
  assert.equal(d.userKey, 'alice');
  assert.equal(d.readOnly, false);
  assert.deepEqual(d.identity, { userId: 'u-alice', username: 'alice', role: { id: 'r-1', name: 'Clerk' } });
  assert.equal(d.expiresAt, res.json.expiresAt);
  assert.ok(!res.text.includes(d.token), 'the handle is in the answer');
  assert.ok(!res.text.includes(d.token.split('.')[2]!), 'the handle signature is in the answer');

  // Claims: the usual four plus test and tu; no ro for a read-write user.
  const claims = decode(d.token);
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'jti', 'test', 'tu']);
  assert.equal(claims.test, true);
  assert.equal(claims.tu, 'alice');
  assert.equal(claims.aud, 'test-mcp');
  assert.equal((claims.exp as number) - (claims.iat as number), 3600, '60 minutes, fixed');
  assert.ok((claims.iat as number) >= before);
  assert.equal(new Date((claims.exp as number) * 1000).toISOString(), res.json.expiresAt);

  // Stored as for a real user, under the handle's jti, for the same 60 minutes.
  assert.equal(h.store.puts.length, 1);
  assert.equal(h.store.puts[0]!.jti, claims.jti);
  assert.equal(h.store.puts[0]!.ttl, 3600);
  assert.deepEqual(h.store.puts[0]!.session.artifacts, { sessionCookie: 'session-for-alice' });

  const logs = h.logger.text();
  assert.ok(!logs.includes(SENTINEL), 'a credential was logged');
  assert.ok(!logs.includes(d.token), 'the handle was logged');
  assert.ok(!logs.includes('t-1'), 'the ticket was logged');
  await h.close();
});

test('TU-BIND: a read-only entry gets ro: true in the handle and readOnly in the delivery', async () => {
  const h = await startTestUsers();
  const { delivery } = await testSignIn(h, 'bob.ro');
  assert.equal(delivery.readOnly, true);
  const claims = decode(delivery.token);
  assert.equal(claims.ro, true);
  assert.equal(claims.tu, 'bob.ro');
  await h.close();
});

test('TU-BIND: login is never run when the hub says the ticket is invalid', async () => {
  const h = await startTestUsers();
  h.hub.tickets.set('t-for-bob', { purpose: 'bind', userKey: 'bob.ro' });
  h.hub.tickets.set('t-list', { purpose: 'list' });
  for (const [ticket, userKey] of [
    ['t-unknown', 'alice'],
    ['t-for-bob', 'alice'], // issued for another user
    ['t-list', 'alice'], // wrong purpose
  ]) {
    const res = await post(h.url, '/test-bind', { ticket, userKey });
    assert.equal(res.status, 401, ticket);
    assert.deepEqual(res.json, { error: 'unauthorized', code: 'invalid_ticket' });
  }
  assert.equal(h.logins.length, 0);
  assert.equal(h.hub.deliveries.length, 0);
  assert.equal(h.store.puts.length, 0);
  await h.close();
});

test('TU-BIND: missing ticket or userKey is 400 and the hub is not asked', async () => {
  const h = await startTestUsers();
  for (const body of [{}, { ticket: 't' }, { userKey: 'alice' }, { ticket: 5, userKey: 'alice' }]) {
    const res = await post(h.url, '/test-bind', body);
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'missing_fields');
  }
  assert.equal(h.hub.verifies.length, 0);
  await h.close();
});

test('TU-BIND: a user not in the list is 404 unknown_test_user, after the ticket check, without login', async () => {
  const h = await startTestUsers();
  h.hub.tickets.set('t-ghost', { purpose: 'bind', userKey: 'ghost' });
  const res = await post(h.url, '/test-bind', { ticket: 't-ghost', userKey: 'ghost' });
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { error: 'not_found', code: 'unknown_test_user' });
  assert.deepEqual(h.order, ['verify:bind']);
  assert.equal(h.logins.length, 0);
  // A stranger without a valid ticket cannot probe which keys exist.
  const probe = await post(h.url, '/test-bind', { ticket: 'forged', userKey: 'ghost' });
  assert.equal(probe.status, 401);
  await h.close();
});

test("TU-BIND: a failed login is 502 test_login_failed with none of the auth service's message", async () => {
  const h = await startTestUsers({
    testUsers: {
      async login(credentials) {
        throw new Error(`auth service said: bad password ${(credentials as { password: string }).password}`);
      },
    },
  });
  h.hub.tickets.set('t-1', { purpose: 'bind', userKey: 'alice' });
  const res = await post(h.url, '/test-bind', { ticket: 't-1', userKey: 'alice' });
  assert.equal(res.status, 502);
  assert.deepEqual(res.json, { error: 'test_bind_failed', code: 'test_login_failed' });
  assert.ok(!res.text.includes(SENTINEL) && !res.text.includes('auth service said'));
  const logs = h.logger.text();
  assert.ok(!logs.includes(SENTINEL), 'a credential was logged');
  assert.ok(!logs.includes('auth service said'), "the auth service's message was logged");
  assert.ok(!JSON.stringify(h.events).includes(SENTINEL));
  assert.equal(h.store.puts.length, 0, 'nothing stored');
  assert.equal(h.hub.deliveries.length, 0, 'nothing delivered');
  await h.close();
});

test('TU-BIND: a login that returns no auth or a bad identity is 502 test_login_failed', async () => {
  for (const bad of [
    undefined,
    { identity: { userId: 'u', username: 'n', role: { id: 'r', name: 'R' } } },
    { auth: { sessionCookie: 'c' } },
    { auth: { sessionCookie: 'c' }, identity: { userId: 'u', username: 'n' } },
    { auth: { sessionCookie: 'c' }, identity: { userId: 1, username: 'n', role: { id: 'r', name: 'R' } } },
  ]) {
    const h = await startTestUsers({ testUsers: { login: async () => bad as never } });
    h.hub.tickets.set('t', { purpose: 'bind', userKey: 'alice' });
    const res = await post(h.url, '/test-bind', { ticket: 't', userKey: 'alice' });
    assert.equal(res.status, 502, JSON.stringify(bad));
    assert.equal(res.json.code, 'test_login_failed');
    assert.equal(h.store.puts.length, 0);
    await h.close();
  }
});

test('TU-BIND: only userId, username and role { id, name } of the identity reach the hub', async () => {
  const h = await startTestUsers({
    testUsers: {
      login: async () => ({
        auth: { sessionCookie: 'c' },
        identity: {
          userId: 'u',
          username: 'n',
          role: { id: 'r', name: 'R', secret: SENTINEL },
          token: SENTINEL,
        } as never,
      }),
    },
  });
  const { delivery } = await testSignIn(h, 'alice');
  assert.deepEqual(delivery.identity, { userId: 'u', username: 'n', role: { id: 'r', name: 'R' } });
  await h.close();
});

test('TU-BIND: a failed hub delivery is 502 hub_delivery_failed and the stored artifacts are dropped', async () => {
  const h = await startTestUsers();
  h.hub.failDelivery = true;
  h.hub.tickets.set('t-1', { purpose: 'bind', userKey: 'alice' });
  const res = await post(h.url, '/test-bind', { ticket: 't-1', userKey: 'alice' });
  assert.equal(res.status, 502);
  assert.deepEqual(res.json, { error: 'test_bind_failed', code: 'hub_delivery_failed' });

  const jti = h.store.puts[0]!.jti;
  assert.deepEqual(h.store.deletes, [jti]);
  assert.equal(await h.store.get(jti), null);
  // The handle that went out (and was refused) is dead on /mcp.
  const token = h.hub.deliveries[0]!.token;
  const call = await rpc(h.url, 'tools/call', { name: 'read', arguments: {} }, token);
  assert.equal(call.status, 401);
  assert.equal(call.body.code, 'unbound');
  assert.ok(!res.text.includes(token));
  assert.ok(!h.logger.text().includes(token));
  await h.close();
});

test('TU-BIND: a test route never mints a real handle and never touches a real session', async () => {
  const h = await startTestUsers();
  assert.equal((await bind(h.url, 'conn-real', { sessionCookie: 'real-cookie' })).status, 200);
  const realJti = decode(h.hub.lastBindToken()).jti as string;
  const { delivery } = await testSignIn(h, 'alice');
  assert.equal(decode(delivery.token).test, true);
  assert.notEqual(decode(delivery.token).jti, realJti);
  assert.deepEqual(await h.store.get(realJti), { connectionId: 'conn-real', artifacts: { sessionCookie: 'real-cookie' } });
  await h.close();
});

// ------------------------------------------------------------------ unbind

test('TU-UNBIND: a test handle is unbound with 204 and then fails on /mcp', async () => {
  const h = await startTestUsers();
  const { token } = await testSignIn(h, 'alice');
  assert.equal((await rpc(h.url, 'tools/call', { name: 'read', arguments: {} }, token)).status, 200);

  const res = await post(h.url, '/test-unbind', undefined, { authorization: `Bearer ${token}` });
  assert.equal(res.status, 204);
  assert.equal(res.text, '');

  const after = await rpc(h.url, 'tools/call', { name: 'read', arguments: {} }, token);
  assert.equal(after.status, 401);
  assert.equal(after.body.code, 'unbound');
  // Unbinding again is harmless.
  assert.equal((await post(h.url, '/test-unbind', undefined, { authorization: `Bearer ${token}` })).status, 204);
  await h.close();
});

test('TU-UNBIND: a real handle is refused with 403 not_a_test_handle and keeps working', async () => {
  const h = await startTestUsers();
  assert.equal((await bind(h.url, 'conn-real', { sessionCookie: 'real-cookie' })).status, 200);
  const real = h.hub.lastBindToken();
  const res = await post(h.url, '/test-unbind', undefined, { authorization: `Bearer ${real}` });
  assert.equal(res.status, 403);
  assert.deepEqual(res.json, { error: 'forbidden', code: 'not_a_test_handle' });
  assert.equal(h.store.deletes.length, 0, 'the real session was touched');
  const call = await rpc(h.url, 'tools/call', { name: 'write', arguments: {} }, real);
  assert.equal(call.status, 200);
  assert.deepEqual(call.body.result.structuredContent, { ran: 'write' });
  await h.close();
});

test('TU-UNBIND: no bearer or a bad bearer is 401', async () => {
  const h = await startTestUsers();
  assert.equal((await post(h.url, '/test-unbind')).json.code, 'missing_token');
  const bad = await post(h.url, '/test-unbind', undefined, { authorization: 'Bearer not.a.jwt' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, 'invalid_token');
  await h.close();
});

test('TU-UNBIND: with the list removed after a restart, an earlier test handle can still be unbound', async () => {
  const before = await startTestUsers();
  const { token } = await testSignIn(before, 'alice');
  // The "restarted" server: same store and secrets, no test users.
  const after = await startTestUsers({ testUsers: null, extra: { store: before.store } });
  const res = await post(after.url, '/test-unbind', undefined, { authorization: `Bearer ${token}` });
  assert.equal(res.status, 204);
  assert.ok(before.store.deletes.length > 0);
  await before.close();
  await after.close();
});

// ------------------------------------------------------------------ /mcp

test('TU-MCP: a test handle stops working once its user is off the list, though the store still has it', async () => {
  const before = await startTestUsers();
  for (const testUsers of [null, { users: JSON.stringify(USERS.filter((u) => u.key !== 'alice')) }]) {
    const { token } = await testSignIn(before, 'alice');
    const puts = before.store.puts.length;
    const deletes = before.store.deletes.length;
    assert.ok(puts > 0, 'the artifacts are in the shared store');
    // The "restarted" server: same store and secrets, the user (or the whole list) gone.
    const after = await startTestUsers({ testUsers, extra: { store: before.store } });
    const reply = await rpc(after.url, 'tools/call', { name: 'read', arguments: {} }, token);
    assert.equal(reply.status, 401);
    assert.equal(reply.body.code, 'unbound');
    assert.equal(after.seen.length, 0, 'the handler never runs');
    assert.equal(before.store.deletes.length, deletes + 1, 'the stored artifacts are dropped');
    await after.close();
  }
  await before.close();
});

test('TU-RO: a user marked read only after sign-in is read only at once', async () => {
  const before = await startTestUsers();
  const { token } = await testSignIn(before, 'alice');
  const users = USERS.map((u) => (u.key === 'alice' ? { ...u, readOnly: true } : u));
  const after = await startTestUsers({ testUsers: { users: JSON.stringify(users) }, extra: { store: before.store } });
  const refused = await rpc(after.url, 'tools/call', { name: 'write', arguments: {} }, token);
  assert.equal(after.seen.length, 0);
  assert.match(JSON.stringify(refused.body), /test_read_only/);
  assert.equal((await rpc(after.url, 'tools/call', { name: 'read', arguments: {} }, token)).status, 200);
  assert.deepEqual(after.seen[0]!.ctx.test, { userKey: 'alice', readOnly: true });
  await before.close();
  await after.close();
});

test('TU-MCP: a test handle sets ctx.test and replays the login artifacts; a real handle has no ctx.test', async () => {
  const h = await startTestUsers();
  const { token } = await testSignIn(h, 'alice');
  const reply = await rpc(h.url, 'tools/call', { name: 'write', arguments: {} }, token);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body.result.structuredContent, { ran: 'write' });
  const ctx = h.seen[0]!.ctx;
  assert.deepEqual(ctx.test, { userKey: 'alice', readOnly: false });
  assert.deepEqual(ctx.auth, { sessionCookie: 'session-for-alice' });

  assert.equal((await bind(h.url, 'conn-real', { sessionCookie: 'real' })).status, 200);
  await rpc(h.url, 'tools/call', { name: 'write', arguments: {} }, h.hub.lastBindToken());
  assert.equal(h.seen[1]!.ctx.test, undefined);
  assert.equal('test' in h.seen[1]!.ctx, false);
  await h.close();
});

test('TU-RO: a read-only handle runs only readOnlyHint: true tools; the others never reach the handler', async () => {
  const h = await startTestUsers();
  const { token } = await testSignIn(h, 'bob.ro');
  for (const tool of ['write', 'write_false']) {
    const reply = await rpc(h.url, 'tools/call', { name: tool, arguments: {} }, token);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.result.isError, true);
    assert.equal(reply.body.result.structuredContent.code, 'test_read_only');
    assert.equal(reply.body.result.structuredContent.success, false);
  }
  // Refused even with an idempotency key, and the refusal is not cached as the call's result.
  const keyed = await rpc(
    h.url,
    'tools/call',
    { name: 'write', arguments: {}, _meta: { 'dioschub/idempotencyKey': 'k-1' } },
    token,
  );
  assert.equal(keyed.body.result.structuredContent.code, 'test_read_only');
  assert.equal(h.seen.length, 0, 'a refused handler ran');

  const ok = await rpc(h.url, 'tools/call', { name: 'read', arguments: {} }, token);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.result.structuredContent, { ran: 'read' });
  assert.deepEqual(h.seen.map((s) => s.tool), ['read']);
  assert.deepEqual(h.seen[0]!.ctx.test, { userKey: 'bob.ro', readOnly: true });
  await h.close();
});

test('TU-RO: a read-write test user and a real handle are not held by the read-only guard', async () => {
  const h = await startTestUsers();
  const { token } = await testSignIn(h, 'alice');
  const reply = await rpc(h.url, 'tools/call', { name: 'write', arguments: {} }, token);
  assert.deepEqual(reply.body.result.structuredContent, { ran: 'write' });
  await h.close();
});

// ------------------------------------------------------------------ rate limit

test('TU-RATE: 30 attempts a minute in total on the two ticket routes, counted before the hub is asked', async () => {
  const h = await startTestUsers();
  for (let i = 0; i < 15; i++) {
    assert.equal((await post(h.url, '/test-users', { ticket: `x${i}` })).status, 401);
    assert.equal((await post(h.url, '/test-bind', { ticket: `y${i}`, userKey: 'alice' })).status, 401);
  }
  assert.equal(h.hub.verifies.length, 30);
  h.hub.tickets.set('good', { purpose: 'list' });
  const limited = await post(h.url, '/test-users', { ticket: 'good' });
  assert.equal(limited.status, 429);
  assert.deepEqual(limited.json, { error: 'too_many_requests', code: 'rate_limited' });
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await post(h.url, '/test-bind', { ticket: 'y', userKey: 'alice' })).status, 429);
  assert.equal((await post(h.url, '/test-bind', {})).status, 429, 'a malformed attempt still counts');
  assert.equal(h.hub.verifies.length, 30, 'the hub was asked past the limit');
  // Unbind is not a ticket route and is not limited.
  assert.equal((await post(h.url, '/test-unbind')).status, 401);
  await h.close();
});

test('TU-RATE: rateLimitPerMinute changes the limit', async () => {
  const h = await startTestUsers({ testUsers: { rateLimitPerMinute: 2 } });
  assert.equal((await post(h.url, '/test-users', { ticket: 'a' })).status, 401);
  assert.equal((await post(h.url, '/test-bind', { ticket: 'b', userKey: 'alice' })).status, 401);
  assert.equal((await post(h.url, '/test-users', { ticket: 'c' })).status, 429);
  await h.close();
});

// ------------------------------------------------------------------ events

test('TU-EVT: sign-in, calls, a refusal and sign-out each raise an event without credentials or handle', async () => {
  const h = await startTestUsers();
  const { token: rw } = await testSignIn(h, 'alice');
  const { token: ro } = await testSignIn(h, 'bob.ro');
  await rpc(h.url, 'tools/call', { name: 'write', arguments: {} }, rw);
  await rpc(h.url, 'tools/call', { name: 'write', arguments: {} }, ro);
  await post(h.url, '/test-unbind', undefined, { authorization: `Bearer ${rw}` });

  assert.deepEqual(
    h.events.map(({ at, ...rest }) => rest),
    [
      { type: 'test-login', userKey: 'alice' },
      { type: 'test-login', userKey: 'bob.ro' },
      { type: 'test-call', userKey: 'alice', tool: 'write' },
      { type: 'test-call-refused', userKey: 'bob.ro', tool: 'write', reason: 'read_only' },
      { type: 'test-unbind', userKey: 'alice' },
    ],
  );
  for (const e of h.events) {
    assert.ok(!Number.isNaN(Date.parse(e.at)) && e.at === new Date(e.at).toISOString(), 'at is ISO 8601');
  }
  const all = JSON.stringify(h.events);
  assert.ok(!all.includes(SENTINEL) && !all.includes(rw) && !all.includes(ro));
  await h.close();
});

test('TU-EVT: failed sign-ins raise test-login-failed with a fixed reason', async () => {
  const h = await startTestUsers({
    testUsers: {
      async login(_c, entry) {
        if (entry.key === 'alice') throw new Error(SENTINEL);
        return { auth: { sessionCookie: 'c' }, identity: { userId: 'u', username: 'n', role: { id: 'r', name: 'R' } } };
      },
    },
  });
  h.hub.tickets.set('t-a', { purpose: 'bind', userKey: 'alice' });
  h.hub.tickets.set('t-g', { purpose: 'bind', userKey: 'ghost' });
  h.hub.tickets.set('t-b', { purpose: 'bind', userKey: 'bob.ro' });
  await post(h.url, '/test-bind', { ticket: 't-a', userKey: 'alice' });
  await post(h.url, '/test-bind', { ticket: 't-g', userKey: 'ghost' });
  h.hub.failDelivery = true;
  await post(h.url, '/test-bind', { ticket: 't-b', userKey: 'bob.ro' });
  assert.deepEqual(
    h.events.map(({ at, ...rest }) => rest),
    [
      { type: 'test-login-failed', userKey: 'alice', reason: 'login_failed' },
      { type: 'test-login-failed', userKey: 'ghost', reason: 'unknown_test_user' },
      { type: 'test-login-failed', userKey: 'bob.ro', reason: 'hub_delivery_failed' },
    ],
  );
  assert.ok(!JSON.stringify(h.events).includes(SENTINEL));
  await h.close();
});

for (const [what, onEvent] of [
  ['throws', () => {
    throw new Error('audit sink down');
  }],
  ['rejects', async () => {
    throw new Error('audit sink down');
  }],
] as const) {
  test(`TU-EVT: a hook that ${what} is logged and ignored`, async () => {
    const h = await startTestUsers({ testUsers: { onEvent } });
    const { res, token } = await testSignIn(h, 'alice');
    assert.equal(res.status, 200);
    const call = await rpc(h.url, 'tools/call', { name: 'write', arguments: {} }, token);
    assert.deepEqual(call.body.result.structuredContent, { ran: 'write' });
    await new Promise((r) => setImmediate(r));
    assert.match(h.logger.text(), /testUsers\.onEvent failed; ignored/);
    await h.close();
  });
}

// ------------------------------------------------------------------ real path unchanged

test('TU-REAL: with test users on, a real bind mints the same four-claim handle as before', async () => {
  const h = await startTestUsers();
  assert.equal((await bind(h.url, 'conn-1', { sessionCookie: 'c' })).status, 200);
  const claims = decode(h.hub.lastBindToken());
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'jti']);
  assert.equal((claims.exp as number) - (claims.iat as number), 8 * 60 * 60);
  assert.equal(h.store.puts[0]!.ttl, 8 * 60 * 60);
  assert.equal(h.events.length, 0, 'a real bind raised a test event');
  assert.ok(USERS.length > 0);
  await h.close();
});
