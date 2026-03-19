const PRIVATE_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/,
  /^\[fd/i,
  /^\[fe80:/i,
]

export function isPrivateHost(hostname: string): boolean {
  return PRIVATE_PATTERNS.some((p) => p.test(hostname))
}
