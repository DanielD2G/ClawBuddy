import Docker from 'dockerode'
import type { ReleaseManifest } from './update.types.js'

const LEGACY_APP_SERVICE_NAME = 'clawbuddy-app_api'
const MANAGED_LABEL = 'com.clawbuddy.managed'
const ROLE_LABEL = 'com.clawbuddy.service-role'
const STEP_DELAY_NS = 10_000_000_000
const STEP_MONITOR_NS = 30_000_000_000

interface SwarmServiceInfo {
  ID: string
  Version?: { Index?: number }
  Spec?: {
    Name?: string
    Labels?: Record<string, string>
    TaskTemplate?: {
      ContainerSpec?: {
        Image?: string
        Env?: string[]
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
}

interface SwarmTaskInfo {
  ID?: string
  DesiredState?: string
  Status?: {
    State?: string
    Message?: string
    Err?: string
    ContainerStatus?: {
      ContainerID?: string
    }
  }
}

interface DockerContainerInspectInfo {
  Config?: {
    Image?: string
  }
  State?: {
    Running?: boolean
    Health?: {
      Status?: string
    }
  }
}

interface ServiceHealthSnapshot {
  allHealthy: boolean
  desiredTasks: number
  runningTasks: number
  healthyTasks: number
  message: string
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

function normalizeDigest(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  return value.startsWith('sha256:') ? value : `sha256:${value}`
}

export function extractVersionFromImage(image: string | null | undefined): string | null {
  if (!image) return null
  const withoutDigest = image.split('@')[0] ?? image
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')
  if (lastColon <= lastSlash) return null
  const version = withoutDigest.slice(lastColon + 1).trim()
  if (!version) return null
  return version.startsWith('v') ? version : `v${version}`
}

export function extractDigestFromImage(image: string | null | undefined): string | null {
  if (!image?.includes('@')) return null
  const digest = image.split('@')[1]
  return normalizeDigest(digest ?? null)
}

export function buildTargetImageReference(manifest: ReleaseManifest): string {
  if (manifest.imageDigest && !manifest.appImage.includes('@')) {
    return `${manifest.appImage}@${manifest.imageDigest}`
  }
  return manifest.appImage
}

export async function getInstallSupport() {
  try {
    const info = (await docker.info()) as { Swarm?: { LocalNodeState?: string } }
    if (info.Swarm?.LocalNodeState !== 'active') {
      return { supported: false, reason: 'Docker Swarm is not active' }
    }

    const appService = await getManagedServiceByRole('app')

    if (!appService) {
      return {
        supported: false,
        reason: 'Managed ClawBuddy app service was not found on this host',
      }
    }

    return { supported: true, reason: null, appService }
  } catch (error) {
    return {
      supported: false,
      reason: `Docker is not reachable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function getManagedServiceByRole(
  role: 'app' | 'updater',
): Promise<SwarmServiceInfo | null> {
  const services = (await docker.listServices({ status: true })) as unknown as SwarmServiceInfo[]

  const labeledService =
    services.find(
      (service) =>
        service.Spec?.Labels?.[MANAGED_LABEL] === 'true' &&
        service.Spec?.Labels?.[ROLE_LABEL] === role,
    ) ?? null

  if (labeledService) {
    return labeledService
  }

  if (role === 'app') {
    return services.find((service) => service.Spec?.Name === LEGACY_APP_SERVICE_NAME) ?? null
  }

  return null
}

export function getServiceFailure(service: SwarmServiceInfo | null) {
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

export async function getServiceHealthSnapshot(
  service: SwarmServiceInfo | null,
): Promise<ServiceHealthSnapshot> {
  if (!service) {
    return {
      allHealthy: false,
      desiredTasks: 0,
      runningTasks: 0,
      healthyTasks: 0,
      message: 'Waiting for the managed ClawBuddy service to appear in Docker Swarm',
    }
  }

  const tasks = (await docker.listTasks({
    filters: {
      service: [service.ID],
      'desired-state': ['running'],
    },
  })) as unknown as SwarmTaskInfo[]

  if (tasks.length === 0) {
    return {
      allHealthy: false,
      desiredTasks: 0,
      runningTasks: 0,
      healthyTasks: 0,
      message: 'Waiting for the replacement service task to be scheduled',
    }
  }

  const taskStates = await Promise.all(
    tasks.map(async (task) => {
      const containerId = task.Status?.ContainerStatus?.ContainerID
      if (!containerId) {
        return { task, container: null }
      }

      try {
        const container = (await docker
          .getContainer(containerId)
          .inspect()) as DockerContainerInspectInfo
        return { task, container }
      } catch {
        return { task, container: null }
      }
    }),
  )

  let runningTasks = 0
  let healthyTasks = 0
  const waitingReasons: string[] = []

  for (const { task, container } of taskStates) {
    const taskState = task.Status?.State ?? 'new'
    const taskLabel = task.ID ? `Task ${task.ID.slice(0, 12)}` : 'Service task'

    if (taskState === 'running') {
      runningTasks += 1
    } else {
      waitingReasons.push(task.Status?.Message || `${taskLabel} is ${taskState}`)
      continue
    }

    const healthStatus = container?.State?.Health?.Status
    if (healthStatus === 'healthy' || (!healthStatus && container?.State?.Running)) {
      healthyTasks += 1
      continue
    }

    if (healthStatus === 'unhealthy') {
      waitingReasons.push(`${taskLabel} failed its health check`)
      continue
    }

    if (healthStatus) {
      waitingReasons.push(`${taskLabel} health is ${healthStatus}`)
      continue
    }

    waitingReasons.push(task.Status?.Message || `${taskLabel} is starting`)
  }

  const desiredTasks = tasks.length
  if (healthyTasks === desiredTasks && runningTasks === desiredTasks) {
    return {
      allHealthy: true,
      desiredTasks,
      runningTasks,
      healthyTasks,
      message: `All service tasks are healthy (${healthyTasks}/${desiredTasks})`,
    }
  }

  const summary = `Waiting for healthy service tasks (${healthyTasks}/${desiredTasks})`
  const detail = waitingReasons.find(Boolean)

  return {
    allHealthy: false,
    desiredTasks,
    runningTasks,
    healthyTasks,
    message: detail ? `${summary}. ${detail}` : summary,
  }
}

export async function getObservedServiceState(service: SwarmServiceInfo | null) {
  if (!service) {
    return {
      version: null,
      image: null,
      digest: null,
      updateState: null,
      updateMessage: null,
    }
  }

  const image = service.Spec?.TaskTemplate?.ContainerSpec?.Image ?? null

  return {
    version: extractVersionFromImage(image),
    image,
    digest: extractDigestFromImage(image),
    updateState: service.UpdateStatus?.State ?? null,
    updateMessage: service.UpdateStatus?.Message ?? null,
  }
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

export async function updateServiceImage(service: SwarmServiceInfo, image: string) {
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

export async function pullImage(image: string, onProgress: (message: string) => Promise<void>) {
  const stream = await docker.pull(image)

  await new Promise<void>((resolve, reject) => {
    let lastMessage = ''
    let lastSentAt = 0

    dockerWithModem.modem.followProgress(
      stream,
      (error) => {
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

export function observedImageMatchesTarget(
  observedImage: string | null,
  manifest: ReleaseManifest,
) {
  if (!observedImage) return false
  const targetImage = buildTargetImageReference(manifest)

  if (observedImage === targetImage) {
    return true
  }

  const observedWithoutDigest = observedImage.split('@')[0]
  const targetWithoutDigest = targetImage.split('@')[0]
  if (observedWithoutDigest !== targetWithoutDigest) {
    return false
  }

  if (!manifest.imageDigest) {
    return true
  }

  return extractDigestFromImage(observedImage) === manifest.imageDigest
}
