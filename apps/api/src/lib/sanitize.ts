/** Replace characters that are unsafe for storage keys / file paths. */
export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Strip null bytes and control characters that PostgreSQL TEXT columns reject.
 * This is the canonical sanitizer for any text destined for DB storage.
 */
export function stripNullBytes(s: string): string {
  // eslint-disable-next-line no-control-regex
  let result = s.replace(/\x00/g, '')
  result = result.replace(/\\u0000/g, '')
  // eslint-disable-next-line no-control-regex
  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  return result
}

/** Nullable wrapper — returns null for falsy input, stripped string otherwise. */
export function stripNullBytesOrNull(text: string | null | undefined): string | null {
  if (!text) return null
  return stripNullBytes(text)
}

/**
 * Replace lone surrogates with U+FFFD to prevent JSON serialization errors.
 * Handles a different concern than stripNullBytes — use for content from
 * external files that may contain malformed Unicode.
 */
export function sanitizeSurrogates(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < input.length ? input.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i] + input[i + 1]
        i++
      } else {
        out += '\ufffd'
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\ufffd'
    } else {
      out += input[i]
    }
  }
  return out
}
