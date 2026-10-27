import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { bindAndToken, listTools, startHarness } from './support.js';

async function tools(h: Awaited<ReturnType<typeof startHarness>>) {
  const token = await bindAndToken(h, 'conn-ann');
  const res = await listTools(h.url, token);
  assert.equal(res.status, 200);
  return res.body.result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
}

test('ANN-001 C1: annotations on a ToolDefinition appear unchanged in tools/list', async () => {
  const annotations = {
    title: 'Delete invoice',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  };
  const h = await startHarness((s) => {
    s.tool({ name: 'del', input: z.object({}), annotations, handler: () => ({ ok: true }) } as never);
  });
  const list = await tools(h);
  assert.deepEqual(list.find((t) => t.name === 'del')?.annotations, annotations);
  await h.close();
});

test('ANN-001 C1: a tool without annotations lists no annotations key (no invented defaults)', async () => {
  const h = await startHarness((s) => {
    s.tool({ name: 'plain', input: z.object({}), handler: () => ({ ok: true }) });
  });
  const list = await tools(h);
  const plain = list.find((t) => t.name === 'plain')!;
  assert.equal('annotations' in plain, false);
  await h.close();
});

test('ANN-001 C1: annotations are per tool, a neighbour is not affected', async () => {
  const h = await startHarness((s) => {
    s.tool({ name: 'ro', input: z.object({}), annotations: { readOnlyHint: true }, handler: () => ({}) } as never);
    s.tool({ name: 'other', input: z.object({}), handler: () => ({}) });
  });
  const list = await tools(h);
  assert.deepEqual(list.find((t) => t.name === 'ro')?.annotations, { readOnlyHint: true });
  assert.equal(list.find((t) => t.name === 'other')?.annotations, undefined);
  await h.close();
});
