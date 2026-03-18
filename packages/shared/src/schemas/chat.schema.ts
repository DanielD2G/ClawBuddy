import { z } from 'zod'

export const sendChatMessageSchema = z.object({
  content: z.string().min(1, 'content is required'),
  sessionId: z.string().optional(),
  workspaceId: z.string().optional(),
  documentIds: z.array(z.string()).optional(),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        size: z.number(),
        type: z.string(),
        storageKey: z.string(),
        url: z.string(),
      }),
    )
    .optional(),
})

export type SendChatMessageInput = z.infer<typeof sendChatMessageSchema>

export const createChatSessionSchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  title: z.string().optional(),
})

export type CreateChatSessionInput = z.infer<typeof createChatSessionSchema>
