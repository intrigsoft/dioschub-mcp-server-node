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
 * Credential-blind by construction: we hand the Hub our opaque handle-JWT as a
 * Bearer token, and it replays that to us on every tool call — so the Hub only
 * ever holds the handle, never the native credentials it stands for.
 *
 * ## Audience binding
 *
 * Our handle is minted with `aud` set to this server, so no other server can
 * *use* it. That is not the whole story: whether the handle is ever *shown* to
 * another server is the Hub's forwarding decision, not ours. Bound
 * session-wide, the Hub replays it to every credential-less ("conduit")
 * instance the assistant has attached — so an unrelated MCP server receives a
 * live credential for this one, learns it exists, and can replay it here.
 *
 * So the bind names its target. `authArtifacts.perServer[instanceName]` asks
 * the Hub to forward the handle to this instance and nothing else; the Hub
 * treats a per-target map as authoritative and gives unnamed instances no
 * credentials at all.
 *
 * Both shapes are sent. A Hub that predates per-target binding ignores
 * `perServer` (its bind DTO does not whitelist-strip unknown fields) and uses
 * `headers`, behaving exactly as before; a Hub that supports it uses
 * `perServer` and ignores `headers`. That keeps this a drop-in upgrade with no
 * version coupling in either direction.
 *
 * `instanceName` must match the Hub's registered instance name exactly. It
 * defaults to the framework's `name`, which `createMcpServer` resolves for us.
 *
 * IMPORTANT deployment note: the Hub forwards per-user BYOA credentials ONLY to
 * credential-less ("conduit") MCP instances. If the MCP instance is configured
 * with static server auth in the Hub, the handle is dropped and tool calls
 * arrive unauthenticated. Attach this server as a conduit instance.
 */
export class HubClient implements HubBinder {
  private readonly bindUrl: string;
  private readonly apiKeyHeader: string;
  private readonly instanceName?: string;
  private warnedUntargeted = false;

  constructor(
    private readonly config: HubConfig,
    private readonly logger: Logger,
  ) {
    const base = config.url.replace(/\/+$/, '');
    const path = config.bindPath ?? '/api/auth/bind';
    this.bindUrl = base + path;
    this.apiKeyHeader = config.apiKeyHeader ?? 'x-api-key';
    this.instanceName = config.instanceName;
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
        authArtifacts: this.authArtifacts(token),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error('hub bind rejected', { connectionId, status: res.status });
      throw new HubBindError(res.status, body);
    }
    this.logger.debug('hub bind ok', { connectionId, target: this.instanceName ?? null });
  }

  /**
   * The handle in both the per-target slot and the session-wide slot — see the
   * class docs for why both. Without an `instanceName` we cannot name a target,
   * so we send only the session-wide shape and say so once: that is the old
   * leaky behaviour, and it should be a deliberate choice rather than a silent
   * default.
   */
  private authArtifacts(token: string): Record<string, unknown> {
    const authorization = `Bearer ${token}`;

    if (!this.instanceName) {
      if (!this.warnedUntargeted) {
        this.warnedUntargeted = true;
        this.logger.warn(
          'binding without an instanceName — the Hub will replay this handle to every ' +
            'conduit MCP instance on the assistant, not just this server. Set hub.instanceName ' +
            'to this server\'s Hub instance name to scope it.',
        );
      }
      return { headers: { Authorization: authorization } };
    }

    return {
      headers: { Authorization: authorization },
      perServer: { [this.instanceName]: { headers: { Authorization: authorization } } },
    };
  }
}
