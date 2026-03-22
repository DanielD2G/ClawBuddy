import { describe, expect, test } from 'bun:test'
import { buildTargetImage, extractVersionFromImage, isReleaseNewer } from './update.service.js'

describe('extractVersionFromImage', () => {
  test('extracts a semver tag from a tagged image reference', () => {
    expect(extractVersionFromImage('ghcr.io/danield2g/clawbuddy-api:v0.5.1')).toBe('v0.5.1')
  })

  test('ignores digests and still returns the semantic tag', () => {
    expect(
      extractVersionFromImage('ghcr.io/danield2g/clawbuddy-web:v1.2.3@sha256:1234567890abcdef'),
    ).toBe('v1.2.3')
  })

  test('returns latest when the image does not expose a semantic version yet', () => {
    expect(extractVersionFromImage('ghcr.io/danield2g/clawbuddy-api:latest')).toBe('vlatest')
  })
})

describe('isReleaseNewer', () => {
  test('detects when the target version is newer than the installed one', () => {
    expect(isReleaseNewer('v0.4.0', 'v0.4.1')).toBe(true)
  })

  test('does not flag the same version as newer', () => {
    expect(isReleaseNewer('v0.4.1', 'v0.4.1')).toBe(false)
  })

  test('treats legacy installs as needing an update when a stable release exists', () => {
    expect(isReleaseNewer('legacy/latest', 'v0.4.1')).toBe(true)
  })
})

describe('buildTargetImage', () => {
  test('replaces the tag and strips an existing digest from the running service image', () => {
    expect(
      buildTargetImage(
        {
          ID: 'svc-1',
          Spec: {
            TaskTemplate: {
              ContainerSpec: {
                Image: 'ghcr.io/danield2g/clawbuddy:0.3.0@sha256:abcdef123456',
              },
            },
          },
        },
        'v0.3.1',
        'ghcr.io/danield2g/clawbuddy',
      ),
    ).toBe('ghcr.io/danield2g/clawbuddy:0.3.1')
  })

  test('falls back to the default image when the service does not expose one yet', () => {
    expect(buildTargetImage(null, 'v0.3.1', 'ghcr.io/danield2g/clawbuddy')).toBe(
      'ghcr.io/danield2g/clawbuddy:0.3.1',
    )
  })
})
