import { FileAccessError, FileAccessTokenMissing } from './errors.js';

/** The `_meta` key under which the Hub puts the per-call file access token. */
export const FILE_ACCESS_META_KEY = 'dioschub/fileAccess';

/** The header the Hub reads the file access token from. */
export const FILE_ACCESS_HEADER = 'x-file-access-token';

export interface FilesConfig {
  /** Base URL of the DioscHub instance, e.g. https://hub.example.com */
  url: string;
  /** The admin API key carrying `mcp-files:read` and/or `mcp-files:write`. */
  apiKey: string;
  /** Header the Hub expects the API key in. Default: `x-api-key`. */
  apiKeyHeader?: string;
  /** Replace the global fetch (tests, custom transport). */
  fetch?: typeof fetch;
}

/** The part of a tool handler's `ctx` the helpers need. */
export interface FileCallContext {
  meta: Readonly<Record<string, unknown>>;
}

export interface UploadFileInput {
  filename: string;
  content: Blob | ArrayBuffer | Uint8Array | string;
  mimeType?: string;
}

export interface FileClient {
  /** `get_file`: the raw Response; read `body` as a stream. Throws FileAccessError on non-2xx. */
  fetchFile(ctx: FileCallContext, name: string): Promise<Response>;
  /** `put_file`: resolves to the stored name (may be disambiguated by the Hub). */
  uploadFile(ctx: FileCallContext, input: UploadFileInput): Promise<{ filename: string }>;
}

function tokenFrom(ctx: FileCallContext): string {
  const token = ctx.meta[FILE_ACCESS_META_KEY];
  if (typeof token !== 'string' || token.length === 0) throw new FileAccessTokenMissing();
  return token;
}

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body?.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read and write the signed-in user's chat files from a tool handler.
 *
 * Each call sends the MCP files API key plus the call's file access token
 * (`_meta["dioschub/fileAccess"]`) as `X-File-Access-Token`; the Hub takes the
 * session from the token. A call without a token throws FileAccessTokenMissing:
 * there is no fallback to the deprecated key + `X-Session-Id` path. The token
 * is a credential: it is never logged, and the errors never carry it. Do not
 * put it in a tool result either.
 */
export function createFileClient(config: FilesConfig): FileClient {
  const base = config.url.replace(/\/+$/, '');
  const keyHeader = config.apiKeyHeader ?? 'x-api-key';
  const doFetch = config.fetch ?? fetch;

  const headers = (token: string): Record<string, string> => ({
    [keyHeader]: config.apiKey,
    [FILE_ACCESS_HEADER]: token,
  });

  return {
    async fetchFile(ctx, name) {
      const token = tokenFrom(ctx);
      const res = await doFetch(`${base}/api/mcp/files/fetch`, {
        method: 'POST',
        headers: { ...headers(token), 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new FileAccessError(res.status, await errorCode(res), 'fetch');
      return res;
    },

    async uploadFile(ctx, input) {
      const token = tokenFrom(ctx);
      const form = new FormData();
      const blob =
        input.content instanceof Blob
          ? input.content
          : new Blob([input.content] as ConstructorParameters<typeof Blob>[0], input.mimeType ? { type: input.mimeType } : undefined);
      form.append('file', blob, input.filename);
      const res = await doFetch(`${base}/api/mcp/files/upload`, {
        method: 'POST',
        headers: headers(token),
        body: form,
      });
      if (!res.ok) throw new FileAccessError(res.status, await errorCode(res), 'upload');
      return (await res.json()) as { filename: string };
    },
  };
}
