import type { Prisma } from '@prisma/client'

export interface ToolDefinition {
  name: string
  description: string
  /** Prefix prepended to the command argument before execution (e.g. "docker", "aws") */
  prefix?: string
  /** Script template executed for this tool. Use {{param_name}} placeholders for arguments. */
  script?: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ConfigFieldDefinition {
  key: string
  label: string
  type: 'string' | 'password' | 'select' | 'textarea'
  required: boolean
  description?: string
  envVar: string
  default?: string
  options?: Array<{ label: string; value: string }>
  placeholder?: string
}

export interface CapabilityDefinition {
  slug: string
  name: string
  description: string
  icon?: string
  category: string
  version: string
  tools: ToolDefinition[]
  systemPrompt: string
  configSchema?: ConfigFieldDefinition[]
  /** Shell script to install dependencies in the sandbox image */
  installationScript?: string
  /** Signals frontend to show an OAuth button instead of a config form */
  authType?: 'oauth-google'
  /** Execution type for sandbox-based builtins (e.g. 'bash'). Stored as skillType in DB. */
  skillType?: SkillType
  sandbox: {
    dockerImage?: string
    dockerfile?: string
    packages?: string[]
    networkAccess?: boolean
  }
}

// ── Skill Plugin System ─────────────────────────────────────

export type SkillType = 'bash' | 'python' | 'js'
export type InputType = 'var' | 'secret' | 'textarea'

export interface InputDefinition {
  type: InputType
  default?: string
  description?: string
  placeholder?: string
}

/** Each input can be a simple "var"/"secret" string or a full InputDefinition object */
export type SkillInput = InputType | InputDefinition

export interface SkillDefinition {
  name: string
  slug: string
  description: string
  version: string
  icon?: string
  category?: string
  type: SkillType
  networkAccess?: boolean
  instructions: string
  installation?: string
  tools: ToolDefinition[]
  inputs?: Record<string, SkillInput>
}

export interface ParsedSkillDocument {
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
  format: 'markdown'
  storageExtension: '.md'
  contentType: 'text/markdown'
}
