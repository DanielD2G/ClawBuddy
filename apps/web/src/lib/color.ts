/** Lookup map of preset workspace hex colors → OKLCH values */
const HEX_TO_OKLCH: Record<string, string> = {
  '#6366f1': 'oklch(0.541 0.222 264.1)',
  '#8b5cf6': 'oklch(0.541 0.222 283.1)',
  '#ec4899': 'oklch(0.622 0.227 349.8)',
  '#f43f5e': 'oklch(0.627 0.257 17.6)',
  '#f97316': 'oklch(0.702 0.209 41.1)',
  '#eab308': 'oklch(0.795 0.184 86.1)',
  '#22c55e': 'oklch(0.723 0.191 149.6)',
  '#14b8a6': 'oklch(0.704 0.14 181.8)',
  '#06b6d4': 'oklch(0.715 0.143 215.2)',
  '#3b82f6': 'oklch(0.623 0.214 259.8)',
}

/**
 * Convert a hex color to an OKLCH string suitable for the --brand CSS variable.
 * Uses a lookup table for known preset colors, falls back to the raw hex value.
 */
export function hexToOklch(hex: string): string {
  return HEX_TO_OKLCH[hex.toLowerCase()] ?? hex
}
