import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { BUILTIN_CAPABILITIES } from '../capabilities/builtin/index.js'
import type { ToolDefinition, ConfigFieldDefinition } from '../capabilities/types.js'
import type { LLMToolDefinition } from '../providers/llm.interface.js'
import {
  validateCapabilityConfig,
  encryptConfigFields,
  decryptConfigFields,
  maskConfigFields,
  mergeWithExistingConfig,
} from './config-validation.service.js'

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
  async getDecryptedCapabilityConfigsForWorkspace(workspaceId: string): Promise<Map<string, Record<string, string>>> {
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

    return allCapabilities.map((cap) => {
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
        processedConfig = mergeWithExistingConfig(schema, config, existing.config as Record<string, unknown>)
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
   * Update config for a workspace capability.
   */
  async updateCapabilityConfig(workspaceId: string, capabilityId: string, config: Record<string, unknown>) {
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
        processedConfig = mergeWithExistingConfig(schema, config, existing.config as Record<string, unknown>)
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
  buildSystemPrompt(capabilities: Array<{ systemPrompt: string; name: string }>, timezone?: string): string {
    const now = new Date()
    const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const locationParts = tz.split('/')
    const location = locationParts.length >= 2
      ? locationParts.slice(1).join(', ').replace(/_/g, ' ')
      : tz
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz })
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: tz })

    const base = `You are a helpful AI assistant with access to tools.

## Current Date & Time
Today is ${dateStr}. Current time: ${timeStr} (${tz}). User's approximate location: ${location}. Use this for any date-relative queries and to adapt responses to the user's locale (language, currency, local context).

## How to respond

1. **Document search (search_documents):** Call this tool when the user asks about uploaded documents, references a document by name or title, or asks questions that might be answered by the workspace's indexed content. The document list below shows what's searchable. Do NOT use this for sandbox files, greetings, general conversation, or when the user is clearly asking you to use another tool.
2. **Other tools (code execution, file ops, etc.):** Before calling any non-search tool, briefly tell the user what you are about to do and why (e.g. "I'll run a Python script to calculate that..."). Then call the tool.
3. **Direct answers:** For greetings, casual conversation, or questions you can answer from general knowledge, answer directly without calling any tools.

## Tool chaining

You can combine multiple tools in a single task. All tools run in the same sandbox environment, so you can:
- Use one tool's output as input for another (e.g., run an AWS command, then use Bash to format or filter the result with jq, grep, awk, etc.)
- Run a command with one tool, then process or analyze the result with Python or Bash
- Chain as many tools as needed to complete the task — each call builds on previous results

When a task benefits from post-processing (formatting, filtering, aggregating), prefer chaining tools over returning raw output.

## Parallel tool calls

When you need to perform multiple INDEPENDENT operations (e.g., several web searches, multiple document lookups), request ALL of them in a single response by including multiple tool calls at once. This runs them in parallel and is much faster than calling them one at a time. Only call tools sequentially when one depends on another's output.

Large tool outputs are automatically saved to files at /workspace/.outputs/.
When you see a truncated output with a file path, use Bash to read or process the file (e.g., cat, jq, grep, awk) instead of asking the user to re-run the command.

### Reading files safely
Before reading a file with \`cat\`, always check its size first with \`ls -lh <file>\` or \`wc -c <file>\`.
- **Small files (<5KB):** safe to \`cat\` directly.
- **Medium files (5KB–50KB):** use \`head\`, \`tail\`, \`grep\`, \`jq\`, or \`awk\` to extract only what you need.
- **Large files (>50KB):** NEVER cat the entire file. Use \`head -n 20\`, \`grep -c\` for counts, \`jq '.[] | .Key'\` for JSON, or \`wc -l\` for line counts. Process in chunks or filter first.

### Data size rules (CRITICAL)
- **Commands that embed more than 5KB of inline data WILL BE REJECTED and not executed.**
- NEVER echo, hardcode, or re-paste large tool outputs into subsequent commands.
- When a previous tool output is saved to /workspace/.outputs/, reference that file path directly.
- For \`generate_file\`: use the \`sourcePath\` parameter to reference a sandbox file instead of passing large content directly.
- For \`run_bash\`/\`run_python\`: write a script that reads from the file, do NOT embed data in the script.
- Example: use \`cat /workspace/.outputs/abc.txt | jq '.[] | .Key'\` instead of embedding data in a command.

## Error handling

If a tool call returns an error:
1. Report the error clearly to the user in natural language.
2. Do NOT retry with workarounds — no sudo, no chmod, no alternative paths, no rewriting the same command.
3. Explain what failed and suggest what the user can do.
4. If you get "Permission denied", tell the user which path was not writable.`

    if (!capabilities.length) return base

    const capabilityPrompts = capabilities
      .map((c) => `## ${c.name}\n${c.systemPrompt}`)
      .join('\n\n')

    return `${base}\n\n# Available Capabilities\n\n${capabilityPrompts}`
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
