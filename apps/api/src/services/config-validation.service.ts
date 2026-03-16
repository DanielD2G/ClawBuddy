import type { ConfigFieldDefinition } from '../capabilities/types.js'
import { encrypt, decrypt } from './crypto.service.js'

const MASK = '••••••••'

interface ValidationResult {
  valid: boolean
  errors: string[]
}

export function validateCapabilityConfig(
  schema: ConfigFieldDefinition[],
  config: Record<string, unknown>,
): ValidationResult {
  const errors: string[] = []

  for (const field of schema) {
    const value = config[field.key]

    if (field.required) {
      if (value === undefined || value === null || value === '') {
        errors.push(`${field.label} is required`)
        continue
      }
    }

    if (value !== undefined && value !== null && value !== '') {
      if (field.type === 'select' && field.options) {
        const validValues = field.options.map((o) => o.value)
        if (!validValues.includes(value as string)) {
          errors.push(`${field.label}: invalid option "${value}"`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

export function encryptConfigFields(
  schema: ConfigFieldDefinition[],
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...config }
  const passwordKeys = new Set(schema.filter((f) => f.type === 'password').map((f) => f.key))

  for (const key of Object.keys(result)) {
    if (passwordKeys.has(key) && typeof result[key] === 'string' && result[key] !== '') {
      result[key] = encrypt(result[key] as string)
    }
  }

  return result
}

export function decryptConfigFields(
  schema: ConfigFieldDefinition[],
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...config }
  const passwordKeys = new Set(schema.filter((f) => f.type === 'password').map((f) => f.key))

  for (const key of Object.keys(result)) {
    if (passwordKeys.has(key) && typeof result[key] === 'string' && result[key] !== '') {
      try {
        result[key] = decrypt(result[key] as string)
      } catch {
        // Value may not be encrypted (e.g. during migration)
      }
    }
  }

  return result
}

export function maskConfigFields(
  schema: ConfigFieldDefinition[],
  config: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...config }
  const passwordKeys = new Set(schema.filter((f) => f.type === 'password').map((f) => f.key))

  for (const key of Object.keys(result)) {
    if (passwordKeys.has(key) && typeof result[key] === 'string' && result[key] !== '') {
      result[key] = MASK
    }
  }

  return result
}

export function isMaskedValue(value: unknown): boolean {
  return value === MASK
}

export function mergeWithExistingConfig(
  schema: ConfigFieldDefinition[],
  newConfig: Record<string, unknown>,
  existingConfig: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...newConfig }
  const passwordKeys = new Set(schema.filter((f) => f.type === 'password').map((f) => f.key))

  for (const key of Object.keys(result)) {
    if (passwordKeys.has(key) && isMaskedValue(result[key])) {
      result[key] = existingConfig[key]
    }
  }

  return result
}
