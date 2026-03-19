import type { ZodSchema } from 'zod'
import { ValidationError } from './errors.js'

/**
 * Validate a request body against a Zod schema.
 * Throws a ValidationError (caught by error-handler middleware) on failure.
 */
export function validateBody<T>(schema: ZodSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input')
  }
  return parsed.data
}
