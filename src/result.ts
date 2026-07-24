import type { Logger } from './logger.js';

/** Shape the MCP SDK expects back from a tool handler. */
export interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  // The SDK's result type carries an open index signature (for _meta etc.);
  // mirror it so our result is structurally assignable.
  [key: string]: unknown;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Wrap whatever the author returned into a CallToolResult. If they already
 * returned a well-formed result (has a `content` array), pass it through.
 */
export function toCallToolResult(value: unknown): CallToolResult {
  if (isCallToolResult(value)) return value;
  const text = value === undefined ? 'null' : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    ...(isPlainObject(value) ? { structuredContent: value } : {}),
  };
}

/**
 * Credential-blind backstop. In dev, scan a tool result for any string leaf of
 * the auth artifacts that leaked into the output. An author CAN misuse `ctx.auth`
 * by echoing it — this makes that mistake loud instead of silent. Not a security
 * boundary (an author can always exfiltrate deliberately); a guardrail against
 * accident. Off in production to avoid scanning cost.
 */
export function assertNoArtifactLeak(result: unknown, artifacts: unknown, logger: Logger): void {
  const secrets = collectStrings(artifacts);
  if (secrets.length === 0) return;
  const haystack = safeStringify(result);
  const leaked = secrets.find((s) => haystack.includes(s));
  if (leaked !== undefined) {
    logger.error(
      'CREDENTIAL-BLIND VIOLATION: a tool result contains a value from ctx.auth. ' +
        'Never return, log, or echo native auth artifacts.',
      { leakedLength: leaked.length },
    );
  }
}

/** Collect string leaves worth checking (length >= 8 to avoid false positives). */
function collectStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.length >= 8) acc.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, acc);
  } else if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) collectStrings(v, acc);
  }
  return acc;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
