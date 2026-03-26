import { describe, expect, test } from 'vitest'
import { isPrivateHost } from './url-safety.js'

describe('isPrivateHost', () => {
  // ── Localhost ─────────────────────────────────────────────────────

  test('blocks localhost', () => {
    expect(isPrivateHost('localhost')).toBe(true)
  })

  test('blocks localhost case-insensitively', () => {
    expect(isPrivateHost('LOCALHOST')).toBe(true)
    expect(isPrivateHost('Localhost')).toBe(true)
  })

  // ── Loopback addresses ────────────────────────────────────────────

  test('blocks 127.0.0.1 (IPv4 loopback)', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true)
  })

  test('blocks 127.x.x.x range', () => {
    expect(isPrivateHost('127.0.0.2')).toBe(true)
    expect(isPrivateHost('127.255.255.255')).toBe(true)
  })

  test('blocks [::1] (IPv6 loopback)', () => {
    expect(isPrivateHost('[::1]')).toBe(true)
  })

  // ── 10.x.x.x private range ───────────────────────────────────────

  test('blocks 10.0.0.0/8 private range', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true)
    expect(isPrivateHost('10.255.255.255')).toBe(true)
    expect(isPrivateHost('10.10.10.10')).toBe(true)
  })

  // ── 172.16-31.x.x private range ──────────────────────────────────

  test('blocks 172.16.0.0/12 private range', () => {
    expect(isPrivateHost('172.16.0.1')).toBe(true)
    expect(isPrivateHost('172.20.0.1')).toBe(true)
    expect(isPrivateHost('172.31.255.255')).toBe(true)
  })

  test('allows 172.15.x.x (outside private range)', () => {
    expect(isPrivateHost('172.15.0.1')).toBe(false)
  })

  test('allows 172.32.x.x (outside private range)', () => {
    expect(isPrivateHost('172.32.0.1')).toBe(false)
  })

  // ── 192.168.x.x private range ────────────────────────────────────

  test('blocks 192.168.0.0/16 private range', () => {
    expect(isPrivateHost('192.168.0.1')).toBe(true)
    expect(isPrivateHost('192.168.1.1')).toBe(true)
    expect(isPrivateHost('192.168.255.255')).toBe(true)
  })

  // ── 169.254.x.x link-local range ─────────────────────────────────

  test('blocks 169.254.x.x link-local range', () => {
    expect(isPrivateHost('169.254.0.1')).toBe(true)
    expect(isPrivateHost('169.254.169.254')).toBe(true) // AWS metadata
  })

  // ── 0.x.x.x range ────────────────────────────────────────────────

  test('blocks 0.x.x.x range', () => {
    expect(isPrivateHost('0.0.0.0')).toBe(true)
    expect(isPrivateHost('0.1.2.3')).toBe(true)
  })

  // ── IPv6 private ranges ───────────────────────────────────────────

  test('blocks [fd...] IPv6 unique local addresses', () => {
    expect(isPrivateHost('[fd00::1]')).toBe(true)
    expect(isPrivateHost('[fdab:cdef::1]')).toBe(true)
  })

  test('blocks [fe80:...] IPv6 link-local addresses', () => {
    expect(isPrivateHost('[fe80::1]')).toBe(true)
    expect(isPrivateHost('[fe80:abcd::1]')).toBe(true)
  })

  // ── Public hosts (should be allowed) ──────────────────────────────

  test('allows public hostnames', () => {
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isPrivateHost('google.com')).toBe(false)
    expect(isPrivateHost('api.github.com')).toBe(false)
  })

  test('allows public IP addresses', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false)
    expect(isPrivateHost('1.1.1.1')).toBe(false)
    expect(isPrivateHost('203.0.113.1')).toBe(false)
  })

  // ── Edge cases ────────────────────────────────────────────────────

  test('handles empty string', () => {
    expect(isPrivateHost('')).toBe(false)
  })

  test('handles string with only spaces', () => {
    expect(isPrivateHost('   ')).toBe(false)
  })

  test('does not match partial hostnames containing "localhost"', () => {
    // 'localhost' pattern uses ^...$ anchors, so substrings should not match
    expect(isPrivateHost('notlocalhost')).toBe(false)
    expect(isPrivateHost('localhost.example.com')).toBe(false)
  })
})
