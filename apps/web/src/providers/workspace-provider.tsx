import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
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

const STORAGE_KEY = 'agentbuddy-active-workspace'

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [activeWorkspace, setActiveWorkspaceState] = useState<Workspace | null>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return stored ? JSON.parse(stored) : null
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

    apiClient.get<Workspace[]>('/workspaces').then((workspaces) => {
      if (workspaces && workspaces.length > 0 && !activeWorkspace) {
        setActiveWorkspace(workspaces[0])
      }
    }).catch(() => {
      // Ignore — setup may not be complete yet
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync workspace data when it changes externally
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setActiveWorkspaceState(e.newValue ? JSON.parse(e.newValue) : null)
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  // Sync app accent color with active workspace color
  useEffect(() => {
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
