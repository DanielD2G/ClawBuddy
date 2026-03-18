import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'

export interface Channel {
  id: string
  workspaceId: string
  type: string
  name: string
  enabled: boolean
  config: {
    botToken: string
    botUsername?: string
  }
  running: boolean
  createdAt: string
  updatedAt: string
}

export function useChannels(workspaceId?: string) {
  return useQuery({
    queryKey: ['channels', workspaceId],
    queryFn: () =>
      apiClient.get<Channel[]>(
        workspaceId ? `/channels?workspaceId=${workspaceId}` : '/channels'
      ),
  })
}

export function useCreateChannel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { workspaceId: string; type: string; name: string; config: { botToken: string } }) =>
      apiClient.post<Channel>('/channels', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['channels'] }),
  })
}

export function useUpdateChannel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; config?: { botToken?: string } }) =>
      apiClient.patch<Channel>(`/channels/${id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['channels'] }),
  })
}

export function useDeleteChannel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/channels/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['channels'] }),
  })
}

export function useToggleChannel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiClient.post(`/channels/${id}/${enabled ? 'enable' : 'disable'}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['channels'] }),
  })
}

export function useTestChannel() {
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ username: string; firstName: string }>(`/channels/${id}/test`),
  })
}

export function useTestBotToken() {
  return useMutation({
    mutationFn: (botToken: string) =>
      apiClient.post<{ username: string; firstName: string }>('/channels/test-token', { botToken }),
  })
}
