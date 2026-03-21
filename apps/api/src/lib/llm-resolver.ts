export const LLM_ROLE_MODEL_FIELDS = {
  primary: 'aiModel',
  medium: 'mediumModel',
  light: 'lightModel',
  explore: 'exploreModel',
  execute: 'executeModel',
  title: 'titleModel',
  compact: 'compactModel',
} as const

export const SECONDARY_LLM_ROLES = [
  'medium',
  'light',
  'explore',
  'execute',
  'title',
  'compact',
] as const

export type LLMRole = keyof typeof LLM_ROLE_MODEL_FIELDS
export type SecondaryLLMRole = (typeof SECONDARY_LLM_ROLES)[number]
export type LLMProviderOverrides = Partial<Record<SecondaryLLMRole, string>>
export type ResolvedLLMRoleMap = Record<LLMRole, { provider: string; model: string | null }>
export type ResolvedRoleProviderMap = Record<LLMRole, string>

interface LLMSettings {
  aiProvider: string
  aiModel: string | null
  mediumModel: string | null
  lightModel: string | null
  exploreModel: string | null
  executeModel: string | null
  titleModel: string | null
  compactModel: string | null
  advancedModelConfig: boolean
  llmProviderOverrides: unknown
}

export function normalizeLLMProviderOverrides(value: unknown): LLMProviderOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const normalized: LLMProviderOverrides = {}
  for (const role of SECONDARY_LLM_ROLES) {
    const provider = (value as Record<string, unknown>)[role]
    if (typeof provider === 'string' && provider.trim()) {
      normalized[role] = provider.trim()
    }
  }
  return normalized
}

export function mergeLLMProviderOverrides(
  current: unknown,
  updates?: Partial<Record<LLMRole, string>>,
): LLMProviderOverrides {
  const merged = normalizeLLMProviderOverrides(current)
  if (!updates) return merged

  for (const role of SECONDARY_LLM_ROLES) {
    const provider = updates[role]
    if (typeof provider === 'string' && provider.trim()) {
      merged[role] = provider.trim()
    }
  }

  return merged
}

export function resolveLLMRole(
  settings: LLMSettings,
  role: LLMRole,
): {
  provider: string
  model: string | null
} {
  const overrides = normalizeLLMProviderOverrides(settings.llmProviderOverrides)
  const primary = { provider: settings.aiProvider, model: settings.aiModel }

  if (role === 'primary') return primary

  // Look up the role's own model
  const modelField = LLM_ROLE_MODEL_FIELDS[role]
  const roleModel = settings[modelField as keyof LLMSettings] as string | null

  // If this role has its own model, use it with its own provider
  if (roleModel) {
    return {
      provider: overrides[role as SecondaryLLMRole] ?? settings.aiProvider,
      model: roleModel,
    }
  }

  // No model set — inherit both provider and model from primary
  return primary
}

export function resolveAllLLMRoles(settings: LLMSettings): ResolvedLLMRoleMap {
  return {
    primary: resolveLLMRole(settings, 'primary'),
    medium: resolveLLMRole(settings, 'medium'),
    light: resolveLLMRole(settings, 'light'),
    explore: resolveLLMRole(settings, 'explore'),
    execute: resolveLLMRole(settings, 'execute'),
    title: resolveLLMRole(settings, 'title'),
    compact: resolveLLMRole(settings, 'compact'),
  }
}

export function buildResolvedRoleProviders(settings: LLMSettings): ResolvedRoleProviderMap {
  const resolved = resolveAllLLMRoles(settings)
  return {
    primary: resolved.primary.provider,
    medium: resolved.medium.provider,
    light: resolved.light.provider,
    explore: resolved.explore.provider,
    execute: resolved.execute.provider,
    title: resolved.title.provider,
    compact: resolved.compact.provider,
  }
}
