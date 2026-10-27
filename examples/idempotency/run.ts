/**
 * Small server for hand-driving idempotency and annotations:
 *
 *   npx tsx examples/idempotency/run.ts
 *
 * Tools: `count` (counts handler runs), `slow` (sleeps SLOW_MS, default 5000),
 * `boom` (always throws), `read_only` (carries annotations). A stub Hub prints
 * the handle-JWT it receives at bind time, then the curl lines are printed.
 */
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createMcpServer } from '../../src/index.js';

const ADMIN_KEY = 'admin-secret';
const SLOW_MS = Number(process.env.SLOW_MS ?? 5000);
const WAIT_MS = Number(process.env.WAIT_MS ?? 2000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let runs = 0;

const server = createMcpServer<{ sessionCookie: string }>({
  name: 'idempotency-demo',
  adminKey: ADMIN_KEY,
  jwtSecrets: 'jwt-secret',
  idempotency: { waitMs: WAIT_MS },
  hubClient: {
    async bind(connectionId, token) {
      process.stderr.write(`\n[hub] bound connection ${connectionId}\n[hub] handle-JWT:\n${token}\n`);
    },
  },
});

server
  .tool({
    name: 'count',
    description: 'Counts how many times the handler really ran.',
    input: z.object({}),
    handler: async () => ({ run: (runs += 1) }),
  })
  .tool({
    name: 'slow',
    description: `Sleeps ${SLOW_MS} ms, then returns the run counter.`,
    input: z.object({}),
    handler: async () => {
      await sleep(SLOW_MS);
      return { run: (runs += 1) };
    },
  })
  .tool({
    name: 'boom',
    description: 'Always throws.',
    input: z.object({}),
    handler: async () => {
      runs += 1;
      throw new Error(`boom (run ${runs})`);
    },
  })
  .tool({
    name: 'read_only',
    description: 'Carries annotations (see tools/list).',
    annotations: { title: 'Read only', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    input: z.object({}),
    handler: async () => ({ ok: true }),
  });

const httpServer = server.listen(0, () => {
  const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  const call = (name: string, key: string) =>
    `   curl -s ${url}/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\\n` +
    `     -H 'authorization: Bearer <TOKEN>' \\\n` +
    `     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${name}","arguments":{},"_meta":{"dioschub/idempotencyKey":"${key}"}}}'`;
  process.stderr.write(
    [
      '',
      `idempotency demo : ${url}  (waitMs=${WAIT_MS}, slow=${SLOW_MS} ms)`,
      '',
      '1) Bind (the handle-JWT prints above; copy it as <TOKEN>):',
      `   curl -s ${url}/bind -H 'content-type: application/json' -H 'x-admin-key: ${ADMIN_KEY}' \\`,
      `     -d '{"connectionId":"conn-1","artifacts":{"sessionCookie":"demo-cookie"}}'`,
      '',
      '2) Capability and annotations:',
      `   curl -s ${url}/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\`,
      `     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'`,
      `   curl -s ${url}/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\`,
      `     -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'`,
      '',
      '3) Same key twice: both return the same run, the counter moves once:',
      call('count', 'k1'),
      '',
      '4) Slow tool: run this, then the same line again within the wait window (waits, same result);',
      '   past WAIT_MS you get IN_PROGRESS:',
      call('slow', 'k-slow'),
      '',
      '5) Throwing tool: the second call replays the first error, no re-run:',
      call('boom', 'k-boom'),
      '',
      'Ctrl-C to stop.',
      '',
    ].join('\n'),
  );
});
