export interface WorkspaceSettings extends Record<string, unknown> {
  secretRedactionEnabled?: boolean
}

export const DEFAULT_SECRET_REDACTION_ENABLED = true

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function parseWorkspaceSettings(value: unknown): WorkspaceSettings | null {
  if (!isPlainObject(value)) return null
  return value as WorkspaceSettings
}

export function isSecretRedactionEnabled(settings: unknown): boolean {
  return parseWorkspaceSettings(settings)?.secretRedactionEnabled !== false
}

export function mergeWorkspaceSettings(
  existing: unknown,
  updates: Record<string, unknown> | null | undefined,
): WorkspaceSettings | null | undefined {
  if (updates === undefined) return parseWorkspaceSettings(existing)
  if (updates === null) return null
  if (!isPlainObject(updates)) return parseWorkspaceSettings(existing) ?? {}

  return {
    ...(parseWorkspaceSettings(existing) ?? {}),
    ...updates,
  }
}
