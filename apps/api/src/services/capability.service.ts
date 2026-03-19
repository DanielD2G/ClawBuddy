import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { BUILTIN_CAPABILITIES } from '../capabilities/builtin/index.js'
import { ALWAYS_ON_CAPABILITY_SLUGS } from '../constants.js'
import type { ToolDefinition, ConfigFieldDefinition } from '../capabilities/types.js'
import type { LLMToolDefinition } from '../providers/llm.interface.js'
import {
  validateCapabilityConfig,
  encryptConfigFields,
  decryptConfigFields,
  maskConfigFields,
  mergeWithExistingConfig,
} from './config-validation.service.js'
import { buildSystemPrompt as buildSystemPromptText } from './system-prompt-builder.js'

/** Capability slugs that are always enabled and hidden from the management UI */
const HIDDEN_CAPABILITY_SLUGS = ['sub-agent-delegation']

export const capabilityService = {
  /**
   * Upsert all built-in capability definitions into the database.
   * Called on server startup.
   */
  /**
   * Capabilities that require an external API key (not per-capability config).
   * Maps slug → provider name for settingsService.getApiKey().
   */
  REQUIRES_API_KEY: {
    'web-search': 'gemini',
  } as Record<string, string>,

  async syncBuiltinCapabilities() {
    // Clean up removed builtin capabilities
    const removedSlugs = ['file-ops']
    for (const slug of removedSlugs) {
      const existing = await prisma.capability.findUnique({ where: { slug } })
      if (existing?.builtin) {
        await prisma.workspaceCapability.deleteMany({ where: { capabilityId: existing.id } })
        await prisma.capability.delete({ where: { slug } })
      }
    }

    for (const cap of BUILTIN_CAPABILITIES) {
      await prisma.capability.upsert({
        where: { slug: cap.slug },
        create: {
          slug: cap.slug,
          name: cap.name,
          description: cap.description,
          icon: cap.icon,
          category: cap.category,
          version: cap.version,
          toolDefinitions: JSON.parse(JSON.stringify(cap.tools)) as Prisma.InputJsonValue,
          systemPrompt: cap.systemPrompt,
          dockerImage: cap.sandbox.dockerImage,
          packages: cap.sandbox.packages ?? [],
          networkAccess: cap.sandbox.networkAccess ?? false,
          configSchema: cap.configSchema
            ? (JSON.parse(JSON.stringify(cap.configSchema)) as Prisma.InputJsonValue)
            : undefined,
          installationScript: cap.installationScript ?? null,
          authType: cap.authType ?? null,
          skillType: cap.skillType ?? null,
          builtin: true,
        },
        update: {
          name: cap.name,
          description: cap.description,
          icon: cap.icon,
          category: cap.category,
          version: cap.version,
          toolDefinitions: JSON.parse(JSON.stringify(cap.tools)) as Prisma.InputJsonValue,
          systemPrompt: cap.systemPrompt,
          dockerImage: cap.sandbox.dockerImage,
          packages: cap.sandbox.packages ?? [],
          networkAccess: cap.sandbox.networkAccess ?? false,
          configSchema: cap.configSchema
            ? (JSON.parse(JSON.stringify(cap.configSchema)) as Prisma.InputJsonValue)
            : Prisma.DbNull,
          installationScript: cap.installationScript ?? null,
          authType: cap.authType ?? null,
          skillType: cap.skillType ?? null,
        },
      })
    }

    // Auto-enable always-on capabilities for all existing workspaces
    await this.ensureAlwaysOnCapabilities()
  },

  /**
   * Ensure all always-on capabilities are enabled for every workspace.
   * Creates missing WorkspaceCapability records so new core tools
   * are active immediately without manual activation.
   */
  async ensureAlwaysOnCapabilities() {
    const workspaces = await prisma.workspace.findMany({ select: { id: true } })
    if (!workspaces.length) return

    const alwaysOnCaps = await prisma.capability.findMany({
      where: { slug: { in: ALWAYS_ON_CAPABILITY_SLUGS } },
      select: { id: true },
    })
    if (!alwaysOnCaps.length) return

    await prisma.workspaceCapability.createMany({
      data: workspaces.flatMap((ws) =>
        alwaysOnCaps.map((cap) => ({
          workspaceId: ws.id,
          capabilityId: cap.id,
          enabled: true,
        })),
      ),
      skipDuplicates: true,
    })
  },

  /**
   * List all available capabilities (for admin / catalog).
   */
  async listAll() {
    return prisma.capability.findMany({ orderBy: { category: 'asc' } })
  },

  /**
   * Get capabilities enabled for a workspace via WorkspaceCapability records.
   */
  async getEnabledCapabilitiesForWorkspace(workspaceId: string) {
    const workspaceCapabilities = await prisma.workspaceCapability.findMany({
      where: { workspaceId, enabled: true },
      include: { capability: true },
    })

    return workspaceCapabilities.map((wc) => ({
      ...wc.capability,
      config: wc.config,
    }))
  },

  /**
   * Get decrypted env vars for workspace-scoped capabilities.
   * Merges global config with workspace overrides.
   */
  async getDecryptedCapabilityConfigsForWorkspace(
    workspaceId: string,
  ): Promise<Map<string, Record<string, string>>> {
    const capabilities = await this.getEnabledCapabilitiesForWorkspace(workspaceId)
    const result = new Map<string, Record<string, string>>()

    for (const cap of capabilities) {
      const schema = cap.configSchema as ConfigFieldDefinition[] | null
      const config = cap.config as Record<string, unknown> | null
      if (!schema?.length || !config) continue

      const decrypted = decryptConfigFields(schema, config)
      const envVars: Record<string, string> = {}

      for (const field of schema) {
        const value = decrypted[field.key]
        if (value !== undefined && value !== null && value !== '') {
          envVars[field.envVar] = String(value)
        }
      }

      if (Object.keys(envVars).length) {
        result.set(cap.slug, envVars)
      }
    }

    return result
  },

  /**
   * Get all workspace capabilities (enabled and disabled) for management.
   */
  async getWorkspaceCapabilitySettings(workspaceId: string) {
    const [allCapabilities, workspaceCapabilities] = await Promise.all([
      prisma.capability.findMany({ orderBy: { category: 'asc' } }),
      prisma.workspaceCapability.findMany({ where: { workspaceId } }),
    ])

    const wcMap = new Map(workspaceCapabilities.map((wc) => [wc.capabilityId, wc]))

    return allCapabilities
      .filter((cap) => !HIDDEN_CAPABILITY_SLUGS.includes(cap.slug))
      .map((cap) => {
        const wc = wcMap.get(cap.id)
        const schema = cap.configSchema as ConfigFieldDefinition[] | null
        const rawConfig = (wc?.config ?? null) as Record<string, unknown> | null
        const maskedConfig = schema && rawConfig ? maskConfigFields(schema, rawConfig) : rawConfig
        return {
          ...cap,
          enabled: wc?.enabled ?? false,
          config: maskedConfig,
          workspaceCapabilityId: wc?.id ?? null,
        }
      })
  },

  /**
   * Enable a capability for a workspace.
   */
  async enableCapability(workspaceId: string, slug: string, config?: Record<string, unknown>) {
    const capability = await prisma.capability.findUniqueOrThrow({ where: { slug } })
    const schema = capability.configSchema as ConfigFieldDefinition[] | null

    let processedConfig = config

    if (schema?.length && config) {
      // Validate
      const validation = validateCapabilityConfig(schema, config)
      if (!validation.valid) {
        throw new Error(`Config validation failed: ${validation.errors.join(', ')}`)
      }

      // If re-enabling, preserve existing encrypted password values when masked
      const existing = await prisma.workspaceCapability.findUnique({
        where: { workspaceId_capabilityId: { workspaceId, capabilityId: capability.id } },
      })
      if (existing?.config) {
        processedConfig = mergeWithExistingConfig(
          schema,
          config,
          existing.config as Record<string, unknown>,
        )
      }

      // Encrypt password fields
      processedConfig = encryptConfigFields(schema, processedConfig!)
    } else if (schema?.some((f) => f.required) && !config) {
      throw new Error('Configuration is required for this capability')
    }

    return prisma.workspaceCapability.upsert({
      where: {
        workspaceId_capabilityId: { workspaceId, capabilityId: capability.id },
      },
      create: {
        workspaceId,
        capabilityId: capability.id,
        enabled: true,
        config: (processedConfig ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      update: {
        enabled: true,
        config: (processedConfig ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      include: { capability: true },
    })
  },

  /**
   * Disable a capability for a workspace.
   */
  async disableCapability(workspaceId: string, capabilityId: string) {
    return prisma.workspaceCapability.update({
      where: {
        workspaceId_capabilityId: { workspaceId, capabilityId },
      },
      data: { enabled: false },
    })
  },

  /**
   * Disable a capability by its slug (resolves to capabilityId internally).
   */
  async disableCapabilityBySlug(workspaceId: string, slug: string) {
    const capability = await prisma.capability.findUnique({ where: { slug } })
    if (!capability) return
    return this.disableCapability(workspaceId, capability.id)
  },

  /**
   * Remove a workspace capability override entirely.
   */
  async removeCapabilityOverride(workspaceId: string, capabilityId: string) {
    return prisma.workspaceCapability.delete({
      where: { workspaceId_capabilityId: { workspaceId, capabilityId } },
    })
  },

  /**
   * Update config for a workspace capability.
   */
  async updateCapabilityConfig(
    workspaceId: string,
    capabilityId: string,
    config: Record<string, unknown>,
  ) {
    const capability = await prisma.capability.findUniqueOrThrow({ where: { id: capabilityId } })
    const schema = capability.configSchema as ConfigFieldDefinition[] | null

    let processedConfig = config

    if (schema?.length) {
      const validation = validateCapabilityConfig(schema, config)
      if (!validation.valid) {
        throw new Error(`Config validation failed: ${validation.errors.join(', ')}`)
      }

      // Preserve existing encrypted values for masked password fields
      const existing = await prisma.workspaceCapability.findUnique({
        where: { workspaceId_capabilityId: { workspaceId, capabilityId } },
      })
      if (existing?.config) {
        processedConfig = mergeWithExistingConfig(
          schema,
          config,
          existing.config as Record<string, unknown>,
        )
      }

      processedConfig = encryptConfigFields(schema, processedConfig)
    }

    const result = await prisma.workspaceCapability.update({
      where: {
        workspaceId_capabilityId: { workspaceId, capabilityId },
      },
      data: { config: processedConfig as Prisma.InputJsonValue },
    })

    // Destroy active sandboxes so new ones pick up fresh env vars
    const activeSandboxes = await prisma.sandboxSession.findMany({
      where: { workspaceId, status: 'running' },
    })
    if (activeSandboxes.length) {
      const { sandboxService } = await import('./sandbox.service.js')
      for (const s of activeSandboxes) {
        await sandboxService.destroySandbox(s.id).catch(() => {})
      }
    }

    return result
  },

  /**
   * Build LLM tool definitions from enabled capabilities.
   */
  buildToolDefinitions(
    capabilities: Array<{ toolDefinitions: unknown; slug: string }>,
  ): LLMToolDefinition[] {
    const tools: LLMToolDefinition[] = []
    for (const cap of capabilities) {
      const defs = cap.toolDefinitions as ToolDefinition[]
      for (const tool of defs) {
        tools.push({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })
      }
    }
    return tools
  },

  /**
   * Build combined system prompt from enabled capabilities.
   */
  buildSystemPrompt(
    capabilities: Array<{ systemPrompt: string; name: string }>,
    timezone?: string,
  ): string {
    return buildSystemPromptText(capabilities, timezone)
  },

  /**
   * Map a tool name back to its capability slug.
   */
  resolveToolCapability(
    toolName: string,
    capabilities: Array<{ slug: string; toolDefinitions: unknown }>,
  ): string | null {
    for (const cap of capabilities) {
      const defs = cap.toolDefinitions as ToolDefinition[]
      if (defs.some((t) => t.name === toolName)) {
        return cap.slug
      }
    }
    return null
  },
}
