import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { POLL_DOCUMENT_STATUS_MS } from '@/constants'
import type { Document as SharedDocument, DocumentStatus, DocumentType } from '@clawbuddy/shared'
import { createMutation } from './create-mutation'

/** Serialized Document as returned by the API (dates as ISO strings, enums as their string values) */
export type Document = Omit<SharedDocument, 'createdAt' | 'updatedAt' | 'status' | 'type'> & {
  status: `${DocumentStatus}`
  type: `${DocumentType}`
  createdAt: string
  updatedAt: string
}

export function useDocuments(workspaceId: string, folderId?: string | null) {
  const param = folderId === undefined ? '' : `?folderId=${folderId ?? 'null'}`
  return useQuery({
    queryKey: ['documents', workspaceId, folderId ?? 'root'],
    queryFn: () => apiClient.get<Document[]>(`/workspaces/${workspaceId}/documents${param}`),
    enabled: !!workspaceId,
    refetchInterval: (query) => {
      const docs = query.state.data
      // Poll every 2s if any documents are still processing
      if (docs?.some((d) => d.status === 'PENDING' || d.status === 'PROCESSING'))
        return POLL_DOCUMENT_STATUS_MS
      return false
    },
  })
}

export function useDocument(workspaceId: string, docId: string) {
  return useQuery({
    queryKey: ['documents', workspaceId, docId],
    queryFn: () => apiClient.get<Document>(`/workspaces/${workspaceId}/documents/${docId}`),
    enabled: !!workspaceId && !!docId,
  })
}

// Upload uses raw fetch with FormData — cannot use the standard factory
export function useUploadDocument(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      formData,
      folderId,
    }: {
      formData: FormData
      folderId?: string | null
    }) => {
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['documents', workspaceId] }),
  })
}

export function useMoveDocument(workspaceId: string) {
  return createMutation<unknown, { docId: string; folderId: string | null }>(
    'patch',
    ({ docId }) => `/workspaces/${workspaceId}/documents/${docId}`,
    [['documents', workspaceId]],
  )()
}

export function useReingestDocument(workspaceId: string) {
  return createMutation<unknown, string>(
    'post',
    (docId) => `/workspaces/${workspaceId}/documents/${docId}/reingest`,
    [['documents', workspaceId]],
  )()
}

export function useDeleteDocument(workspaceId: string) {
  return createMutation<unknown, string>(
    'delete',
    (docId) => `/workspaces/${workspaceId}/documents/${docId}`,
    [['documents', workspaceId]],
  )()
}
