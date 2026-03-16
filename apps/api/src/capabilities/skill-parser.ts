import { z } from 'zod'
import type {
  SkillDefinition,
  SkillInput,
  CapabilityDefinition,
  ConfigFieldDefinition,
  ToolDefinition,
} from './types.js'
import type { Prisma } from '@prisma/client'

const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  prefix: z.string().optional(),
  script: z.string().optional(),
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(z.unknown()),
    required: z.array(z.string()).optional(),
  }),
})

const SkillDefinitionSchema = z.object({
  name: z.string(),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string(),
  version: z.string().default('1.0.0'),
  icon: z.string().optional(),
  category: z.string().default('general'),
  type: z.enum(['bash', 'python', 'js']),
  networkAccess: z.boolean().default(false),
  instructions: z.string(),
  installation: z.string().optional(),
  tools: z.array(ToolDefinitionSchema).min(1),
  inputs: z.record(
    z.union([
      z.enum(['var', 'secret', 'textarea']),
      z.object({
        type: z.enum(['var', 'secret', 'textarea']),
        default: z.string().optional(),
        description: z.string().optional(),
        placeholder: z.string().optional(),
      }),
    ]),
  ).optional(),
})

/**
 * Humanize a snake_case or camelCase key into a label.
 * e.g. "aws_access_key_id" -> "Aws Access Key Id"
 */
function humanizeKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Convert skill inputs to ConfigFieldDefinition array.
 * Supports both short form ("var"/"secret") and object form ({ type, default, ... }).
 */
function inputsToConfigSchema(
  inputs: Record<string, SkillInput>,
): ConfigFieldDefinition[] {
  return Object.entries(inputs).map(([key, input]) => {
    const isObject = typeof input === 'object'
    const inputType = isObject ? input.type : input

    return {
      key,
      label: humanizeKey(key),
      type: inputType === 'secret' ? ('password' as const) : inputType === 'textarea' ? ('textarea' as const) : ('string' as const),
      required: false,
      envVar: key.toUpperCase(),
      default: isObject ? input.default : undefined,
      description: isObject ? input.description : undefined,
      placeholder: isObject ? input.placeholder : undefined,
    }
  })
}

/**
 * Parse and validate a .skill file JSON into a CapabilityDefinition
 * and Prisma-compatible data for upserting.
 */
export function parseSkillFile(raw: unknown): {
  skill: SkillDefinition
  capability: CapabilityDefinition
  dbData: {
    slug: string
    name: string
    description: string
    icon: string | undefined
    category: string
    version: string
    toolDefinitions: Prisma.InputJsonValue
    systemPrompt: string
    dockerImage: string | null
    packages: string[]
    networkAccess: boolean
    configSchema: Prisma.InputJsonValue | undefined
    builtin: boolean
    skillType: string
    installationScript: string | null
    source: string
  }
} {
  const skill = SkillDefinitionSchema.parse(raw)

  const configSchema = skill.inputs
    ? inputsToConfigSchema(skill.inputs)
    : undefined

  const capability: CapabilityDefinition = {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    icon: skill.icon,
    category: skill.category ?? 'general',
    version: skill.version,
    tools: skill.tools as ToolDefinition[],
    systemPrompt: skill.instructions,
    configSchema,
    sandbox: {
      networkAccess: skill.networkAccess ?? false,
    },
  }

  const dbData = {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    icon: skill.icon,
    category: skill.category ?? 'general',
    version: skill.version,
    toolDefinitions: JSON.parse(JSON.stringify(skill.tools)) as Prisma.InputJsonValue,
    systemPrompt: skill.instructions,
    dockerImage: null,
    packages: [] as string[],
    networkAccess: skill.networkAccess ?? false,
    configSchema: configSchema
      ? (JSON.parse(JSON.stringify(configSchema)) as Prisma.InputJsonValue)
      : undefined,
    builtin: false,
    skillType: skill.type,
    installationScript: skill.installation ?? null,
    source: 'skill' as const,
  }

  return { skill, capability, dbData }
}
