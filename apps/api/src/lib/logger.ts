type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  sessionId?: string
  workspaceId?: string
  [key: string]: unknown
}

interface Logger {
  debug(message: string, ctx?: LogContext): void
  info(message: string, ctx?: LogContext): void
  warn(message: string, ctx?: LogContext): void
  error(message: string, error?: unknown, ctx?: LogContext): void
  child(ctx: LogContext): Logger
}

function serializeError(err: unknown): Record<string, unknown> | undefined {
  if (!err) return undefined
  if (err instanceof Error) return { errorMessage: err.message, stack: err.stack }
  return { errorMessage: String(err) }
}

function emit(level: LogLevel, message: string, ctx?: LogContext, err?: unknown) {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...ctx,
    ...serializeError(err),
  }
  const fn =
    level === 'debug'
      ? console.debug
      : level === 'warn'
        ? console.warn
        : level === 'error'
          ? console.error
          : console.info
  fn(JSON.stringify(entry))
}

function createLogger(baseCtx: LogContext = {}): Logger {
  return {
    debug: (msg, ctx) => emit('debug', msg, { ...baseCtx, ...ctx }),
    info: (msg, ctx) => emit('info', msg, { ...baseCtx, ...ctx }),
    warn: (msg, ctx) => emit('warn', msg, { ...baseCtx, ...ctx }),
    error: (msg, err?, ctx?) => emit('error', msg, { ...baseCtx, ...ctx }, err),
    child: (ctx) => createLogger({ ...baseCtx, ...ctx }),
  }
}

export const logger = createLogger()
