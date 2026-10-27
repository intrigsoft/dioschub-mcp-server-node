import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bind, deferred, sleep, startHarnessWith } from './support.js';

const KEY = 'dioschub/idempotencyKey';

type Text = { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: any };

async function setup(waitMs: number, gate?: Promise<void>) {
  const counter = { count: 0 };
  const annotations = { title: 'Create order', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const h = await startHarnessWith({ idempotency: { waitMs } }, (s) => {
    s.tool({
      name: 'create_order',
      input: z.object({ item: z.string() }),
      annotations,
      handler: async (args: { item: string }) => {
        counter.count += 1;
        if (gate) await gate;
        return { orderId: `order-${counter.count}`, item: args.item };
      },
    } as never);
    s.tool({ name: 'ping', input: z.object({}), handler: () => ({ pong: true }) });
  });
  assert.equal((await bind(h.url, 'conn-e2e', { sessionCookie: 'secret' })).status, 200);
  const token = h.hub.lastToken();
  const client = new Client({ name: 'test-hub', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return { h, client, counter, annotations };
}

test('IDEM-001 ANN-001 R15 C1 C2: client sees the capability and the annotations', async () => {
  const { h, client, annotations } = await setup(1000);
  const caps = client.getServerCapabilities() as any;
  assert.deepEqual(caps.experimental?.['dioschub/idempotency'], { version: 1 });
  assert.ok(caps.tools);
  const { tools } = await client.listTools();
  const order = tools.find((t) => t.name === 'create_order')!;
  assert.deepEqual(order.annotations, annotations);
  assert.equal('annotations' in tools.find((t) => t.name === 'ping')!, false);
  await client.close();
  await h.close();
});

test('IDEM-003 R15 C4: two SDK calls with the same key run the handler once and return the same result', async () => {
  const { h, client, counter } = await setup(1000);
  const call = () =>
    client.callTool({ name: 'create_order', arguments: { item: 'book' }, _meta: { [KEY]: 'order-1' } }) as Promise<Text>;
  const a = await call();
  const b = await call();
  assert.equal(counter.count, 1);
  assert.equal(JSON.stringify(b.content), JSON.stringify(a.content));
  // a different key is a new order
  const c = (await client.callTool({ name: 'create_order', arguments: { item: 'book' }, _meta: { [KEY]: 'order-2' } })) as Text;
  assert.equal(counter.count, 2);
  assert.notEqual(JSON.stringify(c.content), JSON.stringify(a.content));
  await client.close();
  await h.close();
});

test('IDEM-004 R15 C6: a concurrent duplicate waits, then gets IN_PROGRESS; the first still completes', async () => {
  const gate = deferred();
  const { h, client, counter } = await setup(150, gate.promise);
  const first = client.callTool({ name: 'create_order', arguments: { item: 'x' }, _meta: { [KEY]: 'k' } }) as Promise<Text>;
  await sleep(80);
  const dup = (await client.callTool({ name: 'create_order', arguments: { item: 'x' }, _meta: { [KEY]: 'k' } })) as Text;
  assert.equal(dup.isError, true);
  assert.equal(dup.structuredContent.code, 'IN_PROGRESS');
  assert.equal(counter.count, 1);
  gate.resolve();
  const done = await first;
  assert.notEqual(done.isError, true);
  const again = (await client.callTool({ name: 'create_order', arguments: { item: 'x' }, _meta: { [KEY]: 'k' } })) as Text;
  assert.equal(JSON.stringify(again.content), JSON.stringify(done.content));
  assert.equal(counter.count, 1);
  await client.close();
  await h.close();
});

test('IDEM-002 R15 C3: a malformed key through the SDK client gets INVALID_IDEMPOTENCY_KEY', async () => {
  const { h, client, counter } = await setup(1000);
  const r = (await client.callTool({ name: 'create_order', arguments: { item: 'x' }, _meta: { [KEY]: 12345 as never } })) as Text;
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.code, 'INVALID_IDEMPOTENCY_KEY');
  assert.equal(counter.count, 0);
  await client.close();
  await h.close();
});
