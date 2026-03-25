import type { LatestReleaseInfo, ReleaseManifest } from './update.types.js'

const UPDATE_CACHE_TTL_MS = 15 * 60 * 1000
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/DanielD2G/ClawBuddy/releases/latest'
const GITHUB_RELEASE_BY_TAG_URL = 'https://api.github.com/repos/DanielD2G/ClawBuddy/releases/tags/'
const MANIFEST_ASSET_NAMES = ['clawbuddy-release-manifest.json', 'release-manifest.json']

let releaseCache: { fetchedAt: number; value: LatestReleaseInfo | null } | null = null
let releasePromise: Promise<LatestReleaseInfo | null> | null = null

export function normalizeVersion(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = value.trim().replace(/^refs\/tags\//, '')
  return cleaned.startsWith('v') ? cleaned : `v${cleaned}`
}

export function parseSemver(value: string | null | undefined): [number, number, number] | null {
  const normalized = normalizeVersion(value)
  if (!normalized) return null
  const match = normalized.match(/^v(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isReleaseNewer(
  currentVersion: string | null | undefined,
  targetVersion: string,
): boolean {
  const current = parseSemver(currentVersion)
  const target = parseSemver(targetVersion)
  if (!target) return false
  if (!current) return true

  for (let index = 0; index < 3; index += 1) {
    if (target[index] > current[index]) return true
    if (target[index] < current[index]) return false
  }

  return false
}

export function isVersionAtLeast(
  currentVersion: string | null | undefined,
  minimumVersion: string | null | undefined,
): boolean {
  if (!minimumVersion) return true

  const current = parseSemver(currentVersion)
  const minimum = parseSemver(minimumVersion)
  if (!minimum) return true
  if (!current) return false

  for (let index = 0; index < 3; index += 1) {
    if (current[index] > minimum[index]) return true
    if (current[index] < minimum[index]) return false
  }

  return true
}

function normalizeDigest(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  return value.startsWith('sha256:') ? value : `sha256:${value}`
}

export function buildFallbackManifest(
  version: string,
  url: string | null | undefined,
): ReleaseManifest {
  return {
    version,
    appImage: `ghcr.io/danield2g/clawbuddy:${version.replace(/^v/, '')}`,
    imageDigest: null,
    migration: {
      mode: 'none',
      rollbackSafe: true,
    },
    deliveryMode: 'integrated',
    minUpdaterVersion: null,
    notesUrl: url ?? null,
  }
}

function parseManifest(raw: unknown, fallbackVersion: string, notesUrl: string): ReleaseManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return buildFallbackManifest(fallbackVersion, notesUrl)
  }

  const source = raw as Record<string, unknown>
  const deliveryMode =
    source.deliveryMode === 'maintenance-required' ? 'maintenance-required' : 'integrated'
  const migrationSource =
    source.migration && typeof source.migration === 'object' && !Array.isArray(source.migration)
      ? (source.migration as Record<string, unknown>)
      : {}
  const version = normalizeVersion(
    typeof source.version === 'string' ? source.version : fallbackVersion,
  )

  return {
    version: version ?? fallbackVersion,
    appImage:
      typeof source.appImage === 'string' && source.appImage.trim().length > 0
        ? source.appImage.trim()
        : buildFallbackManifest(fallbackVersion, notesUrl).appImage,
    imageDigest: normalizeDigest(
      typeof source.imageDigest === 'string' ? source.imageDigest.trim() : null,
    ),
    migration: {
      mode: migrationSource.mode === 'prisma-db-push' ? 'prisma-db-push' : 'none',
      rollbackSafe: migrationSource.rollbackSafe !== false,
    },
    deliveryMode,
    minUpdaterVersion: normalizeVersion(
      typeof source.minUpdaterVersion === 'string' ? source.minUpdaterVersion : null,
    ),
    notesUrl:
      typeof source.notesUrl === 'string' && source.notesUrl.trim().length > 0
        ? source.notesUrl.trim()
        : notesUrl,
  }
}

async function fetchManifest(assetUrl: string, fallbackVersion: string, notesUrl: string) {
  const manifestResponse = await fetch(assetUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ClawBuddy-Updater',
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!manifestResponse.ok) {
    throw new Error(`Manifest fetch failed with ${manifestResponse.status}`)
  }

  return parseManifest(await manifestResponse.json(), fallbackVersion, notesUrl)
}

interface GitHubReleaseResponse {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  assets?: Array<{ name?: string; browser_download_url?: string }>
}

function getGitHubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ClawBuddy-Updater',
  }
}

async function fetchGitHubRelease(url: string) {
  const response = await fetch(url, {
    headers: getGitHubHeaders(),
    signal: AbortSignal.timeout(10_000),
  })

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`GitHub release lookup failed with ${response.status}`)
  }

  return (await response.json()) as GitHubReleaseResponse
}

async function parseGitHubRelease(
  json: GitHubReleaseResponse | null,
): Promise<LatestReleaseInfo | null> {
  if (!json?.tag_name || !json.html_url || !json.published_at) {
    return null
  }

  const version = normalizeVersion(json.tag_name)
  if (!version) {
    return null
  }

  const manifestAsset = json.assets?.find((asset) =>
    asset.name ? MANIFEST_ASSET_NAMES.includes(asset.name) : false,
  )
  const manifest =
    manifestAsset?.browser_download_url != null
      ? await fetchManifest(manifestAsset.browser_download_url, version, json.html_url)
      : buildFallbackManifest(version, json.html_url)

  return {
    version,
    name: json.name?.trim() || version,
    body: json.body?.trim() || '',
    url: json.html_url,
    publishedAt: json.published_at,
    manifest,
  }
}

export async function fetchLatestRelease(force = false): Promise<LatestReleaseInfo | null> {
  if (!force && releaseCache && Date.now() - releaseCache.fetchedAt < UPDATE_CACHE_TTL_MS) {
    return releaseCache.value
  }

  if (!force && releasePromise) {
    return releasePromise
  }

  releasePromise = (async () => {
    const latest = await parseGitHubRelease(await fetchGitHubRelease(GITHUB_RELEASES_URL))

    releaseCache = { fetchedAt: Date.now(), value: latest }
    return latest
  })()

  try {
    return await releasePromise
  } finally {
    releasePromise = null
  }
}

export function clearReleaseCache() {
  releaseCache = null
}

export async function fetchReleaseByVersion(version: string): Promise<LatestReleaseInfo | null> {
  const normalized = normalizeVersion(version)
  if (!normalized) {
    return null
  }

  return parseGitHubRelease(
    await fetchGitHubRelease(`${GITHUB_RELEASE_BY_TAG_URL}${encodeURIComponent(normalized)}`),
  )
}
