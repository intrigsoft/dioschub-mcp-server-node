import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after } from 'node:test';
import { z } from 'zod';
import {
  MemoryArtifactStore,
  createMcpServer,
  type BoundSession,
  type DioscMcpServer,
  type Logger,
  type TestBindDelivery,
  type TestTicketCheck,
  type TestUserEvent,
  type TestUsersConfig,
  type ToolContext,
} from '../src/index.js';
import type { HubBinder } from '../src/hub-client.js';
import { ADMIN_KEY, JWT_SECRET } from './support.js';

/** Placed in every entry's credentials; must never surface anywhere. */
export const SENTINEL = 'SENTINEL-pw-7f3a9c';

export type Auth = { sessionCookie: string };

export const USERS = [
  { key: 'alice', name: 'Alice (test)', credentials: { username: 'alice', password: SENTINEL } },
  {
    key: 'bob.ro',
    name: 'Bob, read only',
    note: 'Sees everything, changes nothing',
    readOnly: true,
    credentials: { username: 'bob', password: SENTINEL },
  },
];

/** A Hub that knows which tickets it issued, and records what it was asked. */
export interface FakeHub extends HubBinder {
  /** ticket → what it was issued for. */
  tickets: Map<string, { purpose: 'list' | 'bind'; userKey?: string }>;
  verifies: TestTicketCheck[];
  deliveries: TestBindDelivery[];
  binds: Array<{ connectionId: string; token: string }>;
  order: string[];
  failDelivery: boolean;
  failVerify: boolean;
  lastBindToken(): string;
}

export function fakeHub(order: string[] = []): FakeHub {
  const hub: FakeHub = {
    tickets: new Map(),
    verifies: [],
    deliveries: [],
    binds: [],
    order,
    failDelivery: false,
    failVerify: false,
    async bind(connectionId, token) {
      hub.binds.push({ connectionId, token });
    },
    async verifyTestTicket(check) {
      hub.order.push(`verify:${check.purpose}`);
      hub.verifies.push(check);
      if (hub.failVerify) throw new Error('hub down');
      const t = hub.tickets.get(check.ticket);
      if (!t || t.purpose !== check.purpose) return false;
      if (check.purpose === 'list') {
        hub.tickets.delete(check.ticket); // a list ticket is consumed by the check
        return true;
      }
      return t.userKey === check.userKey;
    },
    async testBind(delivery) {
      hub.order.push('testBind');
      hub.deliveries.push(delivery);
      if (hub.failDelivery) throw new Error('hub said 409');
    },
    lastBindToken() {
      const last = hub.binds.at(-1);
      if (!last) throw new Error('hub.bind was never called');
      return last.token;
    },
  };
  return hub;
}

/** A logger that keeps every record, children included, as JSON text. */
export function capturingLogger(): Logger & { records: string[]; text(): string } {
  const records: string[] = [];
  const make = (bindings: Record<string, unknown>): Logger => {
    const write = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
      records.push(JSON.stringify({ level, msg, ...bindings, ...fields }));
    };
    return {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (b) => make({ ...bindings, ...b }),
    };
  };
  return Object.assign(make({}), { records, text: () => records.join('\n') });
}

/** A memory store that records puts and deletes. */
export function recordingStore() {
  const store = new MemoryArtifactStore<Auth>();
  const puts: Array<{ jti: string; session: BoundSession<Auth>; ttl: number }> = [];
  const deletes: string[] = [];
  const put = store.put.bind(store);
  const del = store.delete.bind(store);
  store.put = async (jti, session, ttl) => {
    puts.push({ jti, session, ttl });
    return put(jti, session, ttl);
  };
  store.delete = async (jti) => {
    deletes.push(jti);
    return del(jti);
  };
  return Object.assign(store, { puts, deletes });
}

export interface TestHarness {
  url: string;
  hub: FakeHub;
  logger: ReturnType<typeof capturingLogger>;
  store: ReturnType<typeof recordingStore>;
  events: TestUserEvent[];
  logins: Array<{ credentials: unknown; entry: unknown }>;
  seen: Array<{ tool: string; ctx: ToolContext<Auth> }>;
  order: string[];
  server: DioscMcpServer<Auth>;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Replace or drop (null) the testUsers config. Default: USERS with the recording login. */
  testUsers?: Partial<TestUsersConfig<Auth>> | null;
  hub?: HubBinder;
  extra?: Record<string, unknown>;
}

/** Boot a server with test users, a fake Hub and three tools: read, write, write_false. */
export async function startTestUsers(opts: StartOptions = {}): Promise<TestHarness> {
  const order: string[] = [];
  const hub = fakeHub(order);
  const logger = capturingLogger();
  const store = recordingStore();
  const events: TestUserEvent[] = [];
  const logins: Array<{ credentials: unknown; entry: unknown }> = [];
  const seen: Array<{ tool: string; ctx: ToolContext<Auth> }> = [];

  const testUsers: TestUsersConfig<Auth> | undefined =
    opts.testUsers === null
      ? undefined
      : {
          users: JSON.stringify(USERS),
          async login(credentials, entry) {
            order.push('login');
            logins.push({ credentials, entry });
            const { username } = credentials as { username: string };
            return {
              auth: { sessionCookie: `session-for-${username}` },
              identity: { userId: `u-${username}`, username, role: { id: 'r-1', name: 'Clerk' } },
            };
          },
          onEvent: (e) => {
            events.push(e);
          },
          ...opts.testUsers,
        };

  const server = createMcpServer<Auth>({
    name: 'test-mcp',
    adminKey: ADMIN_KEY,
    jwtSecrets: JWT_SECRET,
    hubClient: opts.hub ?? hub,
    store,
    logger,
    ...(testUsers ? { testUsers } : {}),
    ...opts.extra,
  });
  const record = (tool: string) => (_args: unknown, ctx: ToolContext<Auth>) => {
    seen.push({ tool, ctx });
    return { ran: tool };
  };
  server.tool({ name: 'read', input: z.object({}), annotations: { readOnlyHint: true }, handler: record('read') });
  server.tool({ name: 'write', input: z.object({}), handler: record('write') });
  server.tool({
    name: 'write_false',
    input: z.object({}),
    annotations: { readOnlyHint: false },
    handler: record('write_false'),
  });

  const httpServer: Server = await new Promise((resolve) => {
    const s = server.listen(0, () => resolve(s));
  });
  open.add(httpServer);
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    hub,
    logger,
    store,
    events,
    logins,
    seen,
    order,
    server,
    close: () =>
      new Promise((resolve, reject) => {
        open.delete(httpServer);
        httpServer.closeAllConnections();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const open = new Set<Server>();
after(() => {
  for (const s of open) {
    s.closeAllConnections();
    s.close();
  }
});

export async function post(
  url: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; json: any; headers: Headers }> {
  const res = await fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers };
}

/** Issue a bind ticket on the fake Hub, sign the user in, return the delivered handle. */
export async function testSignIn(h: TestHarness, userKey: string, ticket = `t-bind-${userKey}-${Math.random()}`) {
  h.hub.tickets.set(ticket, { purpose: 'bind', userKey });
  const res = await post(h.url, '/test-bind', { ticket, userKey });
  if (res.status !== 200) throw new Error(`test-bind failed: ${res.status} ${res.text}`);
  const delivery = h.hub.deliveries.at(-1)!;
  return { res, delivery, token: delivery.token };
}

export function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}
