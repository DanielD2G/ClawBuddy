import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { POLL_UPDATE_CHECK_MS } from '@/constants'
import { createMutation } from './create-mutation'

// ── Types ───────────────────────────────────────────

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseNotes: string
  publishedAt: string
}

export interface VersionResult {
  currentVersion: string
}

// ── Hooks ───────────────────────────────────────────

/** Periodically checks GitHub for a newer release (every 30 min, refetch on window focus). */
export function useUpdateCheck() {
  return useQuery({
    queryKey: ['update-check'],
    queryFn: () => apiClient.get<UpdateCheckResult>('/admin/update/check'),
    refetchInterval: POLL_UPDATE_CHECK_MS,
    staleTime: 5 * 60 * 1000, // 5 min
    refetchOnWindowFocus: true,
    retry: false,
  })
}

/** Returns the currently running version (read once per session). */
export function useCurrentVersion() {
  return useQuery({
    queryKey: ['current-version'],
    queryFn: () => apiClient.get<VersionResult>('/admin/update/version'),
    staleTime: Infinity,
  })
}

/** Triggers the update process on the server. */
export const useApplyUpdate = createMutation<
  { message: string },
  { version: string }
>('post', '/admin/update/apply', [])
