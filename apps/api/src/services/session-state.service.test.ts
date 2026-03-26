import { describe, expect, test } from 'vitest'
import {
  getSessionAllowRules,
  getSessionLoadedCapabilitySlugs,
  buildSessionConversationState,
} from './session-state.service.js'

describe('session-state.service', () => {
  // ── getSessionAllowRules ──────────────────────────────────────────────

  describe('getSessionAllowRules', () => {
    test('returns empty array for null input', () => {
      expect(getSessionAllowRules(null)).toEqual([])
    })

    test('returns empty array for non-object/non-array input', () => {
      expect(getSessionAllowRules('string' as unknown as null)).toEqual([])
      expect(getSessionAllowRules(42 as unknown as null)).toEqual([])
    })

    test('handles legacy array format (plain string array)', () => {
      const rules = ['allow:bash:*', 'allow:file:read']
      expect(getSessionAllowRules(rules)).toEqual(rules)
    })

    test('filters non-string elements from legacy array', () => {
      const mixed = ['allow:bash:*', 42, null, 'allow:file:read']
      expect(getSessionAllowRules(mixed as unknown[])).toEqual(['allow:bash:*', 'allow:file:read'])
    })

    test('reads allowRules from object format', () => {
      const state = {
        allowRules: ['allow:bash:*', 'allow:web:*'],
        loadedCapabilitySlugs: ['cap-1'],
      }
      expect(getSessionAllowRules(state)).toEqual(['allow:bash:*', 'allow:web:*'])
    })

    test('returns empty array when object has no allowRules', () => {
      expect(getSessionAllowRules({})).toEqual([])
    })
  })

  // ── getSessionLoadedCapabilitySlugs ───────────────────────────────────

  describe('getSessionLoadedCapabilitySlugs', () => {
    test('returns empty array for null input', () => {
      expect(getSessionLoadedCapabilitySlugs(null)).toEqual([])
    })

    test('returns empty array for legacy array format', () => {
      // Legacy format only has allow rules, no capability slugs
      expect(getSessionLoadedCapabilitySlugs(['allow:bash:*'])).toEqual([])
    })

    test('reads loadedCapabilitySlugs from object format', () => {
      const state = {
        allowRules: [],
        loadedCapabilitySlugs: ['sandbox', 'web-search'],
      }
      expect(getSessionLoadedCapabilitySlugs(state)).toEqual(['sandbox', 'web-search'])
    })

    test('returns empty array when object has no loadedCapabilitySlugs', () => {
      expect(getSessionLoadedCapabilitySlugs({ allowRules: ['r1'] })).toEqual([])
    })

    test('filters non-string elements', () => {
      const state = {
        loadedCapabilitySlugs: ['sandbox', 42, null, 'web-search'],
      }
      expect(getSessionLoadedCapabilitySlugs(state as unknown as null)).toEqual([
        'sandbox',
        'web-search',
      ])
    })
  })

  // ── buildSessionConversationState ─────────────────────────────────────

  describe('buildSessionConversationState', () => {
    test('builds state from null current value', () => {
      const result = buildSessionConversationState(null, {
        allowRules: ['allow:bash:*'],
        loadedCapabilitySlugs: ['sandbox'],
      })

      expect(result).toEqual({
        allowRules: ['allow:bash:*'],
        loadedCapabilitySlugs: ['sandbox'],
      })
    })

    test('preserves existing values when no updates provided', () => {
      const current = {
        allowRules: ['allow:bash:*'],
        loadedCapabilitySlugs: ['sandbox'],
      }
      const result = buildSessionConversationState(current, {})
      expect(result).toEqual(current)
    })

    test('updates allowRules while preserving loadedCapabilitySlugs', () => {
      const current = {
        allowRules: ['old-rule'],
        loadedCapabilitySlugs: ['sandbox'],
      }
      const result = buildSessionConversationState(current, {
        allowRules: ['new-rule'],
      })

      expect(result).toEqual({
        allowRules: ['new-rule'],
        loadedCapabilitySlugs: ['sandbox'],
      })
    })

    test('updates loadedCapabilitySlugs while preserving allowRules', () => {
      const current = {
        allowRules: ['allow:bash:*'],
        loadedCapabilitySlugs: ['sandbox'],
      }
      const result = buildSessionConversationState(current, {
        loadedCapabilitySlugs: ['sandbox', 'web-search'],
      })

      expect(result).toEqual({
        allowRules: ['allow:bash:*'],
        loadedCapabilitySlugs: ['sandbox', 'web-search'],
      })
    })

    test('migrates legacy array format when updating', () => {
      // Legacy format: plain array of allow rules
      const legacy = ['allow:bash:*', 'allow:file:read']
      const result = buildSessionConversationState(legacy, {
        loadedCapabilitySlugs: ['new-cap'],
      })

      expect(result).toEqual({
        allowRules: ['allow:bash:*', 'allow:file:read'],
        loadedCapabilitySlugs: ['new-cap'],
      })
    })

    test('updates both fields simultaneously', () => {
      const result = buildSessionConversationState(null, {
        allowRules: ['rule-1', 'rule-2'],
        loadedCapabilitySlugs: ['cap-1', 'cap-2'],
      })

      expect(result).toEqual({
        allowRules: ['rule-1', 'rule-2'],
        loadedCapabilitySlugs: ['cap-1', 'cap-2'],
      })
    })
  })
})
