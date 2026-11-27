# @dioschub/mcp-server

A TypeScript framework for building **DioscHub-compatible MCP servers** with
**Bring-Your-Own-Auth (BYOA)** credential-blind pass-through.

You write tools. The framework owns the auth plumbing: it accepts your app's
native auth artifacts once, mints an opaque handle, keeps the credentials
server-side, and replays them into every tool call — so the LLM (and the Hub)
never see a credential.

## The model

```
BIND  (once, server-to-server)
  App backend ──{ connectionId, nativeArtifacts }──▶  MCP /bind   (auth: admin key)
                                                         │  mint jti + handle-JWT
                                                         │  store: jti → { connectionId, artifacts }
                                                         ▼
   MCP ──POST /api/auth/bind { wsId, identity?, authArtifacts:{headers:{Authorization:Bearer <handle>}} }──▶ Hub
                                                         │        (auth: x-api-key: diosc_ak_…)
                                          Hub stores + replays those headers verbatim on every tool call

TOOL CALL  (every call)
  Hub ──Authorization: Bearer <token>──▶  MCP /mcp
                                             │  verify token → jti → store.get(jti)
                                             │     miss → 401  (Hub re-auths, kit re-binds)
                                             ▼
                                   tool(args, ctx)   ctx.auth = native artifacts (verbatim)
                                             │
                                   your handler ──native artifacts──▶ real backend
```

Two properties are non-negotiable and enforced by construction:

- **Credential-blind.** We hand the Hub only the handle-JWT. It carries a random
  `jti`, an audience, and an expiry — never the credentials. The Hub replays that
  handle back to us on each tool call; native artifacts live only on the MCP
  server, keyed by `jti`.
- **Audience-bound, and scoped to us on the wire.** The handle's `aud` means no
  other server can *use* it. Whether another server ever *sees* it is the Hub's
  forwarding decision: bound session-wide, the Hub replays it to every conduit
  instance on the assistant, so an unrelated MCP server receives a live
  credential for this one. So the bind names its target — the handle goes into
  `authArtifacts.perServer[instanceName]`, and the Hub gives unnamed instances
  no credentials at all. Set `hub.instanceName` if your Hub instance name
  differs from `name`.
- **Conduit instance required.** The Hub forwards per-user BYOA headers ONLY to
  MCP instances configured *without* static server auth. Attach this server as a
  credential-less ("conduit") instance, or the handle is dropped and tool calls
  arrive unauthenticated.
- **Store miss → 401, never 500.** A missing/expired/evicted session returns a
  clean `401`, which is exactly what trips the Hub's mid-turn re-auth so the kit
  re-binds. This is automatic.
- **Upstream refusal → 401 too, if you say so.** When your app rejects the bound
  credential before its natural expiry (logout, revocation), throw
  `ReauthRequired` from the handler and the call ends the same way. See
  *Credential rejected mid-session*.

## Install

```bash
npm install @dioschub/mcp-server
```

## Quickstart

```ts
import { createMcpServer, RedisArtifactStore } from '@dioschub/mcp-server';
import { z } from 'zod';

// Your app's artifact shape. The framework is blind to it; you own it.
interface NorthwindAuth {
  sessionCookie: string;
}

const server = createMcpServer<NorthwindAuth>({
  name: 'northwind-mcp',
  adminKey: process.env.ADMIN_BIND_KEY!,   // authenticates the app's /bind call
  jwtSecrets: process.env.MCP_JWT_SECRET!, // signs the opaque handle (rotate: pass an array)
  hub: {
    url: process.env.HUB_URL!,
    apiKey: process.env.HUB_API_KEY!,       // reuses the file-ops S2S channel
  },
  store: new RedisArtifactStore({ url: process.env.REDIS_URL }), // omit → in-memory
  ttlSeconds: 8 * 60 * 60,
});

server.tool({
  name: 'get_orders',
  description: 'List orders for a customer',
  input: z.object({ customerId: z.string() }),
  handler: async ({ customerId }, ctx) => {
    // ctx.auth is exactly what the app sent at /bind — you know its shape.
    const res = await fetch(`${process.env.API}/customers/${customerId}/orders`, {
      headers: { cookie: ctx.auth.sessionCookie },
    });
    return res.json(); // plain data → wrapped into an MCP result for you
  },
});

server.listen(8080, () => process.stderr.write('northwind-mcp on :8080\n'));
```

## The tool context

A handler's second argument:

| Field          | What it is |
| -------------- | ---------- |
| `auth`         | The artifacts the app sent at `/bind`, verbatim. |
| `connectionId` | The Hub connection the call is bound to. |
| `call`         | The Hub's call context from `_meta`: `currentPath` (the page the user was on when the turn started), `userId`, `tenantId`, `sessionId`, `threadId`. Each is optional. |
| `meta`         | The call's raw `_meta`, read-only, for keys `call` does not model. |
| `logger`       | Scoped to this tool and connection; never logs `auth`. |
| `signal`       | Aborts when the caller disconnects. |
| `test`         | Only on a call made as a test user: `{ userKey, readOnly }`. See *Test users*. |

`ctx.call` lets a tool resolve "the patient on screen" without the model having
to repeat an id:

```ts
handler: async (_args, ctx) => {
  const id = ctx.call.currentPath?.match(/^\/patients\/([^/?#]+)/)?.[1];
  if (!id) return { error: 'Open a patient first.' };
  // Still an upstream call with the user's own credential: the app decides access.
  const res = await fetch(`${API}/patients/${id}`, { headers: { cookie: ctx.auth.sessionCookie } });
  return res.json();
},
```

`call` and `meta` arrive in the request body. They are hints for what the user
means, **never authorization**: always fetch with `ctx.auth`, so the upstream
app checks access. `currentPath` is the page when the turn started; it is not
updated if the user navigates while the turn runs.

## Credential rejected mid-session

The session in the store normally lasts `ttlSeconds`. If your app rejects the
credential earlier (the user logged out and back in, a token was revoked), throw
`ReauthRequired` from the handler:

```ts
import { ReauthRequired } from '@dioschub/mcp-server';

handler: async (args, ctx) => {
  const res = await fetch(url, { headers: { authorization: `Bearer ${ctx.auth.token}` } });
  if (res.status === 401) throw new ReauthRequired('upstream returned 401');
  return res.json();
},
```

The framework then:

1. drops the bound session, so the stale credential is never used again;
2. answers the call with HTTP `401` (`code: "reauth_required"`) instead of a tool
   result. The Hub treats a 401 as *not sent*: it asks the host app to re-bind
   and sends the same call again with the fresh credential;
3. releases the call's idempotency entry, so that retry (same key) runs instead
   of replaying the refusal.

Because the Hub runs the call again, throw `ReauthRequired` only when the
upstream refused the request **before anything changed**. If a multi-step
handler already wrote something, return an ordinary error. Any other thrown
error stays a normal tool error and leaves the session bound. The error message
is logged on this server only.

With this, you no longer need to match `ttlSeconds` to your credential's
lifetime to get a clean re-bind: expiry and early rejection both end in one.

## Configuration

| Field         | Required | Notes                                                                 |
| ------------- | -------- | --------------------------------------------------------------------- |
| `name`        | yes      | Server name; also the JWT audience.                                   |
| `adminKey`    | yes      | Authenticates the app's `/bind` call. Must be an **admin** key.       |
| `jwtSecrets`  | yes      | HS256 secret, or an array (first signs, all verify → zero-downtime rotation). |
| `hub`         | yes*     | `{ url, apiKey, bindPath?, apiKeyHeader?, instanceName?, testTicketVerifyPath?, testBindPath? }`. `apiKey` = a `diosc_ak_…` admin key scoped `auth:bind`. Default path `/api/auth/bind`, header `x-api-key`. `instanceName` = this server's **Hub instance name**, used to scope the handle to us; defaults to `name`, must match the Hub exactly. The two test paths default to `/api/auth/test-tickets/verify` and `/api/auth/test-bind`. |
| `hubClient`   | yes*     | \*Provide `hub` **or** `hubClient` (a custom `HubBinder`).            |
| `store`       | no       | `MemoryArtifactStore` (default) or `RedisArtifactStore`.              |
| `ttlSeconds`  | no       | Session + JWT lifetime. Default `28800` (8h).                         |
| `basePath`    | no       | Mount prefix for `/bind` and `/mcp`.                                  |
| `devGuard`    | no       | Scan tool results for leaked artifacts. Default on outside production.|
| `idempotency` | no       | `false` to disable, or `{ store?, ttlSeconds?, waitMs? }`. On by default (see *Idempotency*). |
| `testUsers`   | no       | `{ login, users?, env?, onEvent?, rateLimitPerMinute? }`. Off by default (see *Test users*). |

## Tool annotations

A tool may carry MCP `annotations` (`title`, `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`). They appear unchanged on that tool in
`tools/list`; a tool without them lists none (no defaults are invented). (ANN-001)

```ts
server.tool({
  name: 'delete_order',
  annotations: { destructiveHint: true, idempotentHint: false },
  input: z.object({ id: z.string() }),
  handler: async ({ id }, ctx) => { /* … */ },
});
```

## Idempotency

A client (the Hub) can mark a `tools/call` with a key so a retry never runs a
side effect twice.

- **Capability (IDEM-001).** `initialize` returns
  `capabilities.experimental["dioschub/idempotency"] = { version: 1 }`. With
  `idempotency: false` it is absent and no dedup runs.
- **Key (IDEM-002).** `params._meta["dioschub/idempotencyKey"]` of `tools/call`.
  No key: the handler runs every time. A key that is not a non-empty string of
  at most 256 characters gets `INVALID_IDEMPOTENCY_KEY` and the handler does not run.
- **Seen and finished (IDEM-003).** A later call with the same key returns the
  first call's result unchanged (`content`, `structuredContent`, `isError`) and
  the handler does not run. Arguments are not compared: the key identifies the call.
  A handler that throws or returns `isError: true` is finished too; its error is
  cached and replayed, never re-run.
- **Seen and still running (IDEM-004).** A duplicate waits up to `waitMs`
  (default 30000). If the first call finishes in time it gets that result;
  otherwise it gets, and the handler is not run:
  ```json
  { "isError": true,
    "content": [{ "type": "text", "text": "<the JSON below>" }],
    "structuredContent": { "success": false, "code": "IN_PROGRESS",
      "message": "the call with this idempotency key is still running; its outcome is not known yet" } }
  ```
  `INVALID_IDEMPOTENCY_KEY` has the same shape. A late completion still lands in
  the entry, so the next duplicate gets the real result.
- **Scope (IDEM-005).** An entry is keyed by the verified session's
  `connectionId` + tool name + key. The connection comes from the verified handle,
  never from the request body. Another connection or another tool never sees it.
  Auth runs first: an unauthenticated call gets 401 and creates no entry.
- **Atomic claim (IDEM-006).** Of N concurrent calls with one scope and key,
  exactly one runs the handler.
- **Stores (IDEM-007).** `MemoryIdempotencyStore` (default, one process) or
  `RedisIdempotencyStore({ url | client, keyPrefix? })` (claim is `SET … NX EX`;
  default prefix `diosc:mcp:idem:`). Entries, running and done, expire after
  `ttlSeconds` (default 3600). A custom store should implement `release(scope)`
  (delete the entry); without it, the retry after a `ReauthRequired` gets
  `IN_PROGRESS` until the entry expires.
- **Credential blind (IDEM-008).** Entry keys are a hash of the scope, and
  entries hold no bearer token and no auth artifacts of their own: only the
  handler's result (or a thrown handler's error message) is stored. The dev
  guard logs a result that echoes the artifacts but does not redact it, so a
  handler that leaks a credential into its result leaks it into the store too.

```ts
createMcpServer({
  /* … */
  idempotency: { store: new RedisIdempotencyStore({ url: process.env.REDIS_URL }), waitMs: 30_000 },
});
```

Limits: if a process dies mid-call, its key keeps answering `IN_PROGRESS` until
the TTL expires (the call may have run, so it is never re-run). Results are
stored as JSON, so a result must be JSON-serializable. A handler's own side
effects are not rolled back; this only prevents a second run. A handler that
runs longer than `ttlSeconds` outlives its entry: a duplicate after the expiry
runs it again, and whichever run finishes last writes the entry. Set
`ttlSeconds` well above your longest handler run and above `waitMs`.

## File access

On every tool call that has a chat session, the Hub puts an opaque, short-lived
token (15 minutes, bound to the session, this server and this call) in
`_meta["dioschub/fileAccess"]`. `createFileClient` reads it from `ctx` and calls
the Hub's `get_file` / `put_file` endpoints with your `mcp-files:*` API key plus
`X-File-Access-Token`:

```ts
import { createFileClient } from '@dioschub/mcp-server';

const files = createFileClient({ url: process.env.HUB_URL!, apiKey: process.env.DIOSC_MCP_FILES_KEY! });

handler: async ({ name }, ctx) => {
  const res = await files.fetchFile(ctx, name);          // Response; stream res.body
  const { filename } = await files.uploadFile(ctx, { filename: 'report.pdf', content: bytes, mimeType: 'application/pdf' });
  return { stored: filename };
},
```

- A call without a token throws `FileAccessTokenMissing`; there is no fallback to
  sending only a session id (that path is deprecated on the Hub and removed in
  the next release).
- The Hub answers 403 for an invalid or expired token, a session that is no
  longer live, or a server no longer attached; it surfaces as `FileAccessError`
  with `status` and `code`.
- The token is a credential: never log it and never return it in a tool result.
  The helper does not log it and its errors do not carry it.

## Test users

Let the Hub's admin try your tools **as a real user** without anyone typing a
password into the Hub. You list a few test accounts in a secret environment
variable; the admin picks one in the Hub; the framework signs that account in
with your own script and binds it exactly as a real user would be bound. The
account's credentials never leave this server.

### The list: `DIOSC_TEST_USERS`

A JSON list. Each entry has a public part, shown to the admin, and a private
part, `credentials`, which only your `login` script ever sees:

```json
[
  {
    "key": "maria.test",
    "name": "Maria Example (test)",
    "note": "Customer with two open orders",
    "credentials": { "username": "maria.test@example.invalid", "password": "fake-password-1" }
  },
  {
    "key": "auditor.test",
    "name": "Read-only auditor (test)",
    "readOnly": true,
    "credentials": { "username": "auditor.test@example.invalid", "password": "fake-password-2" }
  }
]
```

| Field         | Rule |
| ------------- | ---- |
| `key`         | `^[a-z0-9][a-z0-9._-]{0,63}$`, unique in the list. The Hub matches a test user across servers by this key. |
| `name`        | 1 to 100 characters. |
| `note`        | Optional, up to 200 characters. |
| `readOnly`    | Optional `true`: only read-only tools run for this user (below). |
| `credentials` | Required. Any shape your script needs: a username and password, an API token, a client id and secret. |

At most 50 entries. The list is checked when the server starts: a list that
is not valid JSON, or breaks a rule, stops the server with a
`TestUsersConfigError` naming the entry's position (never its values). Unset,
empty or `[]`: the feature is off.

Pass `testUsers.env` to read another variable, or `testUsers.users` to pass
the JSON text (or a parsed list) yourself.

### The `login` script

```ts
const server = createMcpServer<NorthwindAuth>({
  /* … */
  testUsers: {
    async login(credentials, entry, ctx) {
      const { username, password } = credentials as { username: string; password: string };
      // Sign in to the real auth service, exactly as your app's login page does.
      const res = await fetch(`${API}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: ctx.signal,
      });
      if (!res.ok) throw new Error(`login refused with ${res.status}`);
      const { cookie } = await res.json();
      return {
        auth: { sessionCookie: cookie },               // what a real /bind would have carried
        identity: { userId: username, username, role: { id: 'customer', name: 'Customer' } },
      };
    },
    onEvent: (event) => audit.write(event),           // optional
  },
});
```

`login` gets the entry's `credentials`, its public part, and `{ logger, signal }`.
It returns the artifacts your tools read from `ctx.auth`, plus the identity your
app would assert at bind (the Hub matches the role by name, as for a real user).
Throw when the sign-in fails. The framework does not log or forward your
error (it may quote what it was given); the Hub gets `test_login_failed`. Log
what you need with `ctx.logger`, never the credentials.

### What happens

1. The admin opens a tool test or a test conversation in the Hub. The Hub
   posts a one-time ticket to `POST {basePath}/test-users`; the framework asks
   the Hub whether the ticket is real (`POST /api/auth/test-tickets/verify`)
   and answers with the public parts of the list.
2. The admin picks a user. The Hub posts `{ ticket, userKey }` to
   `POST {basePath}/test-bind`. The framework checks the ticket with the Hub
   first, then runs your `login`, stores the artifacts, mints a **test handle**,
   and hands it to the Hub with `POST /api/auth/test-bind` and your
   `hub.apiKey`. The route's own answer is only `{ ok: true, expiresAt }`: the
   handle goes to the configured Hub URL and nowhere else. If the Hub does not
   take it, the stored artifacts are dropped.
3. Tool calls with that handle run like any other, with `ctx.test` set.
4. The Hub ends the sign-in with `POST {basePath}/test-unbind` (the handle as
   the bearer), or it expires.

The routes carry no credential header: the Hub's ticket is the authority, and
a caller without a ticket the Hub issued gets nothing. On initialize the
server declares `capabilities.experimental["dioschub/testUsers"] = { version: 1 }`,
only when the feature is on, so the Hub knows to offer the list.

What the admin sees: each test user's `name`, `note` and whether it is read
only, for this server. After signing in, the tools run as that user, with the
role your identity names.

### In a tool

```ts
handler: async (args, ctx) => {
  if (ctx.test) ctx.logger.info('test call', { testUser: ctx.test.userKey });
  /* … */
},
```

`ctx.test` is `{ userKey, readOnly }` on a test call and absent on a real one.

### Read-only test users

For an entry with `readOnly: true`, a tool runs only when its annotations say
`readOnlyHint: true`. Any other tool is refused before its handler runs, with
a tool error:

```json
{ "isError": true,
  "structuredContent": { "success": false, "code": "test_read_only",
    "message": "this test user is read only, and this tool is not marked read only" } }
```

Mark your read tools `annotations: { readOnlyHint: true }`. A tool without the
annotation counts as one that changes things.

### Events

`onEvent` receives `{ type, userKey, at, tool?, reason? }`, where `type` is
`test-login`, `test-login-failed`, `test-call`, `test-call-refused` or
`test-unbind`, and `at` is an ISO 8601 time. `reason` is a fixed code
(`unknown_test_user`, `login_failed`, `invalid_login_result`, `store_failed`,
`hub_delivery_failed`, `read_only`). Events never carry credentials or the
handle. A hook that throws or rejects is logged and ignored; it is not awaited.

### Security notes

- **Use accounts you accept being used this way.** Anyone the Hub lets test
  as a user acts as that account in your app. Prefer dedicated test accounts
  with test data, and `readOnly` where a test needs no writes.
- **The variable is a secret.** Set it as a secret in your platform, never in
  source control or an image. The credentials stay on this server: they are
  never in a route's answer, a log line, an event or an error.
- **Restart to change the list.** It is read once at start-up. Removal takes
  effect at once: a test handle whose user is no longer in the list (or whose
  list is gone) is refused with `401 unbound` and its stored artifacts are
  dropped, even with a shared store. A user you mark `readOnly` is read only
  from the restart on, for handles minted before it too. `test-unbind` keeps
  answering when test users are off, so an earlier handle can still be revoked.
- **60 minutes, fixed.** A test handle and its stored artifacts last 60
  minutes, with no refresh, whatever `ttlSeconds` says. The Hub signs in again
  after that.
- **Rate limit, per process.** `test-users` and `test-bind` together accept
  30 attempts a minute (`testUsers.rateLimitPerMinute`), counted before the Hub
  is asked; past that they answer `429` with `Retry-After`. The count is kept
  in memory, so each replica counts on its own.
- The handle is delivered only to `hub.url`. A test route never mints a real
  handle and never touches a real user's stored session; `test-unbind` refuses
  a real handle with `403 not_a_test_handle`.

### Answers

| Route | Status | `code` |
| ----- | ------ | ------ |
| any test route, feature off | 404 | `test_users_disabled` |
| `test-users`, `test-bind` | 400 | `missing_fields` |
| `test-users`, `test-bind` | 401 | `invalid_ticket` |
| `test-users`, `test-bind` | 429 | `rate_limited` |
| `test-users`, `test-bind` | 502 | `hub_unreachable` (the ticket could not be checked) |
| `test-bind` | 404 | `unknown_test_user` |
| `test-bind` | 502 | `test_login_failed`, `hub_delivery_failed` |
| `test-bind`, `test-unbind` | 500 | `store_failed` |
| `test-unbind` | 401 | `missing_token`, `invalid_token` |
| `test-unbind` | 403 | `not_a_test_handle` |

## Routes the framework owns

- `POST {basePath}/bind` — app → MCP, admin-key authenticated. Body:
  `{ connectionId, artifacts, identity? }`. `connectionId` is the Hub `wsId`
  (surfaced by the kit on `bind:ready`); `identity` is optional non-credential
  metadata forwarded to the Hub (`{ userId, username, role:{id,name} }`).
- `POST {basePath}/mcp` — the MCP endpoint (streamable HTTP, stateless / connect-per-call,
  JSON responses: the reply is written once the handler finishes, so a handler can
  still turn it into a 401).
- `POST {basePath}/test-users`, `POST {basePath}/test-bind`,
  `POST {basePath}/test-unbind` — Hub → MCP, for test users (see *Test users*).
  They answer `404 test_users_disabled` while the feature is off.

Mount your own routes (health, readiness) on `server.app`.

## Attaching to a Hub

To make this server's tools reachable by an assistant's LLM:

1. **Register a conduit instance** pointing at your MCP URL, with *no* static
   auth (`authConfig: {}`):
   ```
   POST /api/admin/mcp-instances
   { "name": "my-server", "serverUrl": "http://host:8080/mcp",
     "transportType": "http", "authConfig": {}, "isActive": true }
   ```
   The instance `name` here is what scopes your handle. It must equal the
   framework's `name` — or `hub.instanceName`, if you set it. A mismatch means
   the Hub forwards no credentials to you and every tool call arrives
   unauthenticated (the Hub logs `BYOA: forwarding no user credentials to MCP
   instance "…"` naming the instance it expected).
2. **Attach it to an assistant**: `PUT /api/admin/assistants/:id` with
   `attachedMcpServers: ["my-server", …]` (replaces the whole set).
3. **Restart the Hub.** The Hub scans MCP providers into its tool graph **at boot
   only** — attaching + refreshing an instance is *not* enough; until a restart
   the LLM won't see the tools (check the `GraphFactory … discoverable=` log for
   your tool names). This is a Hub behavior, but it's the #1 "it doesn't work"
   trap when wiring a new server.

`/bind` needs an admin credential with the `auth:bind` scope: a `diosc_ak_…` key
(via `hub.apiKey`), or for local dev the `x-admin-token` bypass — pass it with
`hub.apiKeyHeader: 'x-admin-token'`.

## Scaling

Use `RedisArtifactStore` for more than one replica: a JWT minted on replica A
must resolve on replica B. `MemoryArtifactStore` is single-instance only — after
a restart, every user re-binds (correctly, via the 401 path, but visibly).

Idempotency needs the same: with more than one replica pass
`idempotency: { store: new RedisIdempotencyStore(...) }`, or a duplicate that
lands on another replica runs the handler again.

## Status

Working and verified. `npm run build` + `npm test` (23 tests: JWT, stores, bind
route, tool-call auth gate, the real `/api/auth/bind` wire contract, and a
Northwind end-to-end through the real MCP client).

Verified live end-to-end against a running DioscHub: the `examples/northwind`
server, registered as a conduit instance and attached to an assistant, served a
real chat-widget request — the LLM called its tool, the Hub forwarded only the
opaque handle, the server resolved it to the bound user's credential, and
returned that user's data with no credential ever reaching the Hub or the model.

Run `npm install`, then `npm run build` / `npm test`. See `examples/northwind/`
(`run-live.ts` binds against a real Hub; `run.ts` is a self-contained demo).
