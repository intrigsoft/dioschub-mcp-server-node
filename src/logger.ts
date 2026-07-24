/**
 * Minimal structured logger. The framework routes everything through this and
 * never hands it auth artifacts — credential-blind is enforced by what we pass,
 * not by hoping a formatter redacts.
 *
 * Writes to stderr, never stdout: an MCP server's stdout is reserved for the
 * protocol. Swap in your own impl (pino, TracedLogger, …) via config.logger.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Returns a logger that merges `bindings` into every record. */
  child(bindings: Record<string, unknown>): Logger;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

class StderrLogger implements Logger {
  constructor(private readonly bindings: Record<string, unknown> = {}) {}

  private write(level: Level, msg: string, fields?: Record<string, unknown>): void {
    const record = {
      level,
      time: new Date().toISOString(),
      msg,
      ...this.bindings,
      ...fields,
    };
    process.stderr.write(JSON.stringify(record) + '\n');
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }
  child(bindings: Record<string, unknown>): Logger {
    return new StderrLogger({ ...this.bindings, ...bindings });
  }
}

export function defaultLogger(bindings: Record<string, unknown> = {}): Logger {
  return new StderrLogger(bindings);
}
