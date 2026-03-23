import { describe, expect, test } from 'bun:test'
import { isReleaseNewer, isVersionAtLeast, normalizeVersion } from './update/update.manifest.js'
import {
  buildTargetImageReference,
  extractDigestFromImage,
  extractVersionFromImage,
  observedImageMatchesTarget,
} from './update/update.swarm.js'
import { serializeControllerRun } from './update/update.controller.js'

describe('version helpers', () => {
  test('normalizes tagged versions', () => {
    expect(normalizeVersion('0.4.2')).toBe('v0.4.2')
    expect(normalizeVersion('v0.4.2')).toBe('v0.4.2')
  })

  test('detects newer stable releases', () => {
    expect(isReleaseNewer('v0.4.0', 'v0.4.1')).toBe(true)
    expect(isReleaseNewer('v0.4.1', 'v0.4.1')).toBe(false)
    expect(isReleaseNewer('legacy/latest', 'v0.4.1')).toBe(true)
  })

  test('checks minimum updater versions', () => {
    expect(isVersionAtLeast('v0.4.2', 'v0.4.1')).toBe(true)
    expect(isVersionAtLeast('v0.4.1', 'v0.4.2')).toBe(false)
    expect(isVersionAtLeast('dev', 'v0.4.2')).toBe(false)
  })
})

describe('swarm image helpers', () => {
  test('extracts versions and digests from image references', () => {
    expect(extractVersionFromImage('ghcr.io/danield2g/clawbuddy:0.5.1')).toBe('v0.5.1')
    expect(
      extractDigestFromImage('ghcr.io/danield2g/clawbuddy:0.5.1@sha256:1234567890abcdef'),
    ).toBe('sha256:1234567890abcdef')
  })

  test('builds target image references with digests when provided', () => {
    expect(
      buildTargetImageReference({
        version: 'v0.4.2',
        appImage: 'ghcr.io/danield2g/clawbuddy:0.4.2',
        imageDigest: 'sha256:abc123',
        migration: { mode: 'none', rollbackSafe: true },
        deliveryMode: 'integrated',
        minUpdaterVersion: null,
        notesUrl: null,
      }),
    ).toBe('ghcr.io/danield2g/clawbuddy:0.4.2@sha256:abc123')
  })

  test('requires digest matches when the manifest declares one', () => {
    const manifest = {
      version: 'v0.4.2',
      appImage: 'ghcr.io/danield2g/clawbuddy:0.4.2',
      imageDigest: 'sha256:abc123',
      migration: { mode: 'none' as const, rollbackSafe: true },
      deliveryMode: 'integrated' as const,
      minUpdaterVersion: null,
      notesUrl: null,
    }

    expect(
      observedImageMatchesTarget('ghcr.io/danield2g/clawbuddy:0.4.2@sha256:abc123', manifest),
    ).toBe(true)
    expect(
      observedImageMatchesTarget('ghcr.io/danield2g/clawbuddy:0.4.2@sha256:def456', manifest),
    ).toBe(false)
  })
})

describe('controller serialization', () => {
  test('serializes manifest snapshots and event timelines', () => {
    const run = serializeControllerRun({
      id: 'run_1',
      status: 'running',
      phase: 'pending',
      stage: 'verifying',
      message: 'Waiting for health',
      currentVersion: 'v0.4.1',
      targetVersion: 'v0.4.2',
      targetReleaseName: 'v0.4.2',
      targetReleaseUrl: 'https://example.com/release',
      targetPublishedAt: new Date('2026-03-22T00:00:00.000Z'),
      targetReleaseNotes: 'Notes',
      deliveryMode: 'integrated',
      serviceRole: 'app',
      manifest: {
        version: 'v0.4.2',
        appImage: 'ghcr.io/danield2g/clawbuddy:0.4.2',
        imageDigest: null,
        migration: { mode: 'none', rollbackSafe: true },
        deliveryMode: 'integrated',
        minUpdaterVersion: null,
        notesUrl: 'https://example.com/release',
      },
      targetImage: 'ghcr.io/danield2g/clawbuddy:0.4.2',
      targetImageDigest: null,
      observedVersion: 'v0.4.2',
      observedImage: 'ghcr.io/danield2g/clawbuddy:0.4.2',
      observedImageDigest: null,
      rollbackReason: null,
      phaseMessage: null,
      progress: null,
      error: null,
      leaseOwner: 'updater-1',
      leaseExpiresAt: new Date('2026-03-22T00:05:00.000Z'),
      heartbeatAt: new Date('2026-03-22T00:04:50.000Z'),
      verificationDeadlineAt: new Date('2026-03-22T00:10:00.000Z'),
      startedAt: new Date('2026-03-22T00:04:00.000Z'),
      completedAt: null,
      createdAt: new Date('2026-03-22T00:04:00.000Z'),
      updatedAt: new Date('2026-03-22T00:04:50.000Z'),
      events: [
        {
          id: 'event_1',
          step: 'deploying',
          status: 'running',
          message: 'Requested Swarm rollout',
          details: null,
          createdAt: new Date('2026-03-22T00:04:30.000Z'),
        },
      ],
    })

    expect(run.manifest?.version).toBe('v0.4.2')
    expect(run.events).toHaveLength(1)
    expect(run.events[0]?.step).toBe('deploying')
  })
})
