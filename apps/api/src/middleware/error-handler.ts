import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export const errorHandler = (err: Error, c: Context) => {
  console.error(`[Error] ${err.message}`, err.stack)

  const status = 'status' in err && typeof err.status === 'number' ? err.status : 500
  const message = status === 500 ? 'Internal Server Error' : err.message

  return c.json({ success: false, error: message }, status as ContentfulStatusCode)
}
