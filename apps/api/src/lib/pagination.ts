import type { Context } from 'hono'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../constants.js'

export function parsePagination(c: Context) {
  const page = Math.max(1, Number(c.req.query('page') ?? 1))
  const limit = Math.min(
    MAX_PAGE_LIMIT,
    Math.max(1, Number(c.req.query('limit') ?? DEFAULT_PAGE_LIMIT)),
  )
  const skip = (page - 1) * limit
  return { page, limit, skip }
}
