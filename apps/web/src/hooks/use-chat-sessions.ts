import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { POLL_SESSIONS_FAST_MS, POLL_SESSIONS_NORMAL_MS } from '@/constants'

export interface ChatSession {
  id: string
  workspaceId: string
  title: string | null
  agentStatus: string
  unreadCount: number
  activeSandbox: boolean
  lastInputTokens: number | null
  createdAt: string
  updatedAt: string
}

export function useChatSessions() {
  return useQuery({
    queryKey: ['chat-sessions'],
    queryFn: () => apiClient.get<ChatSession[]>('/chat/sessions'),
    refetchInterval: (query) => {
      const sessions = query.state.data
      // Poll every 3s if any session has no title yet, otherwise every 10s to pick up cron messages
      if (sessions?.some((s) => !s.title)) return POLL_SESSIONS_FAST_MS
      return POLL_SESSIONS_NORMAL_MS
    },
  })
}

export function useDeleteChatSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiClient.delete(`/chat/sessions/${sessionId}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['chat-sessions'] }),
  })
}
