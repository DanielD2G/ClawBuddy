import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'

type HttpMethod = 'post' | 'patch' | 'delete'

interface CreateMutationOptions<TData, TVariables> {
  /** Extra onSuccess handler called after invalidation. Receives data and variables. */
  onSuccess?: (data: TData, variables: TVariables) => void
}

/**
 * Factory that creates a React Query mutation hook, eliminating boilerplate
 * for the common pattern of: call API method -> invalidate query keys.
 *
 * @param method      HTTP method to use
 * @param url         Static URL string, or a function that builds the URL from variables
 * @param invalidateKeys  Query key prefixes to invalidate on success.
 *                        Can be static arrays or a function of (data, variables) for dynamic keys.
 * @param options     Optional extra onSuccess callback
 */
export function createMutation<TData = unknown, TVariables = unknown>(
  method: HttpMethod,
  url: string | ((variables: TVariables) => string),
  invalidateKeys: string[][] | ((data: TData, variables: TVariables) => string[][]) = [],
  options?: CreateMutationOptions<TData, TVariables>,
): () => UseMutationResult<TData, Error, TVariables> {
  return function useMutationHook() {
    const queryClient = useQueryClient()
    return useMutation<TData, Error, TVariables>({
      mutationFn: (variables: TVariables) => {
        const resolvedUrl = typeof url === 'function' ? url(variables) : url
        // For methods that send a body, extract it from variables.
        // If the url is dynamic (function), the function may have consumed some fields;
        // we pass the full variables object as body for post/patch (the server ignores extras like `id`).
        if (method === 'delete') {
          return apiClient.delete<TData>(resolvedUrl)
        }
        return apiClient[method]<TData>(resolvedUrl, variables as unknown)
      },
      onSuccess: (data, variables) => {
        const keys =
          typeof invalidateKeys === 'function' ? invalidateKeys(data, variables) : invalidateKeys
        for (const key of keys) {
          queryClient.invalidateQueries({ queryKey: key })
        }
        options?.onSuccess?.(data, variables)
      },
    })
  }
}

/**
 * Variant for mutations that need access to React context (hooks) inside onSuccess.
 * Instead of a plain options object, accepts a setup function that runs inside the hook
 * and returns the extra onSuccess handler.
 */
export function createMutationWithContext<TData = unknown, TVariables = unknown>(
  method: HttpMethod,
  url: string | ((variables: TVariables) => string),
  invalidateKeys: string[][] | ((data: TData, variables: TVariables) => string[][]),
  useSetup: () => (data: TData, variables: TVariables) => void,
): () => UseMutationResult<TData, Error, TVariables> {
  return function useMutationHook() {
    const queryClient = useQueryClient()
    const extraOnSuccess = useSetup()
    return useMutation<TData, Error, TVariables>({
      mutationFn: (variables: TVariables) => {
        const resolvedUrl = typeof url === 'function' ? url(variables) : url
        if (method === 'delete') {
          return apiClient.delete<TData>(resolvedUrl)
        }
        return apiClient[method]<TData>(resolvedUrl, variables as unknown)
      },
      onSuccess: (data, variables) => {
        const keys =
          typeof invalidateKeys === 'function' ? invalidateKeys(data, variables) : invalidateKeys
        for (const key of keys) {
          queryClient.invalidateQueries({ queryKey: key })
        }
        extraOnSuccess(data, variables)
      },
    })
  }
}

/**
 * Variant for mutations with a fully custom mutationFn (e.g., FormData uploads).
 * Only provides the invalidation wiring.
 */
export function createCustomMutation<TData = unknown, TVariables = unknown>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  invalidateKeys: string[][] = [],
): () => UseMutationResult<TData, Error, TVariables> {
  return function useMutationHook() {
    const queryClient = useQueryClient()
    return useMutation<TData, Error, TVariables>({
      mutationFn,
      onSuccess: () => {
        for (const key of invalidateKeys) {
          queryClient.invalidateQueries({ queryKey: key })
        }
      },
    })
  }
}
