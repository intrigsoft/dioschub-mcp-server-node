import { after } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMcpServer, type DioscMcpServer } from '../src/index.js';
import type { HubBinder } from '../src/hub-client.js';

export const ADMIN_KEY = 'admin-secret';
export const JWT_SECRET = 'jwt-secret';

export interface CapturingHub extends HubBinder {
  readonly calls: Array<{ connectionId: string; token: string; identity: unknown }>;
  lastToken(): string;
}

export function capturingHub(behavior?: () => void): CapturingHub {
  const calls: Array<{ connectionId: string; token: string; identity: unknown }> = [];
  return {
    calls,
    async bind(connectionId, token, identity) {
      behavior?.(); // let a test force a failure
      calls.push({ connectionId, token, identity: identity ?? null });
    },
    lastToken() {
      const last = calls.at(-1);
      if (!last) throw new Error('hub.bind was never called');
      return last.token;
    },
  };
}

export interface Harness {
  url: string;
  server: DioscMcpServer<{ sessionCookie: string }>;
  hub: CapturingHub;
  close(): Promise<void>;
}

/** Boot a server on an ephemeral port with a capturing Hub. */
export async function startHarness(
  configure: (server: DioscMcpServer<{ sessionCookie: string }>) => void,
  hub: CapturingHub = capturingHub(),
): Promise<Harness> {
  const server = createMcpServer<{ sessionCookie: string }>({
    name: 'test-mcp',
    adminKey: ADMIN_KEY,
    jwtSecrets: JWT_SECRET,
    hubClient: hub,
  });
  configure(server);

  const httpServer: Server = await new Promise((resolve) => {
    const s = server.listen(0, () => resolve(s));
  });
  const { port } = httpServer.address() as AddressInfo;
  openServers.add(httpServer);

  return {
    url: `http://localhost:${port}`,
    server,
    hub,
    close: () =>
      new Promise((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

export function bind(url: string, connectionId: string, artifacts: unknown, adminKey = ADMIN_KEY) {
  return fetch(`${url}/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
    body: JSON.stringify({ connectionId, artifacts }),
  });
}

export function toolCall(url: string, name: string, args: unknown, token?: string) {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
}

// ---- helpers for annotations / idempotency specs (P7, #717) ----

export const IDEM_META_KEY = 'dioschub/idempotencyKey';

/** Like startHarness, but lets a test pass extra server config (e.g. `idempotency`). */
export async function startHarnessWith(
  extra: Record<string, unknown>,
  configure: (server: DioscMcpServer<{ sessionCookie: string }>) => void,
  hub: CapturingHub = capturingHub(),
): Promise<Harness> {
  const server = createMcpServer<{ sessionCookie: string }>({
    name: 'test-mcp',
    adminKey: ADMIN_KEY,
    jwtSecrets: JWT_SECRET,
    hubClient: hub,
    ...extra,
  } as never);
  configure(server);
  const httpServer: Server = await new Promise((resolve) => {
    const s = server.listen(0, () => resolve(s));
  });
  const { port } = httpServer.address() as AddressInfo;
  openServers.add(httpServer);
  return {
    url: `http://localhost:${port}`,
    server,
    hub,
    close: () =>
      new Promise((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

// A failing assertion skips the test's own close(); sweep leftovers so a red run exits instead of hanging.
const openServers = new Set<Server>();
after(() => {
  for (const s of openServers) {
    s.closeAllConnections();
    s.close();
  }
});

export interface RpcReply {
  status: number;
  /** Parsed JSON-RPC envelope (works for plain JSON and SSE replies). */
  body: any;
}

/** POST one JSON-RPC request to /mcp; parse a JSON or SSE reply. */
export async function rpc(url: string, method: string, params: unknown, token?: string, id = 1): Promise<RpcReply> {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  let body: any = null;
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  try {
    body = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

export function initialize(url: string) {
  return rpc(url, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe', version: '0.0.0' },
  });
}

export function listTools(url: string, token?: string) {
  return rpc(url, 'tools/list', {}, token);
}

/** tools/call with an optional idempotency key in params._meta. `key` is sent verbatim (may be malformed). */
export function callWithKey(url: string, token: string | undefined, name: string, args: unknown, key?: unknown) {
  const params: Record<string, unknown> = { name, arguments: args };
  if (key !== undefined) params._meta = { [IDEM_META_KEY]: key };
  return rpc(url, 'tools/call', params, token);
}

/** Bind a connection and return the handle token the Hub would hold. */
export async function bindAndToken(h: Harness, connectionId: string): Promise<string> {
  const res = await bind(h.url, connectionId, { sessionCookie: `cookie-${connectionId}` });
  if (res.status !== 200) throw new Error(`bind failed: ${res.status}`);
  return h.hub.lastToken();
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
