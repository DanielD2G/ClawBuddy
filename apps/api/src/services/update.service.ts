import Docker from 'dockerode'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { env } from '../env.js'
import { getBuildInfo } from '../lib/build-info.js'
import { settingsService } from './settings.service.js'

const UPDATE_FORCE = ['true', '1', 'yes'].includes(env.UPDATE_FORCE.toLowerCase())

type UpdateRunRecord = Awaited<ReturnType<typeof prisma.appUpdateRun.findUniqueOrThrow>>
type StepStatus = 'pending' | 'running' | 'done' | 'error'
type RunStatus = 'pending' | 'running' | 'completed' | 'failed'
type UpdatePhase = 'pending' | 'pulling-images' | 'waiting-for-api' | 'completed' | 'failed'

interface LatestReleaseInfo {
  version: string
  name: string
  body: string
  url: string
  publishedAt: string
}

interface StepProgress {
  status: StepStatus
  progress: string
  error?: string
}

interface UpdateProgress {
  pullApi: StepProgress
  apiDeploy: StepProgress
  observed: {
    apiVersion: string | null
    apiUpdateState: string | null
    apiUpdateMessage: string | null
  }
}

interface UpdateOverview {
  supported: boolean
  supportReason: string | null
  currentVersion: string
  currentBuild: ReturnType<typeof getBuildInfo>
  latestRelease: LatestReleaseInfo | null
  dismissedVersion: string | null
  activeRun: ReturnType<typeof serializeRun> | null
  forceUpdate: boolean
}

interface SwarmServiceInfo {
  ID: string
  Version?: { Index?: number }
  Spec?: {
    TaskTemplate?: {
      ContainerSpec?: {
        Image?: string
      }
      ForceUpdate?: number
    }
    UpdateConfig?: {
      Parallelism?: number
      Delay?: number
      FailureAction?: string
      Monitor?: number
      MaxFailureRatio?: number
      Order?: string
    }
    RollbackConfig?: {
      Parallelism?: number
      Delay?: number
      FailureAction?: string
      Monitor?: number
      MaxFailureRatio?: number
      Order?: string
    }
  }
  UpdateStatus?: {
    State?: string
    Message?: string
    StartedAt?: string
    CompletedAt?: string
  }
  ServiceStatus?: {
    RunningTasks: number
    DesiredTasks: number
    CompletedTasks: number
  }
}

const docker = new Docker()
const dockerWithModem = docker as Docker & {
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (err: unknown, output: unknown[]) => void,
      onProgress?: (event: Record<string, unknown>) => void,
    ): void
  }
}

const UPDATE_CACHE_TTL_MS = 15 * 60 * 1000
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/DanielD2G/ClawBuddy/releases/latest'
const API_SERVICE_NAME = 'clawbuddy-app_api'
const STEP_DELAY_NS = 10_000_000_000
const STEP_MONITOR_NS = 30_000_000_000

let releaseCache: { fetchedAt: number; value: LatestReleaseInfo | null } | null = null
let releasePromise: Promise<LatestReleaseInfo | null> | null = null
const runningExecutors = new Set<string>()

function createStepProgress(progress: string): StepProgress {
  return { status: 'pending', progress }
}

function createDefaultProgress(): UpdateProgress {
  return {
    pullApi: createStepProgress('Waiting to pull the release image'),
    apiDeploy: createStepProgress('Waiting to deploy the unified service'),
    observed: {
      apiVersion: null,
      apiUpdateState: null,
      apiUpdateMessage: null,
    },
  }
}

function parseProgress(progress: unknown): UpdateProgress {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    return createDefaultProgress()
  }

  const source = progress as Partial<UpdateProgress>
  return {
    pullApi: {
      ...createDefaultProgress().pullApi,
      ...(source.pullApi ?? {}),
    },
    apiDeploy: {
      ...createDefaultProgress().apiDeploy,
      ...(source.apiDeploy ?? {}),
    },
    observed: {
      ...createDefaultProgress().observed,
      ...(source.observed ?? {}),
    },
  }
}

function serializeRun(run: UpdateRunRecord | null) {
  if (!run) return null

  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    currentVersion: run.currentVersion,
    targetVersion: run.targetVersion,
    targetReleaseName: run.targetReleaseName,
    targetReleaseUrl: run.targetReleaseUrl,
    targetPublishedAt: run.targetPublishedAt,
    targetReleaseNotes: run.targetReleaseNotes,
    phaseMessage: run.phaseMessage,
    progress: parseProgress(run.progress),
    error: run.error,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

function normalizeVersion(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = value.trim().replace(/^refs\/tags\//, '')
  return cleaned.startsWith('v') ? cleaned : `v${cleaned}`
}

function parseSemver(value: string | null | undefined): [number, number, number] | null {
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

  for (let i = 0; i < 3; i++) {
    if (target[i] > current[i]) return true
    if (target[i] < current[i]) return false
  }

  return false
}

export function extractVersionFromImage(image: string | null | undefined): string | null {
  if (!image) return null
  const withoutDigest = image.split('@')[0] ?? image
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')
  if (lastColon <= lastSlash) return null
  return normalizeVersion(withoutDigest.slice(lastColon + 1))
}

function toProgressError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function getServiceByName(name: string): Promise<SwarmServiceInfo | null> {
  const services = (await docker.listServices({
    filters: { name: [name] },
    status: true,
  })) as unknown as SwarmServiceInfo[]

  return services[0] ?? null
}

async function getInstallSupport() {
  try {
    const info = (await docker.info()) as { Swarm?: { LocalNodeState?: string } }
    if (info.Swarm?.LocalNodeState !== 'active') {
      return { supported: false, reason: 'Docker Swarm is not active' }
    }

    const apiService = await getServiceByName(API_SERVICE_NAME)

    if (!apiService) {
      return {
        supported: false,
        reason: 'Managed ClawBuddy Swarm API service was not found on this host',
      }
    }

    return { supported: true, reason: null, apiService }
  } catch (error) {
    return {
      supported: false,
      reason: `Docker is not reachable: ${toProgressError(error)}`,
    }
  }
}

function getCurrentVersionFromBuild() {
  const build = getBuildInfo()
  const version = normalizeVersion(build.version)
  return version && version !== 'vdev' ? version : null
}

async function getCurrentInstalledVersion(): Promise<string> {
  const buildVersion = getCurrentVersionFromBuild()
  if (buildVersion) return buildVersion

  const service = await getServiceByName(API_SERVICE_NAME)
  const imageVersion = extractVersionFromImage(service?.Spec?.TaskTemplate?.ContainerSpec?.Image)
  return imageVersion && imageVersion !== 'vlatest' ? imageVersion : 'legacy/latest'
}

function buildTargetImage(
  service: SwarmServiceInfo | null,
  version: string,
  fallbackImage: string,
) {
  // Docker image tags use semver without 'v' prefix (e.g. 0.1.6, not v0.1.6)
  const imageTag = version.replace(/^v/, '')
  const currentImage = service?.Spec?.TaskTemplate?.ContainerSpec?.Image ?? ''
  const withoutDigest = currentImage.split('@')[0] ?? currentImage
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')

  if (lastColon > lastSlash) {
    return `${withoutDigest.slice(0, lastColon)}:${imageTag}`
  }

  if (withoutDigest) {
    return `${withoutDigest}:${imageTag}`
  }

  return `${fallbackImage}:${imageTag}`
}

async function fetchLatestRelease(force = false): Promise<LatestReleaseInfo | null> {
  if (!force && releaseCache && Date.now() - releaseCache.fetchedAt < UPDATE_CACHE_TTL_MS) {
    return releaseCache.value
  }

  if (!force && releasePromise) {
    return releasePromise
  }

  releasePromise = (async () => {
    const res = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ClawBuddy-Updater',
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      throw new Error(`GitHub release lookup failed with ${res.status}`)
    }

    const json = (await res.json()) as {
      tag_name?: string
      name?: string
      body?: string
      html_url?: string
      published_at?: string
    }

    if (!json.tag_name || !json.html_url || !json.published_at) {
      return null
    }

    const latest = {
      version: normalizeVersion(json.tag_name)!,
      name: json.name?.trim() || normalizeVersion(json.tag_name)!,
      body: json.body?.trim() || '',
      url: json.html_url,
      publishedAt: json.published_at,
    }

    releaseCache = { fetchedAt: Date.now(), value: latest }
    return latest
  })()

  try {
    return await releasePromise
  } finally {
    releasePromise = null
  }
}

async function getActiveRun() {
  return prisma.appUpdateRun.findFirst({
    where: { status: { in: ['pending', 'running'] } },
    orderBy: { createdAt: 'desc' },
  })
}

async function getLatestVisibleRun() {
  const active = await getActiveRun()
  if (active) return active

  return prisma.appUpdateRun.findFirst({
    where: { status: 'failed' },
    orderBy: { createdAt: 'desc' },
  })
}

async function updateRun(
  id: string,
  data: Partial<{
    status: RunStatus
    phase: UpdatePhase
    phaseMessage: string | null
    progress: UpdateProgress
    error: string | null
    completedAt: Date | null
  }>,
) {
  return prisma.appUpdateRun.update({
    where: { id },
    data: {
      ...(data.status ? { status: data.status } : {}),
      ...(data.phase ? { phase: data.phase } : {}),
      ...(data.phaseMessage !== undefined ? { phaseMessage: data.phaseMessage } : {}),
      ...(data.progress ? { progress: data.progress as unknown as Prisma.InputJsonValue } : {}),
      ...(data.error !== undefined ? { error: data.error } : {}),
      ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
    },
  })
}

async function updateRunProgress(
  id: string,
  mutate: (progress: UpdateProgress) => UpdateProgress,
  extra?: Partial<{
    status: RunStatus
    phase: UpdatePhase
    phaseMessage: string | null
    error: string | null
    completedAt: Date | null
  }>,
) {
  const current = await prisma.appUpdateRun.findUniqueOrThrow({ where: { id } })
  const progress = mutate(parseProgress(current.progress))

  return updateRun(id, {
    progress,
    status: extra?.status,
    phase: extra?.phase,
    phaseMessage: extra?.phaseMessage,
    error: extra?.error,
    completedAt: extra?.completedAt,
  })
}

function configureServiceRollout(spec: SwarmServiceInfo['Spec']) {
  if (!spec?.TaskTemplate) {
    throw new Error('Swarm service task template is missing')
  }

  return {
    ...spec,
    UpdateConfig: {
      Parallelism: 1,
      Delay: spec.UpdateConfig?.Delay ?? STEP_DELAY_NS,
      FailureAction: 'rollback',
      Monitor: spec.UpdateConfig?.Monitor ?? STEP_MONITOR_NS,
      MaxFailureRatio: spec.UpdateConfig?.MaxFailureRatio ?? 0,
      Order: 'start-first',
    },
    RollbackConfig: {
      Parallelism: 1,
      Delay: spec.RollbackConfig?.Delay ?? STEP_DELAY_NS,
      FailureAction: spec.RollbackConfig?.FailureAction ?? 'pause',
      Monitor: spec.RollbackConfig?.Monitor ?? STEP_MONITOR_NS,
      MaxFailureRatio: spec.RollbackConfig?.MaxFailureRatio ?? 0,
      Order: spec.RollbackConfig?.Order ?? 'stop-first',
    },
  }
}

async function updateServiceImage(service: SwarmServiceInfo, image: string) {
  const versionIndex = service.Version?.Index
  if (versionIndex === undefined) {
    throw new Error('Swarm service version index is missing')
  }

  const spec = configureServiceRollout(service.Spec)
  const nextForceUpdate = (spec.TaskTemplate?.ForceUpdate ?? 0) + 1

  await docker.getService(service.ID).update({
    _query: { version: versionIndex },
    _body: {
      ...spec,
      TaskTemplate: {
        ...spec.TaskTemplate,
        ForceUpdate: nextForceUpdate,
        ContainerSpec: {
          ...spec.TaskTemplate?.ContainerSpec,
          Image: image,
        },
      },
    },
  } as Record<string, unknown>)
}

async function pullImage(image: string, onProgress: (progress: string) => Promise<void>) {
  const stream = await docker.pull(image)

  await new Promise<void>((resolve, reject) => {
    let lastMessage = ''
    let lastSentAt = 0

    dockerWithModem.modem.followProgress(
      stream,
      async (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      },
      (event) => {
        const message = [
          typeof event.status === 'string' ? event.status : 'Pulling image',
          typeof event.id === 'string' ? `(${event.id})` : '',
          event.progressDetail && typeof event.progressDetail === 'object'
            ? (() => {
                const current = Number(
                  (event.progressDetail as Record<string, unknown>).current ?? 0,
                )
                const total = Number((event.progressDetail as Record<string, unknown>).total ?? 0)
                if (current > 0 && total > 0) {
                  return `${Math.round((current / total) * 100)}%`
                }
                return ''
              })()
            : '',
        ]
          .filter(Boolean)
          .join(' ')

        const now = Date.now()
        if (!message || (message === lastMessage && now - lastSentAt < 300)) {
          return
        }

        lastMessage = message
        lastSentAt = now
        void onProgress(message)
      },
    )
  })
}

function getServiceFailure(service: SwarmServiceInfo | null) {
  const state = service?.UpdateStatus?.State ?? null
  if (!state) return null

  if (state.startsWith('rollback')) {
    return service?.UpdateStatus?.Message || 'Swarm rolled the service back'
  }

  if (state === 'paused') {
    return service?.UpdateStatus?.Message || 'Swarm paused the service update'
  }

  return null
}

async function refreshObservedProgress(run: UpdateRunRecord) {
  const apiService = await getServiceByName(API_SERVICE_NAME)

  return updateRunProgress(run.id, (progress) => ({
    ...progress,
    observed: {
      apiVersion: extractVersionFromImage(apiService?.Spec?.TaskTemplate?.ContainerSpec?.Image),
      apiUpdateState: apiService?.UpdateStatus?.State ?? null,
      apiUpdateMessage: apiService?.UpdateStatus?.Message ?? null,
    },
  }))
}

async function failRun(runId: string, message: string) {
  await updateRunProgress(
    runId,
    (progress) => ({
      ...progress,
      pullApi:
        progress.pullApi.status === 'running'
          ? { status: 'error', progress: progress.pullApi.progress, error: message }
          : progress.pullApi,
      apiDeploy:
        progress.apiDeploy.status === 'done'
          ? progress.apiDeploy
          : { status: 'error', progress: progress.apiDeploy.progress, error: message },
    }),
    {
      status: 'failed',
      phase: 'failed',
      phaseMessage: message,
      error: message,
      completedAt: new Date(),
    },
  )
}

async function runAcceptedUpdate(runId: string) {
  if (runningExecutors.has(runId)) return
  runningExecutors.add(runId)

  try {
    const support = await getInstallSupport()
    if (!support.supported || !support.apiService) {
      throw new Error(support.reason || 'This installation is not managed by ClawBuddy Swarm')
    }

    const run = await prisma.appUpdateRun.findUniqueOrThrow({ where: { id: runId } })
    const apiImage = buildTargetImage(
      support.apiService,
      run.targetVersion,
      'ghcr.io/danield2g/clawbuddy',
    )

    await updateRunProgress(
      runId,
      (progress) => ({
        ...progress,
        pullApi: { status: 'running', progress: `Pulling ${apiImage}` },
        apiDeploy: createStepProgress('Waiting for images to finish pulling'),
      }),
      {
        status: 'running',
        phase: 'pulling-images',
        phaseMessage: 'Pulling the release image',
      },
    )

    await pullImage(apiImage, async (progressLine) => {
      await updateRunProgress(runId, (progress) => ({
        ...progress,
        pullApi: { status: 'running', progress: progressLine },
      }))
    })

    await updateRunProgress(runId, (progress) => ({
      ...progress,
      pullApi: { status: 'done', progress: `Release image ready (${run.targetVersion})` },
      apiDeploy: { status: 'running', progress: `Deploying ClawBuddy ${run.targetVersion}` },
    }))

    await updateServiceImage(support.apiService, apiImage)

    await updateRunProgress(
      runId,
      (progress) => ({
        ...progress,
        apiDeploy: {
          status: 'running',
          progress: 'Update requested. Waiting for the new service task to become healthy',
        },
      }),
      {
        phase: 'waiting-for-api',
        phaseMessage: 'Waiting for the new service task to become healthy',
      },
    )
  } catch (error) {
    await failRun(runId, toProgressError(error))
  } finally {
    runningExecutors.delete(runId)
  }
}

async function reconcileWaitingForApi(run: UpdateRunRecord) {
  const apiService = await getServiceByName(API_SERVICE_NAME)

  const apiFailure = getServiceFailure(apiService)
  if (apiFailure) {
    await failRun(run.id, apiFailure)
    return prisma.appUpdateRun.findUniqueOrThrow({ where: { id: run.id } })
  }

  const currentBuildVersion = getCurrentVersionFromBuild()
  if (currentBuildVersion !== run.targetVersion) {
    await refreshObservedProgress(run)
    return prisma.appUpdateRun.findUniqueOrThrow({ where: { id: run.id } })
  }

  await updateRunProgress(
    run.id,
    (progress) => ({
      ...progress,
      apiDeploy: { status: 'done', progress: `ClawBuddy ${run.targetVersion} is healthy` },
    }),
    {
      status: 'completed',
      phase: 'completed',
      phaseMessage: `ClawBuddy ${run.targetVersion} is ready`,
      completedAt: new Date(),
      error: null,
    },
  )

  await refreshObservedProgress(run)
  return prisma.appUpdateRun.findUniqueOrThrow({ where: { id: run.id } })
}

export const updateService = {
  async getOverview(forceReleaseRefresh = false): Promise<UpdateOverview> {
    let latestRelease: LatestReleaseInfo | null = null
    try {
      latestRelease = await fetchLatestRelease(forceReleaseRefresh)
    } catch (error) {
      console.error('[Update] Failed to fetch latest release:', toProgressError(error))
    }

    let activeRun = await getLatestVisibleRun()
    if (activeRun && (activeRun.status === 'pending' || activeRun.status === 'running')) {
      activeRun = await this.reconcileActiveRun(activeRun.id)
    }

    const support = await getInstallSupport()
    return {
      supported: support.supported || UPDATE_FORCE,
      supportReason: support.supported || UPDATE_FORCE ? null : support.reason,
      currentVersion: await getCurrentInstalledVersion(),
      currentBuild: getBuildInfo(),
      latestRelease,
      dismissedVersion: await settingsService.getDismissedUpdateVersion(),
      activeRun: serializeRun(activeRun),
      forceUpdate: UPDATE_FORCE,
    }
  },

  async forceCheck() {
    releaseCache = null
    return this.getOverview(true)
  },

  async acceptLatestRelease() {
    const support = await getInstallSupport()
    if (!support.supported) {
      throw new Error(support.reason || 'This installation does not support integrated updates')
    }

    const latestRelease = await fetchLatestRelease(true)
    if (!latestRelease) {
      throw new Error('No stable GitHub release is available right now')
    }

    const existingRun = await getActiveRun()
    if (existingRun) {
      if (existingRun.targetVersion !== latestRelease.version) {
        throw new Error(`Another update is already in progress (${existingRun.targetVersion})`)
      }

      if (existingRun.phase === 'pending' || existingRun.phase === 'pulling-images') {
        void runAcceptedUpdate(existingRun.id)
      }

      return existingRun
    }

    // Mark any previous failed run for this version so it doesn't block retry
    await prisma.appUpdateRun.updateMany({
      where: { status: 'failed', targetVersion: latestRelease.version },
      data: { status: 'completed', phaseMessage: 'Superseded by retry' },
    })

    const currentVersion = await getCurrentInstalledVersion()

    const run = await prisma.appUpdateRun.create({
      data: {
        status: 'running',
        phase: 'pending',
        currentVersion,
        targetVersion: latestRelease.version,
        targetReleaseName: latestRelease.name,
        targetReleaseUrl: latestRelease.url,
        targetPublishedAt: new Date(latestRelease.publishedAt),
        targetReleaseNotes: latestRelease.body,
        phaseMessage: 'Preparing update',
        progress: createDefaultProgress() as unknown as Prisma.InputJsonValue,
        startedAt: new Date(),
      },
    })

    await settingsService.setDismissedUpdateVersion(null)
    void runAcceptedUpdate(run.id)
    return run
  },

  async declineLatestRelease() {
    const latestRelease = await fetchLatestRelease(true)
    if (!latestRelease) {
      throw new Error('No stable GitHub release is available right now')
    }

    await settingsService.setDismissedUpdateVersion(latestRelease.version)
    return latestRelease.version
  },

  async reconcileActiveRun(runId?: string) {
    const run =
      runId !== undefined
        ? await prisma.appUpdateRun.findUnique({ where: { id: runId } })
        : await getActiveRun()

    if (!run || !['pending', 'running'].includes(run.status)) {
      return run
    }

    if (run.phase === 'pending' || run.phase === 'pulling-images') {
      if (run.phase === 'pending' || run.phase === 'pulling-images') {
        void runAcceptedUpdate(run.id)
      }
      return run
    }

    if (run.phase === 'waiting-for-api') {
      return reconcileWaitingForApi(run)
    }

    return run
  },
}
