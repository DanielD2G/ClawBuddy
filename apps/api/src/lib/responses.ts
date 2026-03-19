import type { Context } from 'hono'

export function ok<T>(c: Context, data: T, status: 200 | 201 = 200) {
  return c.json({ success: true as const, data }, status)
}

export function fail(c: Context, error: string, status: 400 | 401 | 403 | 404 | 409 | 500 = 400) {
  return c.json({ success: false as const, error }, status)
}
