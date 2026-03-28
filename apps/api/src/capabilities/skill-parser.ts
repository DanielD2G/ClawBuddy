import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import type {
  SkillDefinition,
  SkillInput,
  CapabilityDefinition,
  ConfigFieldDefinition,
  ToolDefinition,
  ParsedSkillDocument,
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
  inputs: z
    .record(
      z.union([
        z.enum(['var', 'secret', 'textarea']),
        z.object({
          type: z.enum(['var', 'secret', 'textarea']),
          default: z.string().optional(),
          description: z.string().optional(),
          placeholder: z.string().optional(),
        }),
      ]),
    )
    .optional(),
})

const OpenCodeSkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Skill name must match the OpenCode naming rules')

const ClawbuddySkillSchema = z.object({
  displayName: z.string().optional(),
  version: z.string().default('1.0.0'),
  icon: z.string().optional(),
  category: z.string().default('general'),
  type: z.enum(['bash', 'python', 'js']).optional(),
  tag: z.enum(['bash', 'python', 'js']).optional(),
  networkAccess: z.boolean().default(false),
  installation: z.string().optional(),
  tools: z.array(ToolDefinitionSchema).min(1),
  inputs: z
    .record(
      z.union([
        z.enum(['var', 'secret', 'textarea']),
        z.object({
          type: z.enum(['var', 'secret', 'textarea']),
          default: z.string().optional(),
          description: z.string().optional(),
          placeholder: z.string().optional(),
        }),
      ]),
    )
    .optional(),
})

const OpenCodeFrontmatterSchema = z.object({
  name: OpenCodeSkillNameSchema,
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string()).optional(),
  clawbuddy: ClawbuddySkillSchema,
})

/**
 * Humanize a snake_case or camelCase key into a label.
 * e.g. "aws_access_key_id" -> "Aws Access Key Id"
 */
function humanizeKey(key: string): string {
  return key
    .replace(/[_-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Convert skill inputs to ConfigFieldDefinition array.
 * Supports both short form ("var"/"secret") and object form ({ type, default, ... }).
 */
function inputsToConfigSchema(inputs: Record<string, SkillInput>): ConfigFieldDefinition[] {
  return Object.entries(inputs).map(([key, input]) => {
    const isObject = typeof input === 'object'
    const inputType = isObject ? input.type : input

    return {
      key,
      label: humanizeKey(key),
      type:
        inputType === 'secret'
          ? ('password' as const)
          : inputType === 'textarea'
            ? ('textarea' as const)
            : ('string' as const),
      required: false,
      envVar: key.toUpperCase(),
      default: isObject ? input.default : undefined,
      description: isObject ? input.description : undefined,
      placeholder: isObject ? input.placeholder : undefined,
    }
  })
}

function buildParsedSkillDocument(
  skill: SkillDefinition,
  format: ParsedSkillDocument['format'],
): ParsedSkillDocument {
  const configSchema = skill.inputs ? inputsToConfigSchema(skill.inputs) : undefined

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

  return {
    skill,
    capability,
    dbData,
    format,
    storageExtension: format === 'markdown' ? '.md' : '.skill',
    contentType: format === 'markdown' ? 'text/markdown' : 'application/json',
  }
}

function parseMarkdownFrontmatter(content: string): { frontmatter: string; body: string } {
  const normalized = content.replace(/^\uFEFF/, '')
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)

  if (!match) {
    throw new Error('Markdown skills must start with YAML frontmatter delimited by ---')
  }

  return {
    frontmatter: match[1],
    body: match[2].trim(),
  }
}

function parseMarkdownSkill(content: string): ParsedSkillDocument {
  const { frontmatter, body } = parseMarkdownFrontmatter(content)

  let parsedFrontmatter: unknown
  try {
    parsedFrontmatter = parseYaml(frontmatter)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid YAML frontmatter: ${message}`)
  }

  const skillDoc = OpenCodeFrontmatterSchema.parse(parsedFrontmatter)
  const skillType = skillDoc.clawbuddy.type ?? skillDoc.clawbuddy.tag

  if (!skillType) {
    throw new Error('clawbuddy.type is required')
  }

  const skill: SkillDefinition = {
    name: skillDoc.clawbuddy.displayName ?? humanizeKey(skillDoc.name).replace(/\bCli\b/g, 'CLI'),
    slug: skillDoc.name,
    description: skillDoc.description,
    version: skillDoc.clawbuddy.version,
    icon: skillDoc.clawbuddy.icon,
    category: skillDoc.clawbuddy.category,
    type: skillType,
    networkAccess: skillDoc.clawbuddy.networkAccess,
    instructions: body,
    installation: skillDoc.clawbuddy.installation,
    tools: skillDoc.clawbuddy.tools as ToolDefinition[],
    inputs: skillDoc.clawbuddy.inputs,
  }

  return buildParsedSkillDocument(skill, 'markdown')
}

/**
 * Parse and validate a legacy .skill JSON file into a CapabilityDefinition
 * and Prisma-compatible data for upserting.
 */
export function parseSkillFile(raw: unknown): ParsedSkillDocument {
  const skill = SkillDefinitionSchema.parse(raw)

  return buildParsedSkillDocument(skill, 'json')
}

export function parseSkillSource(content: string): ParsedSkillDocument {
  const trimmed = content.trimStart()

  if (trimmed.startsWith('{')) {
    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch {
      throw new Error('Invalid JSON in legacy .skill file')
    }

    return parseSkillFile(raw)
  }

  return parseMarkdownSkill(content)
}
