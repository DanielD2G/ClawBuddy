import { describe, expect, test } from 'vitest'
import { encrypt, decrypt } from './crypto.service.js'

describe('crypto.service', () => {
  // ── Round-trip encryption ─────────────────────────────────────────

  test('encrypt then decrypt returns the original plaintext', () => {
    const plaintext = 'sk-abc123-my-api-key'
    const encrypted = encrypt(plaintext)
    const decrypted = decrypt(encrypted)
    expect(decrypted).toBe(plaintext)
  })

  test('encrypted output has three colon-separated base64 parts (iv:tag:data)', () => {
    const encrypted = encrypt('hello')
    const parts = encrypted.split(':')
    expect(parts).toHaveLength(3)
    // Each part should be valid base64
    for (const part of parts) {
      expect(() => Buffer.from(part, 'base64')).not.toThrow()
      expect(part.length).toBeGreaterThan(0)
    }
  })

  // ── Different inputs ──────────────────────────────────────────────

  test('handles empty string', () => {
    const encrypted = encrypt('')
    const decrypted = decrypt(encrypted)
    expect(decrypted).toBe('')
  })

  test('handles long string', () => {
    const longText = 'A'.repeat(10_000)
    const encrypted = encrypt(longText)
    const decrypted = decrypt(encrypted)
    expect(decrypted).toBe(longText)
  })

  test('handles special characters', () => {
    const special = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/\\`~\n\t\r'
    const encrypted = encrypt(special)
    const decrypted = decrypt(encrypted)
    expect(decrypted).toBe(special)
  })

  test('handles unicode and emoji characters', () => {
    const unicode = 'Hello \u4e16\u754c \ud83d\ude80 \u00e9\u00e0\u00fc\u00f1 \u0410\u0411\u0412'
    const encrypted = encrypt(unicode)
    const decrypted = decrypt(encrypted)
    expect(decrypted).toBe(unicode)
  })

  test('handles JSON string content', () => {
    const json = JSON.stringify({ key: 'value', nested: { arr: [1, 2, 3] } })
    const encrypted = encrypt(json)
    const decrypted = decrypt(encrypted)
    expect(decrypted).toBe(json)
  })

  // ── Random IV means different ciphertext each time ────────────────

  test('encrypting the same plaintext twice produces different ciphertext (random IV)', () => {
    const plaintext = 'same-input-different-output'
    const encrypted1 = encrypt(plaintext)
    const encrypted2 = encrypt(plaintext)
    expect(encrypted1).not.toBe(encrypted2)

    // But both decrypt to the same value
    expect(decrypt(encrypted1)).toBe(plaintext)
    expect(decrypt(encrypted2)).toBe(plaintext)
  })

  // ── Decryption with tampered data fails ───────────────────────────

  test('decryption fails when the auth tag is tampered with', () => {
    const encrypted = encrypt('secret')
    const parts = encrypted.split(':')
    // Tamper with the auth tag (second part)
    const tagBuf = Buffer.from(parts[1], 'base64')
    tagBuf[0] = tagBuf[0] ^ 0xff
    parts[1] = tagBuf.toString('base64')
    const tampered = parts.join(':')

    expect(() => decrypt(tampered)).toThrow()
  })

  test('decryption fails when the IV is tampered with', () => {
    const encrypted = encrypt('secret')
    const parts = encrypted.split(':')
    // Tamper with the IV (first part)
    const ivBuf = Buffer.from(parts[0], 'base64')
    ivBuf[0] = ivBuf[0] ^ 0xff
    parts[0] = ivBuf.toString('base64')
    const tampered = parts.join(':')

    expect(() => decrypt(tampered)).toThrow()
  })

  test('decryption fails when the encrypted data is tampered with', () => {
    const encrypted = encrypt('secret')
    const parts = encrypted.split(':')
    // Tamper with the encrypted data (third part)
    const dataBuf = Buffer.from(parts[2], 'base64')
    dataBuf[0] = dataBuf[0] ^ 0xff
    parts[2] = dataBuf.toString('base64')
    const tampered = parts.join(':')

    expect(() => decrypt(tampered)).toThrow()
  })

  test('decryption fails with completely invalid input', () => {
    expect(() => decrypt('not:valid:data')).toThrow()
  })
})
