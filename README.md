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

## Configuration

| Field         | Required | Notes                                                                 |
| ------------- | -------- | --------------------------------------------------------------------- |
| `name`        | yes      | Server name; also the JWT audience.                                   |
| `adminKey`    | yes      | Authenticates the app's `/bind` call. Must be an **admin** key.       |
| `jwtSecrets`  | yes      | HS256 secret, or an array (first signs, all verify → zero-downtime rotation). |
| `hub`         | yes*     | `{ url, apiKey, bindPath?, apiKeyHeader?, instanceName? }`. `apiKey` = a `diosc_ak_…` admin key scoped `auth:bind`. Default path `/api/auth/bind`, header `x-api-key`. `instanceName` = this server's **Hub instance name**, used to scope the handle to us; defaults to `name`, must match the Hub exactly. |
| `hubClient`   | yes*     | \*Provide `hub` **or** `hubClient` (a custom `HubBinder`).            |
| `store`       | no       | `MemoryArtifactStore` (default) or `RedisArtifactStore`.              |
| `ttlSeconds`  | no       | Session + JWT lifetime. Default `28800` (8h).                         |
| `basePath`    | no       | Mount prefix for `/bind` and `/mcp`.                                  |
| `devGuard`    | no       | Scan tool results for leaked artifacts. Default on outside production.|

## Routes the framework owns

- `POST {basePath}/bind` — app → MCP, admin-key authenticated. Body:
  `{ connectionId, artifacts, identity? }`. `connectionId` is the Hub `wsId`
  (surfaced by the kit on `bind:ready`); `identity` is optional non-credential
  metadata forwarded to the Hub (`{ userId, username, role:{id,name} }`).
- `POST {basePath}/mcp` — the MCP endpoint (streamable HTTP, stateless / connect-per-call).

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
