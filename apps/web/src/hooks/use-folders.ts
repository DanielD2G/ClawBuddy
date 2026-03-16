import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'

export interface Folder {
  id: string
  name: string
  workspaceId: string
  parentId: string | null
  createdAt: string
  updatedAt: string
}

export interface FolderWithAncestors {
  folder: Folder
  ancestors: Folder[]
}

export function useFolders(workspaceId: string, parentId?: string | null) {
  const param = parentId ?? 'null'
  return useQuery({
    queryKey: ['folders', workspaceId, param],
    queryFn: () =>
      apiClient.get<Folder[]>(`/workspaces/${workspaceId}/folders?parentId=${param}`),
    enabled: !!workspaceId,
  })
}

export function useFolderBreadcrumb(workspaceId: string, folderId: string | null) {
  return useQuery({
    queryKey: ['folder-breadcrumb', workspaceId, folderId],
    queryFn: () =>
      apiClient.get<FolderWithAncestors>(`/workspaces/${workspaceId}/folders/${folderId}`),
    enabled: !!workspaceId && !!folderId,
  })
}

export function useCreateFolder(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; parentId?: string | null }) =>
      apiClient.post<Folder>(`/workspaces/${workspaceId}/folders`, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['folders', workspaceId] }),
  })
}

export function useDeleteFolder(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (folderId: string) =>
      apiClient.delete(`/workspaces/${workspaceId}/folders/${folderId}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['folders', workspaceId] }),
  })
}
