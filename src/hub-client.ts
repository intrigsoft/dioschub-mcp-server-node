import type { BindIdentity, HubConfig } from './types.js';
import type { Logger } from './logger.js';

/**
 * The one thing the framework asks of the Hub: bind our handle to a Hub
 * connection. Declared as an interface so it can be swapped (custom retry,
 * a different transport, or a fake in tests).
 *
 * `connectionId` is the Hub's WebSocket connection id (`wsId` on the wire),
 * surfaced by the kit on `bind:ready`. `identity` is optional non-credential
 * metadata the Hub uses for role features; null/omitted = anonymous.
 */
export interface HubBinder {
  bind(connectionId: string, token: string, identity?: BindIdentity | null): Promise<void>;
}

export class HubBindError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Hub bind failed with ${status}: ${body}`);
    this.name = 'HubBindError';
  }
}

/**
 * Server-to-server client for the one call this framework makes to the Hub:
 * `POST /api/auth/bind`. Rides the admin API-key channel (`x-api-key: diosc_ak_…`
 * with the `auth:bind` scope) — the same channel used for file operations.
 *
 * Credential-blind by construction: we place our opaque handle-JWT into
 * `authArtifacts.headers.Authorization` as a Bearer token. The Hub stores that
 * and forwards it verbatim to this MCP server on every tool call — so the Hub
 * only ever holds the handle, never the native credentials it stands for.
 *
 * IMPORTANT deployment note: the Hub forwards per-user BYOA headers ONLY to
 * credential-less ("conduit") MCP instances. If the MCP instance is configured
 * with static server auth in the Hub, the handle is dropped and tool calls
 * arrive unauthenticated. Attach this server as a conduit instance.
 */
export class HubClient implements HubBinder {
  private readonly bindUrl: string;
  private readonly apiKeyHeader: string;

  constructor(
    private readonly config: HubConfig,
    private readonly logger: Logger,
  ) {
    const base = config.url.replace(/\/+$/, '');
    const path = config.bindPath ?? '/api/auth/bind';
    this.bindUrl = base + path;
    this.apiKeyHeader = config.apiKeyHeader ?? 'x-api-key';
  }

  async bind(connectionId: string, token: string, identity?: BindIdentity | null): Promise<void> {
    const res = await fetch(this.bindUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [this.apiKeyHeader]: this.config.apiKey,
      },
      body: JSON.stringify({
        wsId: connectionId,
        identity: identity ?? null,
        // The handle rides here; the Hub replays these headers verbatim to us.
        authArtifacts: { headers: { Authorization: `Bearer ${token}` } },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error('hub bind rejected', { connectionId, status: res.status });
      throw new HubBindError(res.status, body);
    }
    this.logger.debug('hub bind ok', { connectionId });
  }
}
