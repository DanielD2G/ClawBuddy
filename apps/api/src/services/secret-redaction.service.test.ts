import { describe, expect, test } from 'bun:test'

process.env.DATABASE_URL ??= 'postgresql://clawbuddy:clawbuddy@localhost:5432/clawbuddy'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.QDRANT_URL ??= 'http://localhost:6333'
process.env.MINIO_ENDPOINT ??= 'http://localhost:9000'
process.env.MINIO_ACCESS_KEY ??= 'minioadmin'
process.env.MINIO_SECRET_KEY ??= 'minioadmin'
process.env.MINIO_BUCKET ??= 'clawbuddy'
process.env.ENCRYPTION_SECRET ??= 'super-secret-key-123'

const {
  SECRET_REDACTION_MASK,
  extractStructuredSecretValues,
  secretRedactionService,
} = await import('./secret-redaction.service.js')

const secretValues = [
  'ghp_test_secret_for_redaction',
  'refresh_token_123',
  'aws_secret_value',
]

const inventory = {
  workspaceId: 'ws_test',
  enabled: true,
  secretValues,
  secretPattern: new RegExp(secretValues.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'),
  aliases: ['GH_TOKEN'],
  references: [{ alias: 'GH_TOKEN', transport: 'env' as const }],
}

const disabledInventory = {
  workspaceId: 'ws_disabled',
  enabled: false,
  secretValues: ['ghp_test_secret_for_redaction'],
  secretPattern: null,
  aliases: ['GH_TOKEN'],
  references: [{ alias: 'GH_TOKEN', transport: 'env' as const }],
}

describe('secretRedactionService', () => {
  test('redacts exact secret values in plain text and serialized JSON', () => {
    expect(
      secretRedactionService.redactText('token=ghp_test_secret_for_redaction', inventory),
    ).toBe(`token=${SECRET_REDACTION_MASK}`)

    expect(
      secretRedactionService.redactSerializedText('{"token":"ghp_test_secret_for_redaction"}', inventory),
    ).toBe(`{"token":"${SECRET_REDACTION_MASK}"}`)
  })

  test('extracts nested values from structured secret blobs', () => {
    const values = extractStructuredSecretValues(JSON.stringify({
      refresh_token: 'refresh_token_123',
      nested: { secret: 'aws_secret_value' },
    }))

    expect(values).toContain('refresh_token_123')
    expect(values).toContain('aws_secret_value')
  })

  test('keeps allowed aliases visible while masking assigned values', () => {
    expect(
      secretRedactionService.redactText('Use GH_TOKEN from env', inventory),
    ).toBe('Use GH_TOKEN from env')

    expect(
      secretRedactionService.redactText('export GH_TOKEN=ghp_test_secret_for_redaction', inventory),
    ).toBe(`export GH_TOKEN=${SECRET_REDACTION_MASK}`)
  })

  test('does not corrupt screenshot payloads when redacting public objects', () => {
    const result = secretRedactionService.redactForPublicStorage({
      screenshot: 'base64-image-data',
      output: 'ghp_test_secret_for_redaction',
    }, inventory)

    expect(result.screenshot).toBe('base64-image-data')
    expect(result.output).toBe(SECRET_REDACTION_MASK)
  })

  test('is a no-op when redaction is disabled for the workspace', () => {
    expect(
      secretRedactionService.redactText('token=ghp_test_secret_for_redaction', disabledInventory),
    ).toBe('token=ghp_test_secret_for_redaction')

    expect(
      secretRedactionService.redactForPublicStorage({ output: 'ghp_test_secret_for_redaction' }, disabledInventory),
    ).toEqual({ output: 'ghp_test_secret_for_redaction' })
  })

  test('passes SSE payloads through unchanged when redaction is disabled', () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    const emit = secretRedactionService.createRedactedEmit((event, data) => {
      events.push({ event, data })
    }, disabledInventory)

    emit('content', { text: 'ghp_test_secret_for_redaction' })

    expect(events).toEqual([
      { event: 'content', data: { text: 'ghp_test_secret_for_redaction' } },
    ])
  })
})
