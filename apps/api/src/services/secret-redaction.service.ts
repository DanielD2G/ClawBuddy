import { prisma } from '../lib/prisma.js'
import { isSecretRedactionEnabled } from '@clawbuddy/shared'
import { env } from '../env.js'
import { decrypt } from './crypto.service.js'
import type { ConfigFieldDefinition } from '../capabilities/types.js'
import { decryptConfigFields } from './config-validation.service.js'
import type { SSEEmit } from '../lib/sse.js'

export const SECRET_REDACTION_MASK = '********'

const GLOBAL_SECRET_ENV_SOURCES = [
  { alias: 'OPENAI_API_KEY', value: env.OPENAI_API_KEY },
  { alias: 'GEMINI_API_KEY', value: env.GEMINI_API_KEY },
  { alias: 'ANTHROPIC_API_KEY', value: env.ANTHROPIC_API_KEY },
  { alias: 'GOOGLE_CLIENT_SECRET', value: env.GOOGLE_CLIENT_SECRET },
  { alias: 'BROWSER_GRID_API_KEY', value: env.BROWSER_GRID_API_KEY },
  { alias: 'DATABASE_URL', value: env.DATABASE_URL },
  { alias: 'REDIS_URL', value: env.REDIS_URL },
  { alias: 'MINIO_ACCESS_KEY', value: env.MINIO_ACCESS_KEY },
  { alias: 'MINIO_SECRET_KEY', value: env.MINIO_SECRET_KEY },
  { alias: 'ENCRYPTION_SECRET', value: env.ENCRYPTION_SECRET },
] as const

const DB_SECRET_FIELDS = [
  'openaiApiKey',
  'geminiApiKey',
  'anthropicApiKey',
  'browserGridApiKey',
] as const

type JsonLike = Record<string, unknown> | unknown[] | string | number | boolean | null | undefined

export interface SecretReference {
  alias: string
  capabilitySlug?: string
  transport: 'env' | 'file' | 'internal'
}

export interface SecretInventory {
  workspaceId?: string
  enabled: boolean
  secretValues: string[]
  /** Compiled regex matching all secretValues in a single pass. */
  secretPattern: RegExp | null
  aliases: string[]
  references: SecretReference[]
}

interface RedactOptions {
  skipKeys?: string[]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildSecretPattern(secrets: string[]): RegExp | null {
  const escaped = secrets.filter(Boolean).map(escapeRegExp)
  if (!escaped.length) return null
  return new RegExp(escaped.join('|'), 'g')
}

function collectStringLeaves(value: unknown, output: Set<string>) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) output.add(trimmed)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, output)
    return
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) collectStringLeaves(nested, output)
  }
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function extractStructuredSecretValues(value: string): string[] {
  const candidates = new Set<string>()
  const trimmed = value.trim()

  if (!trimmed) return []

  candidates.add(trimmed)

  try {
    const parsed = JSON.parse(trimmed) as unknown
    collectStringLeaves(parsed, candidates)
  } catch {
    // Not JSON, continue with line-based parsing below.
  }

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('[')) continue

    const normalized = line.startsWith('export ') ? line.slice('export '.length) : line
    const separatorIndex = normalized.indexOf('=')
    if (separatorIndex === -1) continue

    const rhs = stripWrappingQuotes(normalized.slice(separatorIndex + 1))
    if (rhs) candidates.add(rhs)
  }

  return [...candidates]
}

function collectWorkspaceSecretValues(
  schema: ConfigFieldDefinition[] | null,
  config: Record<string, unknown> | null,
  secretValues: Set<string>,
  references: SecretReference[],
  aliases: Set<string>,
  capabilitySlug: string,
) {
  if (!schema?.length || !config) return

  const decrypted = decryptConfigFields(schema, config)

  for (const field of schema) {
    if (field.envVar) {
      aliases.add(field.envVar)
    }
    const transport: SecretReference['transport'] = field.envVar?.startsWith('_') ? 'file' : 'env'

    if (field.type !== 'password' && field.type !== 'textarea') continue

    references.push({
      alias: field.envVar,
      capabilitySlug,
      transport,
    })

    const rawValue = decrypted[field.key]
    if (typeof rawValue !== 'string' || !rawValue.trim()) continue

    for (const secret of extractStructuredSecretValues(rawValue)) {
      secretValues.add(secret)
    }
  }
}

export const secretRedactionService = {
  async buildSecretInventory(workspaceId?: string | null): Promise<SecretInventory> {
    if (workspaceId) {
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { settings: true },
      })

      if (!isSecretRedactionEnabled(workspace?.settings)) {
        return {
          workspaceId,
          enabled: false,
          secretValues: [],
          secretPattern: null,
          aliases: [],
          references: [],
        }
      }
    }

    const secretValues = new Set<string>()
    const aliases = new Set<string>()
    const references: SecretReference[] = []

    for (const source of GLOBAL_SECRET_ENV_SOURCES) {
      aliases.add(source.alias)
      if (source.value?.trim()) {
        for (const secret of extractStructuredSecretValues(source.value)) {
          secretValues.add(secret)
        }
      }
    }

    const settings = await prisma.appSettings.findUnique({ where: { id: 'singleton' } })
    if (settings) {
      for (const field of DB_SECRET_FIELDS) {
        const encrypted = settings[field]
        if (!encrypted) continue
        try {
          for (const secret of extractStructuredSecretValues(decrypt(encrypted))) {
            secretValues.add(secret)
          }
        } catch {
          // Ignore invalid historical ciphertext and keep going.
        }
      }
    }

    if (workspaceId) {
      const workspaceCapabilities = await prisma.workspaceCapability.findMany({
        where: { workspaceId, enabled: true },
        include: { capability: true },
      })

      for (const wc of workspaceCapabilities) {
        collectWorkspaceSecretValues(
          wc.capability.configSchema as ConfigFieldDefinition[] | null,
          wc.config as Record<string, unknown> | null,
          secretValues,
          references,
          aliases,
          wc.capability.slug,
        )
      }
    }

    const uniqueSecrets = [...new Set([...secretValues].filter(Boolean))].sort(
      (a, b) => b.length - a.length,
    )

    return {
      workspaceId: workspaceId ?? undefined,
      enabled: true,
      secretValues: uniqueSecrets,
      secretPattern: buildSecretPattern(uniqueSecrets),
      aliases: [...new Set([...aliases].filter(Boolean))].sort(),
      references,
    }
  },

  redactText(text: string, inventory: SecretInventory): string {
    if (inventory.enabled === false) return text
    if (!text || !inventory.secretPattern) return text
    return text.replace(inventory.secretPattern, SECRET_REDACTION_MASK)
  },

  redactObject<T extends JsonLike>(
    value: T,
    inventory: SecretInventory,
    options?: RedactOptions,
  ): T {
    if (inventory.enabled === false) return value
    const skipKeys = new Set(options?.skipKeys ?? [])

    const redactValue = (input: JsonLike): JsonLike => {
      if (typeof input === 'string') {
        return this.redactText(input, inventory)
      }

      if (Array.isArray(input)) {
        return input.map((item) => redactValue(item as JsonLike))
      }

      if (input instanceof Date) {
        return input
      }

      if (!input || typeof input !== 'object') {
        return input
      }

      const out: Record<string, unknown> = {}
      for (const [key, nested] of Object.entries(input)) {
        out[key] = skipKeys.has(key) ? nested : redactValue(nested as JsonLike)
      }
      return out
    }

    return redactValue(value) as T
  },

  redactSerializedText(text: string, inventory: SecretInventory, options?: RedactOptions): string {
    if (inventory.enabled === false) return text
    if (!text) return text

    try {
      const parsed = JSON.parse(text) as JsonLike
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(this.redactObject(parsed, inventory, options))
      }
    } catch {
      // Fall through to plain-text redaction below.
    }

    return this.redactText(text, inventory)
  },

  redactForPublicStorage<T extends JsonLike>(value: T, inventory: SecretInventory): T {
    return this.redactObject(value, inventory, { skipKeys: ['screenshot'] })
  },

  createRedactedEmit(emit: SSEEmit, inventory: SecretInventory): SSEEmit {
    if (inventory.enabled === false) return emit
    return (event, data) => {
      emit(event, this.redactForPublicStorage(data, inventory) as Record<string, unknown>)
    }
  },
}
