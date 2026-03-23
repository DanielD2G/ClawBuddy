import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { env } from '../env.js'
import { getBuildInfo } from '../lib/build-info.js'
import { settingsService } from './settings.service.js'
import { updateLauncherService } from './update/update.launcher.js'
import {
  clearReleaseCache,
  fetchLatestRelease,
  isReleaseNewer,
  isVersionAtLeast,
  normalizeVersion,
} from './update/update.manifest.js'
import {
  getInstallSupport,
  getManagedServiceByRole,
  extractVersionFromImage,
} from './update/update.swarm.js'
import { serializeControllerRun } from './update/update.controller.js'
import type {
  LatestReleaseInfo,
  ReleaseManifest,
  SerializedUpdateRun,
  UpdateEligibility,
} from './update/update.types.js'

const UPDATE_FORCE = ['true', '1', 'yes'].includes(env.UPDATE_FORCE.toLowerCase())
const ACTIVE_RUN_STATUSES = ['queued', 'running'] as const
const TERMINAL_RUN_STATUSES = ['succeeded', 'rolled_back', 'failed'] as const
const RUN_EVENT_LIMIT = 25

type UpdateRunRow = Awaited<
  ReturnType<
    typeof prisma.appUpdateRun.findFirst<{
      include: { events: { orderBy: { createdAt: 'asc' }; take: typeof RUN_EVENT_LIMIT } }
    }>
  >
>

function manifestToJson(manifest: ReleaseManifest): Prisma.InputJsonValue {
  return manifest as unknown as Prisma.InputJsonValue
}

async function findRun(where: Prisma.AppUpdateRunWhereInput) {
  return prisma.appUpdateRun.findFirst({
    where,
    include: {
      events: {
        orderBy: { createdAt: 'asc' },
        take: RUN_EVENT_LIMIT,
      },
    },
    orderBy: { createdAt: 'desc' },
  })
}

async function getCurrentRun() {
  return findRun({
    status: { in: [...ACTIVE_RUN_STATUSES] },
  })
}

async function getLastTerminalRun() {
  return findRun({
    status: { in: [...TERMINAL_RUN_STATUSES] },
  })
}

function serializeRun(run: UpdateRunRow | null): SerializedUpdateRun | null {
  if (!run) return null
  return serializeControllerRun(run)
}

function getCurrentVersionFromBuild() {
  const build = getBuildInfo()
  const version = normalizeVersion(build.version)
  return version && version !== 'vdev' ? version : null
}

async function getCurrentInstalledVersion(): Promise<string> {
  const buildVersion = getCurrentVersionFromBuild()
  if (buildVersion) return buildVersion

  const appService = await getManagedServiceByRole('app')
  const imageVersion = extractVersionFromImage(appService?.Spec?.TaskTemplate?.ContainerSpec?.Image)
  return imageVersion && imageVersion !== 'vlatest' ? imageVersion : 'legacy/latest'
}

function buildEligibility(
  latestRelease: LatestReleaseInfo | null,
  currentVersion: string,
  support: Awaited<ReturnType<typeof getInstallSupport>>,
): UpdateEligibility {
  if (!latestRelease) {
    return {
      supported: support.supported || UPDATE_FORCE,
      canUpdate: false,
      reason: 'No stable GitHub release is available right now',
      deliveryMode: 'maintenance-required',
      minUpdaterVersion: null,
    }
  }

  if (!support.supported && !UPDATE_FORCE) {
    return {
      supported: false,
      canUpdate: false,
      reason: support.reason,
      deliveryMode: latestRelease.manifest.deliveryMode,
      minUpdaterVersion: latestRelease.manifest.minUpdaterVersion,
    }
  }

  if (latestRelease.manifest.deliveryMode !== 'integrated') {
    return {
      supported: true,
      canUpdate: false,
      reason: 'This release requires the maintenance update path',
      deliveryMode: latestRelease.manifest.deliveryMode,
      minUpdaterVersion: latestRelease.manifest.minUpdaterVersion,
    }
  }

  const updaterVersion = normalizeVersion(getBuildInfo().version)
  if (!isVersionAtLeast(updaterVersion, latestRelease.manifest.minUpdaterVersion)) {
    return {
      supported: true,
      canUpdate: false,
      reason: `This release requires updater ${latestRelease.manifest.minUpdaterVersion}`,
      deliveryMode: latestRelease.manifest.deliveryMode,
      minUpdaterVersion: latestRelease.manifest.minUpdaterVersion,
    }
  }

  if (
    latestRelease.manifest.migration.mode !== 'none' &&
    latestRelease.manifest.migration.rollbackSafe !== true
  ) {
    return {
      supported: true,
      canUpdate: false,
      reason: 'This release declares a non-rollback-safe migration',
      deliveryMode: latestRelease.manifest.deliveryMode,
      minUpdaterVersion: latestRelease.manifest.minUpdaterVersion,
    }
  }

  if (!isReleaseNewer(currentVersion, latestRelease.version)) {
    return {
      supported: true,
      canUpdate: false,
      reason: null,
      deliveryMode: latestRelease.manifest.deliveryMode,
      minUpdaterVersion: latestRelease.manifest.minUpdaterVersion,
    }
  }

  return {
    supported: true,
    canUpdate: true,
    reason: null,
    deliveryMode: latestRelease.manifest.deliveryMode,
    minUpdaterVersion: latestRelease.manifest.minUpdaterVersion,
  }
}

interface UpdateOverview {
  supported: boolean
  supportReason: string | null
  currentVersion: string
  currentBuild: ReturnType<typeof getBuildInfo>
  latestRelease: LatestReleaseInfo | null
  dismissedVersion: string | null
  eligibility: UpdateEligibility
  currentRun: SerializedUpdateRun | null
  lastTerminalRun: SerializedUpdateRun | null
  forceUpdate: boolean
}

async function createRunFromRelease(latestRelease: LatestReleaseInfo, currentVersion: string) {
  return prisma.appUpdateRun.create({
    data: {
      status: 'queued',
      stage: 'queued',
      message: 'Queued for the durable updater controller',
      currentVersion,
      targetVersion: latestRelease.version,
      targetReleaseName: latestRelease.name,
      targetReleaseUrl: latestRelease.url,
      targetPublishedAt: new Date(latestRelease.publishedAt),
      targetReleaseNotes: latestRelease.body,
      deliveryMode: latestRelease.manifest.deliveryMode,
      serviceRole: 'app',
      manifest: manifestToJson(latestRelease.manifest),
      targetImage: latestRelease.manifest.appImage,
      targetImageDigest: latestRelease.manifest.imageDigest,
      startedAt: new Date(),
    },
    include: {
      events: true,
    },
  })
}

export const updateService = {
  async getOverview(forceReleaseRefresh = false): Promise<UpdateOverview> {
    let latestRelease: LatestReleaseInfo | null = null
    try {
      latestRelease = await fetchLatestRelease(forceReleaseRefresh)
    } catch (error) {
      console.error(
        '[Update] Failed to fetch latest release:',
        error instanceof Error ? error.message : String(error),
      )
    }

    const [support, currentVersion, currentRun, lastTerminalRun] = await Promise.all([
      getInstallSupport(),
      getCurrentInstalledVersion(),
      getCurrentRun(),
      getLastTerminalRun(),
    ])

    const eligibility = buildEligibility(latestRelease, currentVersion, support)

    return {
      supported: support.supported || UPDATE_FORCE,
      supportReason: support.supported || UPDATE_FORCE ? null : support.reason,
      currentVersion,
      currentBuild: getBuildInfo(),
      latestRelease,
      dismissedVersion: await settingsService.getDismissedUpdateVersion(),
      eligibility,
      currentRun: serializeRun(currentRun),
      lastTerminalRun: serializeRun(lastTerminalRun),
      forceUpdate: UPDATE_FORCE,
    }
  },

  async forceCheck() {
    clearReleaseCache()
    return this.getOverview(true)
  },

  async getRun(runId: string) {
    const run = await prisma.appUpdateRun.findUnique({
      where: { id: runId },
      include: {
        events: {
          orderBy: { createdAt: 'asc' },
          take: RUN_EVENT_LIMIT,
        },
      },
    })

    return serializeRun(run)
  },

  async createRunForLatestRelease() {
    const [support, latestRelease, currentVersion, existingRun] = await Promise.all([
      getInstallSupport(),
      fetchLatestRelease(true),
      getCurrentInstalledVersion(),
      getCurrentRun(),
    ])

    const eligibility = buildEligibility(latestRelease, currentVersion, support)
    if (!latestRelease) {
      throw new Error('No stable GitHub release is available right now')
    }

    if (!eligibility.canUpdate) {
      throw new Error(eligibility.reason || 'This installation cannot perform an integrated update')
    }

    if (existingRun) {
      if (existingRun.targetVersion !== latestRelease.version) {
        throw new Error(`Another update is already in progress (${existingRun.targetVersion})`)
      }

      return serializeRun(existingRun)
    }

    await prisma.appUpdateRun.updateMany({
      where: { status: 'failed', targetVersion: latestRelease.version },
      data: { message: 'Superseded by retry' },
    })

    await settingsService.setDismissedUpdateVersion(null)
    const run = await createRunFromRelease(latestRelease, currentVersion)
    await updateLauncherService.ensureRunning(`create-run-${run.id}`)
    return serializeRun(run)
  },

  async retryRun(runId: string) {
    const existing = await prisma.appUpdateRun.findUniqueOrThrow({
      where: { id: runId },
    })

    if (
      !TERMINAL_RUN_STATUSES.includes(existing.status as (typeof TERMINAL_RUN_STATUSES)[number])
    ) {
      throw new Error('Only failed, rolled back, or completed runs can be retried')
    }

    const activeRun = await getCurrentRun()
    if (activeRun) {
      throw new Error(`Another update is already in progress (${activeRun.targetVersion})`)
    }

    const manifest = existing.manifest as Prisma.InputJsonValue | null
    if (!manifest) {
      throw new Error('This run cannot be retried because its manifest snapshot is missing')
    }

    const retried = await prisma.appUpdateRun.create({
      data: {
        status: 'queued',
        stage: 'queued',
        message: `Retry queued for ${existing.targetVersion}`,
        currentVersion: await getCurrentInstalledVersion(),
        targetVersion: existing.targetVersion,
        targetReleaseName: existing.targetReleaseName,
        targetReleaseUrl: existing.targetReleaseUrl,
        targetPublishedAt: existing.targetPublishedAt,
        targetReleaseNotes: existing.targetReleaseNotes,
        deliveryMode: existing.deliveryMode,
        serviceRole: existing.serviceRole,
        manifest,
        targetImage: existing.targetImage,
        targetImageDigest: existing.targetImageDigest,
      },
      include: {
        events: true,
      },
    })

    await updateLauncherService.ensureRunning(`retry-run-${retried.id}`)
    return serializeRun(retried)
  },

  async acceptLatestRelease() {
    await this.createRunForLatestRelease()
    return this.getOverview(true)
  },

  async declineLatestRelease() {
    const latestRelease = await fetchLatestRelease(true)
    if (!latestRelease) {
      throw new Error('No stable GitHub release is available right now')
    }

    await settingsService.setDismissedUpdateVersion(latestRelease.version)
    return latestRelease.version
  },

  async reconcileActiveRun() {
    return getCurrentRun()
  },
}

export type { UpdateOverview }
