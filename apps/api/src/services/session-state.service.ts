import { Prisma } from '@prisma/client'

interface SessionConversationState {
  allowRules: string[]
  loadedCapabilitySlugs: string[]
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function readSessionConversationState(value: Prisma.JsonValue | null): SessionConversationState {
  if (Array.isArray(value)) {
    return {
      allowRules: value.filter((item): item is string => typeof item === 'string'),
      loadedCapabilitySlugs: [],
    }
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return {
      allowRules: asStringArray(record.allowRules),
      loadedCapabilitySlugs: asStringArray(record.loadedCapabilitySlugs),
    }
  }

  return {
    allowRules: [],
    loadedCapabilitySlugs: [],
  }
}

export function getSessionAllowRules(value: Prisma.JsonValue | null): string[] {
  return readSessionConversationState(value).allowRules
}

export function getSessionLoadedCapabilitySlugs(value: Prisma.JsonValue | null): string[] {
  return readSessionConversationState(value).loadedCapabilitySlugs
}

export function buildSessionConversationState(
  current: Prisma.JsonValue | null,
  updates: {
    allowRules?: string[]
    loadedCapabilitySlugs?: string[]
  },
): Prisma.InputJsonValue {
  const existing = readSessionConversationState(current)

  return {
    allowRules: updates.allowRules ?? existing.allowRules,
    loadedCapabilitySlugs: updates.loadedCapabilitySlugs ?? existing.loadedCapabilitySlugs,
  } satisfies Prisma.InputJsonValue
}
