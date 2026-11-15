import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFileClient,
  FileAccessError,
  FileAccessTokenMissing,
} from '../src/index.js';

interface Seen {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: () => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetch: f, seen };
}

const TOKEN = 'opaque-token-value';
const ctx = { meta: { 'dioschub/fileAccess': TOKEN } };

test('fetchFile sends the api key and X-File-Access-Token, no session id', async () => {
  const { fetch: f, seen } = fakeFetch(() => new Response('bytes', { status: 200 }));
  const client = createFileClient({ url: 'https://hub.test/', apiKey: 'diosc_ak_x', fetch: f });
  const res = await client.fetchFile(ctx, 'a.xlsx');
  assert.equal(await res.text(), 'bytes');
  assert.equal(seen[0].url, 'https://hub.test/api/mcp/files/fetch');
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(h['x-api-key'], 'diosc_ak_x');
  assert.equal(h['x-file-access-token'], TOKEN);
  assert.equal(h['x-session-id'], undefined);
  assert.deepEqual(JSON.parse(seen[0].init.body as string), { name: 'a.xlsx' });
});

test('uploadFile posts multipart with the token and returns the stored name', async () => {
  const { fetch: f, seen } = fakeFetch(
    () => new Response(JSON.stringify({ filename: 'r (1).pdf' }), { status: 200 }),
  );
  const client = createFileClient({ url: 'https://hub.test', apiKey: 'k', fetch: f });
  const out = await client.uploadFile(ctx, { filename: 'r.pdf', content: 'abc', mimeType: 'application/pdf' });
  assert.equal(out.filename, 'r (1).pdf');
  assert.equal(seen[0].url, 'https://hub.test/api/mcp/files/upload');
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(h['x-file-access-token'], TOKEN);
  const file = (seen[0].init.body as FormData).get('file') as File;
  assert.equal(file.name, 'r.pdf');
  assert.equal(file.type, 'application/pdf');
});

test('a missing token throws FileAccessTokenMissing and sends nothing', async () => {
  const { fetch: f, seen } = fakeFetch(() => new Response('', { status: 200 }));
  const client = createFileClient({ url: 'https://hub.test', apiKey: 'k', fetch: f });
  await assert.rejects(() => client.fetchFile({ meta: {} }, 'a'), FileAccessTokenMissing);
  await assert.rejects(
    () => client.uploadFile({ meta: { 'dioschub/fileAccess': 42 } }, { filename: 'a', content: 'x' }),
    FileAccessTokenMissing,
  );
  assert.equal(seen.length, 0);
});

test('a 403 throws FileAccessError with status and code, never the token', async () => {
  const { fetch: f } = fakeFetch(
    () => new Response(JSON.stringify({ code: 'FORBIDDEN' }), { status: 403 }),
  );
  const client = createFileClient({ url: 'https://hub.test', apiKey: 'k', fetch: f });
  await assert.rejects(
    () => client.fetchFile(ctx, 'a'),
    (err: unknown) => {
      assert.ok(err instanceof FileAccessError);
      assert.equal(err.status, 403);
      assert.equal(err.code, 'FORBIDDEN');
      assert.ok(!err.message.includes(TOKEN));
      return true;
    },
  );
});
