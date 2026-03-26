import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { AppError } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

export const errorHandler = (err: Error, c: Context) => {
  logger.error(`[Error] ${err.message}`, err)

  if (err instanceof AppError) {
    return c.json(
      { success: false, error: err.message, code: err.code },
      err.statusCode as ContentfulStatusCode,
    )
  }

  // Fallback for unknown errors
  const status = 'status' in err && typeof err.status === 'number' ? err.status : 500
  const message = status === 500 ? 'Internal Server Error' : err.message

  return c.json({ success: false, error: message }, status as ContentfulStatusCode)
}
