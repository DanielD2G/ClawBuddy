import { describe, expect, it } from 'vitest'
import {
  getSystemUpdatePollInterval,
  getSystemUpdateToastMessage,
  isSystemUpdateInProgress,
} from './system-update'

describe('system-update frontend helpers', () => {
  it('identifies in-progress states', () => {
    expect(isSystemUpdateInProgress('queued')).toBe(true)
    expect(isSystemUpdateInProgress('pulling')).toBe(true)
    expect(isSystemUpdateInProgress('waiting_api')).toBe(true)
    expect(isSystemUpdateInProgress('idle')).toBe(false)
    expect(isSystemUpdateInProgress('succeeded')).toBe(false)
  })

  it('uses faster polling while an update is active', () => {
    expect(getSystemUpdatePollInterval('idle')).toBe(5 * 60_000)
    expect(getSystemUpdatePollInterval('replacing_web')).toBe(3000)
  })

  it('returns user-facing toast copy for each transition', () => {
    expect(getSystemUpdateToastMessage('pulling')).toBe('Pulling updated images...')
    expect(getSystemUpdateToastMessage('replacing_api')).toBe('Recreating the API container...')
    expect(getSystemUpdateToastMessage('succeeded')).toBe('ClawBuddy updated successfully.')
    expect(getSystemUpdateToastMessage('idle')).toBe('')
  })
})
