import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

// No need to mock constants — the code now only filters 'tool-discovery' (hardcoded)

vi.mock('./session-state.service.js', () => ({
  buildSessionConversationState: vi.fn().mockReturnValue({ loadedCapabilitySlugs: [] }),
}))

vi.mock('./system-prompt-builder.js', () => ({
  buildPromptSection: vi.fn().mockImplementation((name: string, content: string) => {
    return `<${name}>\n${content}\n</${name}>`
  }),
}))

import {
  stringArraysEqual,
  mergeConversationLoadedCapabilitySlugs,
  persistConversationLoadedCapabilitySlugs,
  buildConversationLoadedCapabilitiesSection,
  MAX_CONVERSATION_LOADED_CAPABILITIES,
} from './agent-conversation-state.js'

// ── Tests ───────────────────────────────────────────────────────────────

describe('stringArraysEqual', () => {
  test('returns true for identical arrays', () => {
    expect(stringArraysEqual(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(true)
  })

  test('returns false for different lengths', () => {
    expect(stringArraysEqual(['a', 'b'], ['a', 'b', 'c'])).toBe(false)
  })

  test('returns false for different order', () => {
    expect(stringArraysEqual(['a', 'b'], ['b', 'a'])).toBe(false)
  })

  test('returns true for empty arrays', () => {
    expect(stringArraysEqual([], [])).toBe(true)
  })

  test('returns false for same length but different values', () => {
    expect(stringArraysEqual(['a', 'b'], ['a', 'c'])).toBe(false)
  })
})

describe('mergeConversationLoadedCapabilitySlugs', () => {
  const enabledSlugs = new Set(['cap-a', 'cap-b', 'cap-c', 'cap-d', 'bash', 'python'])

  test('merges new additions with existing slugs', () => {
    const result = mergeConversationLoadedCapabilitySlugs(['cap-a'], ['cap-b'], enabledSlugs)
    // additions come first, then existing
    expect(result).toEqual(['cap-b', 'cap-a'])
  })

  test('filters out tool-discovery (prompt-native) but keeps other always-on slugs', () => {
    const slugs = new Set([...enabledSlugs, 'tool-discovery'])
    const result = mergeConversationLoadedCapabilitySlugs(
      ['cap-a'],
      ['bash', 'tool-discovery'],
      slugs,
    )
    // bash is kept (discoverable), tool-discovery is filtered (prompt-native)
    expect(result).toEqual(['bash', 'cap-a'])
  })

  test('filters out slugs not in enabled set', () => {
    const result = mergeConversationLoadedCapabilitySlugs(['cap-a'], ['not-enabled'], enabledSlugs)
    expect(result).toEqual(['cap-a'])
  })

  test('deduplicates slugs', () => {
    const result = mergeConversationLoadedCapabilitySlugs(
      ['cap-a', 'cap-b'],
      ['cap-a'],
      enabledSlugs,
    )
    expect(result).toEqual(['cap-a', 'cap-b'])
  })

  test('caps at MAX_CONVERSATION_LOADED_CAPABILITIES', () => {
    const many = new Set(Array.from({ length: 20 }, (_, i) => `cap-${i}`))
    const result = mergeConversationLoadedCapabilitySlugs(
      Array.from({ length: 20 }, (_, i) => `cap-${i}`),
      [],
      many,
    )
    expect(result.length).toBe(MAX_CONVERSATION_LOADED_CAPABILITIES)
  })

  test('handles null/undefined inputs', () => {
    const result = mergeConversationLoadedCapabilitySlugs(null, undefined, enabledSlugs)
    expect(result).toEqual([])
  })

  test('handles empty additions and existing', () => {
    const result = mergeConversationLoadedCapabilitySlugs([], [], enabledSlugs)
    expect(result).toEqual([])
  })
})

describe('persistConversationLoadedCapabilitySlugs', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
  })

  test('returns current slugs when no additions', async () => {
    const result = await persistConversationLoadedCapabilitySlugs(
      'session-1',
      ['cap-a'],
      [],
      new Set(['cap-a']),
    )
    expect(result).toEqual(['cap-a'])
    expect(mockPrisma.chatSession.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  test('persists merged slugs to database when they change', async () => {
    mockPrisma.chatSession.findUniqueOrThrow.mockResolvedValue({
      id: 'session-1',
      sessionAllowRules: null,
    })

    const enabledSlugs = new Set(['cap-a', 'cap-b'])
    const result = await persistConversationLoadedCapabilitySlugs(
      'session-1',
      ['cap-a'],
      ['cap-b'],
      enabledSlugs,
    )

    expect(result).toEqual(['cap-b', 'cap-a'])
    expect(mockPrisma.chatSession.update).toHaveBeenCalled()
  })

  test('skips DB write when merged result equals current', async () => {
    const enabledSlugs = new Set(['cap-a'])
    const result = await persistConversationLoadedCapabilitySlugs(
      'session-1',
      ['cap-a'],
      ['cap-a'],
      enabledSlugs,
    )

    expect(result).toEqual(['cap-a'])
    expect(mockPrisma.chatSession.findUniqueOrThrow).not.toHaveBeenCalled()
  })
})

describe('buildConversationLoadedCapabilitiesSection', () => {
  test('returns empty string when no loaded slugs', () => {
    const result = buildConversationLoadedCapabilitiesSection([], [])
    expect(result).toBe('')
  })

  test('returns empty string when slugs have no matching capabilities', () => {
    const result = buildConversationLoadedCapabilitiesSection(
      ['unknown-slug'],
      [{ slug: 'other', name: 'Other Cap' }],
    )
    // Falls back to slug name itself
    expect(result).toContain('unknown-slug')
  })

  test('generates prompt text with capability names', () => {
    const result = buildConversationLoadedCapabilitiesSection(
      ['cap-a', 'cap-b'],
      [
        { slug: 'cap-a', name: 'Capability A' },
        { slug: 'cap-b', name: 'Capability B' },
      ],
    )
    expect(result).toContain('Capability A')
    expect(result).toContain('Capability B')
    expect(result).toContain('conversation_loaded_capabilities')
  })

  test('uses slug as fallback when capability name not found', () => {
    const result = buildConversationLoadedCapabilitiesSection(
      ['cap-a'],
      [{ slug: 'cap-b', name: 'Capability B' }],
    )
    expect(result).toContain('cap-a')
  })
})
