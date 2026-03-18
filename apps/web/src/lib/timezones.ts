/**
 * Cached grouped timezones — computed once since IANA list is static.
 */
let cachedGrouped: Record<string, string[]> | null = null

export function getGroupedTimezones(): Record<string, string[]> {
  if (!cachedGrouped) {
    const timezones = Intl.supportedValuesOf('timeZone')
    const grouped: Record<string, string[]> = {}
    for (const tz of timezones) {
      const [region] = tz.split('/')
      if (!grouped[region]) grouped[region] = []
      grouped[region].push(tz)
    }
    cachedGrouped = grouped
  }
  return cachedGrouped
}

/**
 * Cached formatted labels — each creates an Intl.DateTimeFormat, so cache results.
 */
const formatCache = new Map<string, string>()

export function formatTimezone(tz: string): string {
  const cached = formatCache.get(tz)
  if (cached) return cached

  const city = tz.includes('/') ? tz.split('/').slice(1).join('/').replace(/_/g, ' ') : tz
  let label: string
  try {
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find(p => p.type === 'timeZoneName')?.value ?? ''
    label = `${city} (${offset})`
  } catch {
    label = city
  }
  formatCache.set(tz, label)
  return label
}
