import { createContext, useContext, useState, useEffect, useLayoutEffect, type ReactNode } from 'react'
import type { Workspace } from '@/hooks/use-workspaces'
import { apiClient } from '@/lib/api-client'
import { hexToOklch } from '@/lib/color'

interface WorkspaceContextValue {
  activeWorkspace: Workspace | null
  setActiveWorkspace: (workspace: Workspace | null) => void
  activeWorkspaceId: string | undefined
}

const WorkspaceContext = createContext<WorkspaceContextValue>({
  activeWorkspace: null,
  setActiveWorkspace: () => {},
  activeWorkspaceId: undefined,
})

const STORAGE_KEY = 'clawbuddy-active-workspace'

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [activeWorkspace, setActiveWorkspaceState] = useState<Workspace | null>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const ws: Workspace = JSON.parse(stored)
        // Apply brand color synchronously to avoid flash of default color
        if (ws.color) {
          document.documentElement.style.setProperty('--brand', hexToOklch(ws.color))
        }
        return ws
      }
      return null
    } catch {
      return null
    }
  })

  const setActiveWorkspace = (workspace: Workspace | null) => {
    setActiveWorkspaceState(workspace)
    if (workspace) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace))
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  }

  // Auto-select first workspace if none is active
  useEffect(() => {
    if (activeWorkspace) return

    let stale = false
    apiClient.get<Workspace[]>('/workspaces').then((workspaces) => {
      if (!stale && workspaces && workspaces.length > 0) {
        setActiveWorkspace(workspaces[0])
      }
    }).catch((err) => {
      console.warn('[WorkspaceProvider] Failed to auto-select workspace:', err)
    })
    return () => { stale = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync workspace data when it changes externally
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        try {
          setActiveWorkspaceState(e.newValue ? JSON.parse(e.newValue) : null)
        } catch {
          setActiveWorkspaceState(null)
        }
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  // Sync app accent color with active workspace color (before paint)
  useLayoutEffect(() => {
    const root = document.documentElement
    if (activeWorkspace?.color) {
      root.style.setProperty('--brand', hexToOklch(activeWorkspace.color))
    } else {
      root.style.removeProperty('--brand')
    }
  }, [activeWorkspace?.color])

  return (
    <WorkspaceContext.Provider
      value={{
        activeWorkspace,
        setActiveWorkspace,
        activeWorkspaceId: activeWorkspace?.id,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useActiveWorkspace() {
  return useContext(WorkspaceContext)
}
