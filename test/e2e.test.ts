import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { bind, startHarness } from './support.js';

test('bind → tool call: the exact bound artifacts and connectionId reach ctx', async () => {
  const h = await startHarness((s) => {
    s.tool({
      name: 'whoami',
      input: z.object({}),
      handler: (_args, ctx) => ({
        // never echo the raw cookie — assert on a derived boolean
        seenCookie: ctx.auth.sessionCookie === 'secret-cookie-123',
        conn: ctx.connectionId,
      }),
    });
  });

  // App binds the user's native session cookie.
  const bindRes = await bind(h.url, 'conn-99', { sessionCookie: 'secret-cookie-123' });
  assert.equal(bindRes.status, 200);
  const token = h.hub.lastToken(); // the handle the Hub received — Hub replays it on calls

  // Speak MCP as the Hub would, carrying the handle-JWT.
  const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test-hub', version: '0.0.0' });
  await client.connect(transport);

  const result = (await client.callTool({ name: 'whoami', arguments: {} })) as {
    content: Array<{ type: string; text: string }>;
  };
  const payload = JSON.parse(result.content[0]!.text);
  assert.equal(payload.seenCookie, true);
  assert.equal(payload.conn, 'conn-99');

  await client.close();
  await h.close();
});
