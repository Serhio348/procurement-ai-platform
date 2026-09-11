import process from "node:process";

/**
 * Structured logging. The point of this package is that a single log line can
 * answer "who started what, which agent ran, which tool it called and what came
 * back" - so correlation ids are a typed part of the context, not free-form
 * strings a caller may forget.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  requestId?: string;
  taskId?: string;
  agentId?: string;
  runId?: string;
  procurementId?: string;
  domainProfileId?: string;
  toolName?: string;
  component?: string;
}

export type LogFields = Record<string, unknown>;

export interface LogRecord extends LogContext {
  level: LogLevel;
  time: string;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  /** Derive a logger that carries additional correlation ids. */
  child(context: LogContext): Logger;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, error?: unknown, fields?: LogFields): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  context?: LogContext;
  /** Where a finished record goes. Overridden in tests. */
  sink?: (record: LogRecord) => void;
  clock?: () => Date;
  /** Field names whose values must never reach the log. */
  redactKeys?: readonly string[];
}

const DEFAULT_REDACT_KEYS = [
  "password",
  "token",
  "apikey",
  "api_key",
  "secret",
  "authorization",
  "cookie",
  "accesskey",
  "access_key",
] as const;

const REDACTED = "[redacted]";
const MAX_REDACTION_DEPTH = 6;

function defaultSink(record: LogRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function redact(value: unknown, keys: ReadonlySet<string>, depth = 0): unknown {
  if (depth >= MAX_REDACTION_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, keys, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = keys.has(key.toLowerCase()) ? REDACTED : redact(item, keys, depth + 1);
  }
  return result;
}

// Driver errors (drizzle, pg) embed the full query with parameters in the
// message; a JSONB case with extracted document text runs to hundreds of KB
// and floods journald, hiding the actual failure reason kept in `cause`.
const MAX_ERROR_TEXT = 2_000;

function clip(text: string): string {
  return text.length > MAX_ERROR_TEXT
    ? `${text.slice(0, MAX_ERROR_TEXT)}… [${String(text.length - MAX_ERROR_TEXT)} more chars]`
    : text;
}

/** Errors are flattened so the log stays valid JSON. */
function serialiseError(error: unknown): LogFields {
  if (error instanceof Error) {
    const serialised: LogFields = { name: error.name, message: clip(error.message) };
    if (error.stack !== undefined) serialised["stack"] = clip(error.stack);
    if (error.cause !== undefined) serialised["cause"] = clip(String(error.cause));
    return { err: serialised };
  }
  if (error === undefined) return {};
  return { err: { message: clip(String(error)) } };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const sink = options.sink ?? defaultSink;
  const clock = options.clock ?? (() => new Date());
  const redactKeys = new Set(
    (options.redactKeys ?? DEFAULT_REDACT_KEYS).map((key) => key.toLowerCase()),
  );
  const context = options.context ?? {};
  const threshold = LEVEL_RANK[level];

  const write = (recordLevel: LogLevel, msg: string, fields: LogFields): void => {
    if (LEVEL_RANK[recordLevel] < threshold) return;

    const safeFields = redact(fields, redactKeys) as LogFields;
    sink({
      level: recordLevel,
      time: clock().toISOString(),
      msg,
      ...context,
      ...safeFields,
    });
  };

  return {
    child(childContext: LogContext): Logger {
      return createLogger({
        ...options,
        level,
        sink,
        clock,
        redactKeys: [...redactKeys],
        context: { ...context, ...childContext },
      });
    },
    debug: (msg, fields) => write("debug", msg, fields ?? {}),
    info: (msg, fields) => write("info", msg, fields ?? {}),
    warn: (msg, fields) => write("warn", msg, fields ?? {}),
    error: (msg, error, fields) => write("error", msg, { ...fields, ...serialiseError(error) }),
  };
}

/** Logger that discards everything. Useful as a default in library code. */
export const silentLogger: Logger = createLogger({ level: "error", sink: () => {} });
