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
