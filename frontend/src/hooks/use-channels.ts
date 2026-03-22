import { useQuery, useMutation } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { createMutation } from './create-mutation'

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
      apiClient.get<Channel[]>(workspaceId ? `/channels?workspaceId=${workspaceId}` : '/channels'),
  })
}

export const useCreateChannel = createMutation<
  Channel,
  { workspaceId: string; type: string; name: string; config: { botToken: string } }
>('post', '/channels', [['channels']])

export const useUpdateChannel = createMutation<
  Channel,
  { id: string; name?: string; config?: { botToken?: string } }
>('patch', ({ id }) => `/channels/${id}`, [['channels']])

export const useDeleteChannel = createMutation<unknown, string>(
  'delete',
  (id) => `/channels/${id}`,
  [['channels']],
)

export const useToggleChannel = createMutation<unknown, { id: string; enabled: boolean }>(
  'post',
  ({ id, enabled }) => `/channels/${id}/${enabled ? 'enable' : 'disable'}`,
  [['channels']],
)

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
