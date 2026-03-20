import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { useStartSystemUpdate, useSystemUpdateStatus } from '@/hooks/use-system-update'
import { getSystemUpdateToastMessage, isSystemUpdateInProgress } from '@/lib/system-update'

const UPDATE_TOAST_ID = 'system-update-toast'
const UPDATE_OBSERVED_KEY = 'clawbuddy-system-update-observed'

function markObserved() {
  localStorage.setItem(UPDATE_OBSERVED_KEY, new Date().toISOString())
}

function clearObserved() {
  localStorage.removeItem(UPDATE_OBSERVED_KEY)
}

function hasObservedUpdate(): boolean {
  return Boolean(localStorage.getItem(UPDATE_OBSERVED_KEY))
}

export function SystemUpdateWatcher() {
  const queryClient = useQueryClient()
  const { data, isError, refetch } = useSystemUpdateStatus()
  const startUpdate = useStartSystemUpdate()
  const reloadTriggeredRef = useRef(false)
  const reconnectingRef = useRef(false)

  useEffect(() => {
    if (!data?.supported || !data.available || isSystemUpdateInProgress(data.state.status)) {
      return
    }

    const currentVersion = data.current?.version ?? 'current'
    const targetVersion = data.latest?.version ?? 'new'

    toast.info('New version available', {
      id: UPDATE_TOAST_ID,
      duration: Infinity,
      description: `ClawBuddy ${currentVersion} -> ${targetVersion}`,
      action: {
        label: startUpdate.isPending ? 'Starting...' : 'Update now',
        onClick: () => {
          markObserved()
          toast.loading('Starting update...', {
            id: UPDATE_TOAST_ID,
            duration: Infinity,
          })
          startUpdate.mutate()
        },
      },
    })
  }, [data, startUpdate])

  useEffect(() => {
    if (!data) return

    if (isSystemUpdateInProgress(data.state.status)) {
      markObserved()
      toast.loading(getSystemUpdateToastMessage(data.state.status), {
        id: UPDATE_TOAST_ID,
        duration: Infinity,
        description: data.state.targetVersion
          ? `Updating to ${data.state.targetVersion}`
          : undefined,
      })
      return
    }

    if (data.state.status === 'failed') {
      clearObserved()
      reconnectingRef.current = false
      toast.error(data.state.error ?? data.state.message, {
        id: UPDATE_TOAST_ID,
        duration: 10_000,
      })
      return
    }

    if (data.state.status === 'succeeded') {
      toast.success('Update complete. Reloading...', {
        id: UPDATE_TOAST_ID,
        duration: Infinity,
      })

      if (hasObservedUpdate() && !reloadTriggeredRef.current) {
        reloadTriggeredRef.current = true
        clearObserved()
        window.setTimeout(() => window.location.reload(), 1200)
      }
      return
    }

    if (!data.available) {
      toast.dismiss(UPDATE_TOAST_ID)
    }
  }, [data])

  useEffect(() => {
    if (!isError || !hasObservedUpdate() || reconnectingRef.current) return

    reconnectingRef.current = true
    toast.loading('Applying update, reconnecting...', {
      id: UPDATE_TOAST_ID,
      duration: Infinity,
    })

    const interval = window.setInterval(async () => {
      try {
        const res = await fetch('/api/health', { credentials: 'include' })
        if (!res.ok) return

        reconnectingRef.current = false
        window.clearInterval(interval)
        await refetch()
        queryClient.invalidateQueries({ queryKey: ['system-update'] })
      } catch {
        // keep retrying quietly during rollout
      }
    }, 2000)

    return () => {
      window.clearInterval(interval)
      reconnectingRef.current = false
    }
  }, [isError, queryClient, refetch])

  useEffect(() => {
    if (!startUpdate.isError) return
    clearObserved()
    toast.error(startUpdate.error.message, {
      id: UPDATE_TOAST_ID,
      duration: 8000,
    })
  }, [startUpdate.error, startUpdate.isError])

  return null
}
