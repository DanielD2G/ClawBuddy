import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { POLL_DOCUMENT_STATUS_MS } from '@/constants'

export interface Document {
  id: string
  title: string
  workspaceId: string
  folderId: string | null
  status: string
  type: string
  content: string | null
  fileUrl: string | null
  chunkCount: number
  processingStep: string | null
  processingPct: number | null
  createdAt: string
  updatedAt: string
}

export function useDocuments(workspaceId: string, folderId?: string | null) {
  const param = folderId === undefined ? '' : `?folderId=${folderId ?? 'null'}`
  return useQuery({
    queryKey: ['documents', workspaceId, folderId ?? 'root'],
    queryFn: () =>
      apiClient.get<Document[]>(`/workspaces/${workspaceId}/documents${param}`),
    enabled: !!workspaceId,
    refetchInterval: (query) => {
      const docs = query.state.data
      // Poll every 2s if any documents are still processing
      if (docs?.some((d) => d.status === 'PENDING' || d.status === 'PROCESSING')) return POLL_DOCUMENT_STATUS_MS
      return false
    },
  })
}

export function useDocument(workspaceId: string, docId: string) {
  return useQuery({
    queryKey: ['documents', workspaceId, docId],
    queryFn: () =>
      apiClient.get<Document>(`/workspaces/${workspaceId}/documents/${docId}`),
    enabled: !!workspaceId && !!docId,
  })
}

export function useUploadDocument(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ formData, folderId }: { formData: FormData; folderId?: string | null }) => {
      if (folderId) {
        formData.append('folderId', folderId)
      }
      const res = await fetch(`/api/workspaces/${workspaceId}/documents`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      if (!res.ok) throw new Error('Upload failed')
      return res.json()
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['documents', workspaceId] }),
  })
}

export function useMoveDocument(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ docId, folderId }: { docId: string; folderId: string | null }) =>
      apiClient.patch(`/workspaces/${workspaceId}/documents/${docId}`, { folderId }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['documents', workspaceId] }),
  })
}

export function useReingestDocument(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (docId: string) =>
      apiClient.post(`/workspaces/${workspaceId}/documents/${docId}/reingest`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['documents', workspaceId] }),
  })
}

export function useDeleteDocument(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (docId: string) =>
      apiClient.delete(`/workspaces/${workspaceId}/documents/${docId}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['documents', workspaceId] }),
  })
}
