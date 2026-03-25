const PROVIDER_TIMEOUT_PATTERNS = [
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\btime-out\b/i,
  /\betimedout\b/i,
  /\bdeadline exceeded\b/i,
]

export const PROVIDER_TIMEOUT_USER_MESSAGE =
  'The model provider timed out while generating the response. Please retry.'

export function isProviderTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false

  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '').trim()

  return PROVIDER_TIMEOUT_PATTERNS.some((pattern) => pattern.test(message))
}

export function getProviderErrorMessage(error: unknown): string {
  if (isProviderTimeoutError(error)) return PROVIDER_TIMEOUT_USER_MESSAGE

  const message = error instanceof Error ? error.message.trim() : String(error ?? '').trim()
  return message || 'An unexpected error occurred'
}

export async function retryProviderTimeoutOnce<T>(
  operation: () => Promise<T>,
  options?: {
    onRetry?: (error: unknown) => void | Promise<void>
  },
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (!isProviderTimeoutError(error)) throw error
    await options?.onRetry?.(error)
    return operation()
  }
}
