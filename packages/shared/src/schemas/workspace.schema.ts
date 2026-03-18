import { z } from 'zod'

export const createWorkspaceSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100),
  description: z.string().max(500).optional(),
  color: z.string().max(20).optional(),
  settings: z.record(z.unknown()).optional(),
})

export const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  color: z.string().max(20).optional(),
  permissions: z.object({ allow: z.array(z.string()) }).nullable().optional(),
  settings: z.record(z.unknown()).nullable().optional(),
  autoExecute: z.boolean().optional(),
})

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>
