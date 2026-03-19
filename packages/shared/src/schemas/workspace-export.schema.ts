import { z } from 'zod'

export const workspaceExportCapabilitySchema = z.object({
  slug: z.string(),
  enabled: z.boolean(),
  config: z.record(z.unknown()).nullable(),
})

export const workspaceExportChannelSchema = z.object({
  type: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  config: z.record(z.unknown()),
})

export const workspaceExportModelConfigSchema = z.object({
  aiProvider: z.string(),
  aiModel: z.string().nullable(),
  mediumModel: z.string().nullable().optional(),
  lightModel: z.string().nullable().optional(),
  exploreModel: z.string().nullable().optional(),
  executeModel: z.string().nullable().optional(),
  titleModel: z.string().nullable().optional(),
  compactModel: z.string().nullable().optional(),
  advancedModelConfig: z.boolean().optional(),
  embeddingProvider: z.string(),
  embeddingModel: z.string().nullable(),
  contextLimitTokens: z.number().optional(),
  maxAgentIterations: z.number().optional(),
  subAgentExploreMaxIterations: z.number().optional(),
  subAgentAnalyzeMaxIterations: z.number().optional(),
  subAgentExecuteMaxIterations: z.number().optional(),
  timezone: z.string().nullable().optional(),
})

export const workspaceExportSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  workspace: z.object({
    name: z.string(),
    description: z.string().nullable(),
    color: z.string().nullable(),
    autoExecute: z.boolean(),
    settings: z.record(z.unknown()).nullable(),
    permissions: z.object({ allow: z.array(z.string()) }).nullable(),
  }),
  capabilities: z.array(workspaceExportCapabilitySchema),
  channels: z.array(workspaceExportChannelSchema),
  modelConfig: workspaceExportModelConfigSchema,
  tokenUsage: z.unknown().optional(),
})

export type WorkspaceExport = z.infer<typeof workspaceExportSchema>
