import Docker from 'dockerode'
import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { AppError } from '../lib/errors.js'

const OFFICIAL_IMAGES = {
  api: 'ghcr.io/danield2g/clawbuddy-api',
  web: 'ghcr.io/danield2g/clawbuddy-web',
} as const

const OFFICIAL_SERVICE_ORDER = ['api', 'web'] as const
const REGISTRY_ACCEPT_HEADER =
  'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
const REMOTE_CACHE_TTL_MS = 5 * 60_000
const API_HEALTH_TIMEOUT_MS = 120_000
const START_TIMEOUT_MS = 30_000
const CONTAINER_STOP_TIMEOUT_S = 15

export type ManagedServiceName = (typeof OFFICIAL_SERVICE_ORDER)[number]

export type SystemUpdateStateStatus =
  | 'idle'
  | 'available'
  | 'queued'
  | 'pulling'
  | 'replacing_api'
  | 'waiting_api'
  | 'replacing_web'
  | 'succeeded'
  | 'failed'

export interface ServiceReleaseMetadata {
  image: string
  version: string | null
  revision: string | null
  digest: string | null
}

export interface SystemUpdateRelease {
  version: string | null
  revision: string | null
  digest: string | null
  services: Record<ManagedServiceName, ServiceReleaseMetadata>
}

export interface PersistedSystemUpdateState {
  status: SystemUpdateStateStatus
  message: string
  currentVersion: string | null
  targetVersion: string | null
  startedAt: string | null
  finishedAt: string | null
  lastCheckedAt: string | null
  error: string | null
}

export interface SystemUpdateStatusResponse {
  supported: boolean
  available: boolean
  current: SystemUpdateRelease | null
  latest: SystemUpdateRelease | null
  state: PersistedSystemUpdateState
  canUpdate: boolean
  reason: string | null
}

interface RegistryManifest {
  config?: { digest?: string }
}

interface RegistryBlobConfig {
  config?: {
    Labels?: Record<string, string>
  }
}

interface ContainerSummary {
  Id: string
  Labels?: Record<string, string>
  Names?: string[]
}

interface ContainerInspectLike {
  Id: string
  Name: string
  Image: string
  Config: {
    Image?: string
    Env?: string[]
    Cmd?: string[] | null
    Entrypoint?: string[] | string | null
    WorkingDir?: string
    User?: string
    Tty?: boolean
    OpenStdin?: boolean
    StdinOnce?: boolean
    ExposedPorts?: Record<string, unknown>
    Labels?: Record<string, string>
    Healthcheck?: Record<string, unknown>
    StopSignal?: string
  }
  HostConfig: {
    AutoRemove?: boolean
    Binds?: string[]
    CapAdd?: string[]
    CapDrop?: string[]
    Dns?: string[]
    DnsOptions?: string[]
    DnsSearch?: string[]
    ExtraHosts?: string[]
    GroupAdd?: string[]
    Init?: boolean
    IpcMode?: string
    Isolation?: string
    LogConfig?: Record<string, unknown>
    Memory?: number
    MemoryReservation?: number
    MemorySwap?: number
    NanoCpus?: number
    NetworkMode?: string
    OomKillDisable?: boolean
    PidMode?: string
    PidsLimit?: number
    PortBindings?: Record<string, Array<Record<string, string>>>
    Privileged?: boolean
    PublishAllPorts?: boolean
    ReadonlyRootfs?: boolean
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number }
    ShmSize?: number
    Tmpfs?: Record<string, string>
    Ulimits?: Array<Record<string, unknown>>
    VolumesFrom?: string[]
  }
  NetworkSettings?: {
    Networks?: Record<
      string,
      {
        Aliases?: string[]
      }
    >
  }
  State?: {
    Running?: boolean
    Health?: {
      Status?: string
    }
  }
}

interface ImageInspectLike {
  Id: string
  RepoDigests?: string[]
  Config?: {
    Labels?: Record<string, string>
  }
}

interface DockerContainerHandle {
  inspect(): Promise<ContainerInspectLike>
  start(): Promise<void>
  stop(options?: { t?: number }): Promise<void>
  remove(options?: { force?: boolean }): Promise<void>
}

interface DockerImageHandle {
  inspect(): Promise<ImageInspectLike>
}

interface DockerAdapter {
  getContainer(id: string): DockerContainerHandle
  getImage(id: string): DockerImageHandle
  listContainers(options?: { all?: boolean }): Promise<ContainerSummary[]>
  createContainer(options: Record<string, unknown>): Promise<DockerContainerHandle>
  pullImage(image: string): Promise<void>
}

interface SystemUpdateStateStore {
  get(): Promise<PersistedSystemUpdateState>
  set(next: PersistedSystemUpdateState): Promise<void>
}

interface ServiceContainerSnapshot {
  service: ManagedServiceName
  repository: string
  imageReference: string
  imageId: string
  container: ContainerInspectLike
  image: ImageInspectLike
  release: ServiceReleaseMetadata
}

interface InstallationContext {
  supported: boolean
  reason: string | null
  composeProject: string | null
  current: SystemUpdateRelease | null
  services: Record<ManagedServiceName, ServiceContainerSnapshot> | null
}

interface RemoteReleaseCacheEntry {
  fetchedAt: number
  release: SystemUpdateRelease
}

interface ReplaceSnapshot {
  name: string
  options: Record<string, unknown>
  imageId: string
}

const DEFAULT_STATE: PersistedSystemUpdateState = {
  status: 'idle',
  message: '',
  currentVersion: null,
  targetVersion: null,
  startedAt: null,
  finishedAt: null,
  lastCheckedAt: null,
  error: null,
}

function isInProgress(status: SystemUpdateStateStatus): boolean {
  return (
    status === 'queued' ||
    status === 'pulling' ||
    status === 'replacing_api' ||
    status === 'waiting_api' ||
    status === 'replacing_web'
  )
}

function normalizeVersion(value: string | null | undefined): string | null {
  return value?.trim() || null
}

function extractDigestFromRepoDigests(
  repoDigests: string[] | undefined,
  repository: string,
): string | null {
  const match = repoDigests?.find((entry) => entry.startsWith(`${repository}@`))
  return match ? match.slice(repository.length + 1) : null
}

function getPrimaryReleaseMetadata(
  services: Record<ManagedServiceName, ServiceReleaseMetadata>,
): Pick<SystemUpdateRelease, 'version' | 'revision' | 'digest'> {
  const api = services.api
  const web = services.web
  return {
    version: normalizeVersion(api.version) ?? normalizeVersion(web.version),
    revision: normalizeVersion(api.revision) ?? normalizeVersion(web.revision),
    digest: api.digest ?? web.digest ?? null,
  }
}

function buildRelease(
  services: Record<ManagedServiceName, ServiceReleaseMetadata>,
): SystemUpdateRelease {
  return {
    ...getPrimaryReleaseMetadata(services),
    services,
  }
}

function hasUpdate(current: SystemUpdateRelease, latest: SystemUpdateRelease): boolean {
  return OFFICIAL_SERVICE_ORDER.some((service) => {
    const currentMeta = current.services[service]
    const latestMeta = latest.services[service]

    if (currentMeta.digest && latestMeta.digest) {
      return currentMeta.digest !== latestMeta.digest
    }

    return (
      normalizeVersion(currentMeta.version) !== normalizeVersion(latestMeta.version) ||
      normalizeVersion(currentMeta.revision) !== normalizeVersion(latestMeta.revision)
    )
  })
}

function sanitizeName(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name
}

function isOfficialImageReference(image: string | undefined, repository: string): boolean {
  if (!image) return false
  return (
    image === repository || image.startsWith(`${repository}:`) || image.startsWith(`${repository}@`)
  )
}

function buildCreateSpec(snapshot: ServiceContainerSnapshot, nextImage: string): ReplaceSnapshot {
  const { container } = snapshot
  const name = sanitizeName(container.Name)
  const networkNames = Object.keys(container.NetworkSettings?.Networks ?? {})
  const primaryNetwork = networkNames[0]
  const endpointsConfig = Object.fromEntries(
    networkNames.map((networkName) => [
      networkName,
      {
        Aliases: container.NetworkSettings?.Networks?.[networkName]?.Aliases,
      },
    ]),
  )

  return {
    name,
    imageId: snapshot.imageId,
    options: {
      name,
      Image: nextImage,
      Cmd: container.Config.Cmd ?? undefined,
      Entrypoint: container.Config.Entrypoint ?? undefined,
      Env: container.Config.Env ?? undefined,
      WorkingDir: container.Config.WorkingDir || undefined,
      User: container.Config.User || undefined,
      Tty: container.Config.Tty || undefined,
      OpenStdin: container.Config.OpenStdin || undefined,
      StdinOnce: container.Config.StdinOnce || undefined,
      ExposedPorts:
        container.Config.ExposedPorts && Object.keys(container.Config.ExposedPorts).length > 0
          ? container.Config.ExposedPorts
          : undefined,
      Labels: container.Config.Labels ?? undefined,
      Healthcheck: container.Config.Healthcheck ?? undefined,
      StopSignal: container.Config.StopSignal || undefined,
      HostConfig: {
        AutoRemove: container.HostConfig.AutoRemove || undefined,
        Binds: container.HostConfig.Binds?.length ? container.HostConfig.Binds : undefined,
        CapAdd: container.HostConfig.CapAdd?.length ? container.HostConfig.CapAdd : undefined,
        CapDrop: container.HostConfig.CapDrop?.length ? container.HostConfig.CapDrop : undefined,
        Dns: container.HostConfig.Dns?.length ? container.HostConfig.Dns : undefined,
        DnsOptions: container.HostConfig.DnsOptions?.length
          ? container.HostConfig.DnsOptions
          : undefined,
        DnsSearch: container.HostConfig.DnsSearch?.length
          ? container.HostConfig.DnsSearch
          : undefined,
        ExtraHosts: container.HostConfig.ExtraHosts?.length
          ? container.HostConfig.ExtraHosts
          : undefined,
        GroupAdd: container.HostConfig.GroupAdd?.length ? container.HostConfig.GroupAdd : undefined,
        Init: container.HostConfig.Init || undefined,
        IpcMode: container.HostConfig.IpcMode || undefined,
        Isolation: container.HostConfig.Isolation || undefined,
        LogConfig: container.HostConfig.LogConfig,
        Memory: container.HostConfig.Memory || undefined,
        MemoryReservation: container.HostConfig.MemoryReservation || undefined,
        MemorySwap: container.HostConfig.MemorySwap || undefined,
        NanoCpus: container.HostConfig.NanoCpus || undefined,
        NetworkMode: primaryNetwork ?? container.HostConfig.NetworkMode ?? undefined,
        OomKillDisable: container.HostConfig.OomKillDisable || undefined,
        PidMode: container.HostConfig.PidMode || undefined,
        PidsLimit: container.HostConfig.PidsLimit || undefined,
        PortBindings:
          container.HostConfig.PortBindings &&
          Object.keys(container.HostConfig.PortBindings).length > 0
            ? container.HostConfig.PortBindings
            : undefined,
        Privileged: container.HostConfig.Privileged || undefined,
        PublishAllPorts: container.HostConfig.PublishAllPorts || undefined,
        ReadonlyRootfs: container.HostConfig.ReadonlyRootfs || undefined,
        RestartPolicy: container.HostConfig.RestartPolicy,
        ShmSize: container.HostConfig.ShmSize || undefined,
        Tmpfs:
          container.HostConfig.Tmpfs && Object.keys(container.HostConfig.Tmpfs).length > 0
            ? container.HostConfig.Tmpfs
            : undefined,
        Ulimits: container.HostConfig.Ulimits?.length ? container.HostConfig.Ulimits : undefined,
        VolumesFrom: container.HostConfig.VolumesFrom?.length
          ? container.HostConfig.VolumesFrom
          : undefined,
      },
      NetworkingConfig:
        Object.keys(endpointsConfig).length > 0 ? { EndpointsConfig: endpointsConfig } : undefined,
    },
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

class DockerodeAdapter implements DockerAdapter {
  constructor(private readonly docker: Docker) {}

  getContainer(id: string): DockerContainerHandle {
    return this.docker.getContainer(id) as unknown as DockerContainerHandle
  }

  getImage(id: string): DockerImageHandle {
    return this.docker.getImage(id) as unknown as DockerImageHandle
  }

  async listContainers(options?: { all?: boolean }): Promise<ContainerSummary[]> {
    return (await this.docker.listContainers(options)) as ContainerSummary[]
  }

  async createContainer(options: Record<string, unknown>): Promise<DockerContainerHandle> {
    return (await this.docker.createContainer(options)) as DockerContainerHandle
  }

  async pullImage(image: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err)
        this.docker.modem.followProgress(stream, (progressErr) =>
          progressErr ? reject(progressErr) : resolve(),
        )
      })
    })
  }
}

class PrismaSystemUpdateStateStore implements SystemUpdateStateStore {
  async get(): Promise<PersistedSystemUpdateState> {
    const settings = await prisma.globalSettings.findUnique({ where: { id: 'singleton' } })
    const raw = settings?.systemUpdateState as Partial<PersistedSystemUpdateState> | null
    return {
      ...DEFAULT_STATE,
      ...(raw ?? {}),
    }
  }

  async set(next: PersistedSystemUpdateState): Promise<void> {
    await prisma.globalSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', systemUpdateState: next as unknown as Prisma.InputJsonValue },
      update: { systemUpdateState: next as unknown as Prisma.InputJsonValue },
    })
  }
}

export function createSystemUpdateService(deps?: {
  docker?: DockerAdapter
  stateStore?: SystemUpdateStateStore
  fetchImpl?: typeof fetch
  hostname?: string | undefined
  now?: () => number
}) {
  const docker = deps?.docker ?? new DockerodeAdapter(new Docker())
  const stateStore = deps?.stateStore ?? new PrismaSystemUpdateStateStore()
  const fetchImpl = deps?.fetchImpl ?? fetch
  const getHostname = () =>
    deps?.hostname ?? process.env.SYSTEM_UPDATE_API_CONTAINER_ID ?? process.env.HOSTNAME
  const now = deps?.now ?? (() => Date.now())

  let remoteCache: RemoteReleaseCacheEntry | null = null

  async function getRegistryToken(repository: string): Promise<string> {
    const url = `https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`
    const res = await fetchImpl(url)
    if (!res.ok) {
      throw new AppError(`Failed to authenticate against GHCR: ${res.status}`, 502)
    }
    const json = (await res.json()) as { token?: string }
    if (!json.token) {
      throw new AppError('GHCR token response did not include a token', 502)
    }
    return json.token
  }

  async function fetchRemoteReleaseMetadata(repository: string): Promise<ServiceReleaseMetadata> {
    const repoPath = repository.replace('ghcr.io/', '')
    const token = await getRegistryToken(repoPath)
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: REGISTRY_ACCEPT_HEADER,
    }

    const manifestRes = await fetchImpl(`https://ghcr.io/v2/${repoPath}/manifests/latest`, {
      headers,
    })
    if (!manifestRes.ok) {
      throw new AppError(`Failed to fetch manifest for ${repository}: ${manifestRes.status}`, 502)
    }

    const manifest = (await manifestRes.json()) as RegistryManifest
    const digest = manifestRes.headers.get('docker-content-digest')
    const configDigest = manifest.config?.digest
    if (!configDigest) {
      throw new AppError(`Manifest for ${repository} is missing a config digest`, 502)
    }

    const blobRes = await fetchImpl(`https://ghcr.io/v2/${repoPath}/blobs/${configDigest}`, {
      headers,
    })
    if (!blobRes.ok) {
      throw new AppError(`Failed to fetch config blob for ${repository}: ${blobRes.status}`, 502)
    }

    const blob = (await blobRes.json()) as RegistryBlobConfig
    const labels = blob.config?.Labels ?? {}

    return {
      image: `${repository}:latest`,
      version: normalizeVersion(labels['org.opencontainers.image.version']),
      revision: normalizeVersion(labels['org.opencontainers.image.revision']),
      digest,
    }
  }

  async function getLatestRelease(force = false): Promise<SystemUpdateRelease> {
    if (!force && remoteCache && now() - remoteCache.fetchedAt < REMOTE_CACHE_TTL_MS) {
      return remoteCache.release
    }

    const [apiMeta, webMeta] = await Promise.all([
      fetchRemoteReleaseMetadata(OFFICIAL_IMAGES.api),
      fetchRemoteReleaseMetadata(OFFICIAL_IMAGES.web),
    ])

    const release = buildRelease({
      api: apiMeta,
      web: webMeta,
    })

    remoteCache = { fetchedAt: now(), release }
    return release
  }

  async function getContainerById(containerId: string): Promise<ContainerInspectLike> {
    return await docker.getContainer(containerId).inspect()
  }

  async function getImageById(imageId: string): Promise<ImageInspectLike> {
    return await docker.getImage(imageId).inspect()
  }

  async function resolveCurrentInstallation(): Promise<InstallationContext> {
    const hostname = getHostname()
    if (!hostname) {
      return {
        supported: false,
        reason: 'HOSTNAME is not available inside the API container',
        composeProject: null,
        current: null,
        services: null,
      }
    }

    let apiContainer: ContainerInspectLike
    try {
      apiContainer = await getContainerById(hostname)
    } catch {
      return {
        supported: false,
        reason: 'The API process is not running inside a Docker container',
        composeProject: null,
        current: null,
        services: null,
      }
    }

    const apiLabels = apiContainer.Config.Labels ?? {}
    const composeProject = apiLabels['com.docker.compose.project'] ?? null
    const apiServiceLabel = apiLabels['com.docker.compose.service'] ?? null

    if (!composeProject || apiServiceLabel !== 'api') {
      return {
        supported: false,
        reason: 'This installation is not using the official Docker Compose layout',
        composeProject,
        current: null,
        services: null,
      }
    }

    const containers = await docker.listContainers({ all: true })
    const webContainerSummary = containers.find(
      (container) =>
        container.Labels?.['com.docker.compose.project'] === composeProject &&
        container.Labels?.['com.docker.compose.service'] === 'web',
    )

    if (!webContainerSummary) {
      return {
        supported: false,
        reason: 'Could not find the sibling web container for this Compose project',
        composeProject,
        current: null,
        services: null,
      }
    }

    const webContainer = await getContainerById(webContainerSummary.Id)
    const apiImage = await getImageById(apiContainer.Image)
    const webImage = await getImageById(webContainer.Image)

    if (
      !isOfficialImageReference(apiContainer.Config.Image, OFFICIAL_IMAGES.api) ||
      !isOfficialImageReference(webContainer.Config.Image, OFFICIAL_IMAGES.web)
    ) {
      return {
        supported: false,
        reason: 'This installation is not using the official GHCR api/web images',
        composeProject,
        current: null,
        services: null,
      }
    }

    const apiRelease: ServiceReleaseMetadata = {
      image: apiContainer.Config.Image ?? OFFICIAL_IMAGES.api,
      version:
        normalizeVersion(apiImage.Config?.Labels?.['org.opencontainers.image.version']) ??
        normalizeVersion(apiContainer.Config.Labels?.['org.opencontainers.image.version']),
      revision:
        normalizeVersion(apiImage.Config?.Labels?.['org.opencontainers.image.revision']) ??
        normalizeVersion(apiContainer.Config.Labels?.['org.opencontainers.image.revision']),
      digest: extractDigestFromRepoDigests(apiImage.RepoDigests, OFFICIAL_IMAGES.api),
    }

    const webRelease: ServiceReleaseMetadata = {
      image: webContainer.Config.Image ?? OFFICIAL_IMAGES.web,
      version:
        normalizeVersion(webImage.Config?.Labels?.['org.opencontainers.image.version']) ??
        normalizeVersion(webContainer.Config.Labels?.['org.opencontainers.image.version']),
      revision:
        normalizeVersion(webImage.Config?.Labels?.['org.opencontainers.image.revision']) ??
        normalizeVersion(webContainer.Config.Labels?.['org.opencontainers.image.revision']),
      digest: extractDigestFromRepoDigests(webImage.RepoDigests, OFFICIAL_IMAGES.web),
    }

    const services: Record<ManagedServiceName, ServiceContainerSnapshot> = {
      api: {
        service: 'api',
        repository: OFFICIAL_IMAGES.api,
        imageReference: apiContainer.Config.Image ?? OFFICIAL_IMAGES.api,
        imageId: apiContainer.Image,
        container: apiContainer,
        image: apiImage,
        release: apiRelease,
      },
      web: {
        service: 'web',
        repository: OFFICIAL_IMAGES.web,
        imageReference: webContainer.Config.Image ?? OFFICIAL_IMAGES.web,
        imageId: webContainer.Image,
        container: webContainer,
        image: webImage,
        release: webRelease,
      },
    }

    return {
      supported: true,
      reason: null,
      composeProject,
      current: buildRelease({
        api: apiRelease,
        web: webRelease,
      }),
      services,
    }
  }

  async function persistCheckResult(
    current: SystemUpdateRelease | null,
    latest: SystemUpdateRelease | null,
    available: boolean,
  ): Promise<PersistedSystemUpdateState> {
    const existing = await stateStore.get()
    const checkedAt = new Date(now()).toISOString()

    if (isInProgress(existing.status)) {
      const next = {
        ...existing,
        currentVersion: current?.version ?? existing.currentVersion,
        targetVersion: latest?.version ?? existing.targetVersion,
        lastCheckedAt: checkedAt,
      }
      await stateStore.set(next)
      return next
    }

    if (existing.status === 'failed' || existing.status === 'succeeded') {
      const next = {
        ...existing,
        currentVersion: current?.version ?? existing.currentVersion,
        targetVersion: latest?.version ?? existing.targetVersion,
        lastCheckedAt: checkedAt,
      }
      await stateStore.set(next)
      return next
    }

    const next: PersistedSystemUpdateState = {
      status: available ? 'available' : 'idle',
      message: available ? 'A new ClawBuddy version is available.' : '',
      currentVersion: current?.version ?? null,
      targetVersion: latest?.version ?? null,
      startedAt: null,
      finishedAt: null,
      lastCheckedAt: checkedAt,
      error: null,
    }
    await stateStore.set(next)
    return next
  }

  async function buildStatus(force = false): Promise<SystemUpdateStatusResponse> {
    const install = await resolveCurrentInstallation()
    if (!install.supported || !install.current) {
      return {
        supported: false,
        available: false,
        current: install.current,
        latest: null,
        state: await stateStore.get(),
        canUpdate: false,
        reason: install.reason,
      }
    }

    const latest = await getLatestRelease(force)
    const available = hasUpdate(install.current, latest)
    const state = await persistCheckResult(install.current, latest, available)

    return {
      supported: true,
      available,
      current: install.current,
      latest,
      state,
      canUpdate: available && !isInProgress(state.status),
      reason: null,
    }
  }

  async function setState(
    patch: Partial<PersistedSystemUpdateState> &
      Pick<PersistedSystemUpdateState, 'status' | 'message'>,
  ): Promise<PersistedSystemUpdateState> {
    const current = await stateStore.get()
    const next: PersistedSystemUpdateState = {
      ...current,
      ...patch,
    }
    await stateStore.set(next)
    return next
  }

  async function launchDetachedUpdater(install: InstallationContext): Promise<void> {
    if (!install.services?.api) {
      throw new AppError('Cannot start updater without the current API container snapshot', 500)
    }

    const apiSnapshot = install.services.api
    const helperName = `clawbuddy-system-updater-${now()}`
    const networkNames = Object.keys(apiSnapshot.container.NetworkSettings?.Networks ?? {})
    const primaryNetwork = networkNames[0]
    const endpointsConfig = Object.fromEntries(
      networkNames.map((networkName) => [
        networkName,
        {
          Aliases: apiSnapshot.container.NetworkSettings?.Networks?.[networkName]?.Aliases,
        },
      ]),
    )

    const helper = await docker.createContainer({
      name: helperName,
      Image: apiSnapshot.imageId,
      Cmd: ['bun', 'apps/api/dist/system-updater.js'],
      Env: [
        ...(apiSnapshot.container.Config.Env ?? []),
        'SYSTEM_UPDATE_DETACHED=1',
        `SYSTEM_UPDATE_API_CONTAINER_ID=${apiSnapshot.container.Id}`,
      ],
      Labels: {
        'clawbuddy.managed': 'true',
        'clawbuddy.type': 'system-updater',
        'clawbuddy.compose-project': install.composeProject ?? '',
      },
      HostConfig: {
        AutoRemove: true,
        Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
        NetworkMode: primaryNetwork ?? undefined,
      },
      NetworkingConfig:
        Object.keys(endpointsConfig).length > 0 ? { EndpointsConfig: endpointsConfig } : undefined,
    })

    await helper.start()
  }

  async function stopAndRemoveContainer(containerId: string): Promise<void> {
    const container = docker.getContainer(containerId)

    try {
      await container.stop({ t: CONTAINER_STOP_TIMEOUT_S })
    } catch {
      // ignore stop failures, remove(force) handles already-stopped cases too
    }

    await container.remove({ force: true })
  }

  async function waitForContainerReady(
    containerId: string,
    timeoutMs: number,
    requireHealthy: boolean,
  ): Promise<void> {
    const startedAt = now()

    while (now() - startedAt < timeoutMs) {
      const info = await docker.getContainer(containerId).inspect()
      const isRunning = info.State?.Running === true
      const healthStatus = info.State?.Health?.Status

      if (!isRunning) {
        await sleep(1000)
        continue
      }

      if (!requireHealthy || !info.Config.Healthcheck) {
        return
      }

      if (healthStatus === 'healthy') {
        return
      }

      if (healthStatus === 'unhealthy') {
        throw new AppError(`Container ${sanitizeName(info.Name)} became unhealthy`, 500)
      }

      await sleep(1000)
    }

    throw new AppError('Timed out waiting for the updated container to become ready', 500)
  }

  async function replaceContainer(
    snapshot: ServiceContainerSnapshot,
    imageRef: string,
  ): Promise<string> {
    const spec = buildCreateSpec(snapshot, imageRef)

    await stopAndRemoveContainer(snapshot.container.Id)
    const next = await docker.createContainer(spec.options)
    await next.start()

    const info = await next.inspect()
    return info.Id
  }

  async function findContainerIdByName(name: string): Promise<string | null> {
    const containers = await docker.listContainers({ all: true })
    const match = containers.find((container) =>
      (container.Names ?? []).some((containerName) => sanitizeName(containerName) === name),
    )
    return match?.Id ?? null
  }

  async function rollbackReplacement(snapshot: ServiceContainerSnapshot): Promise<void> {
    const replacement = buildCreateSpec(snapshot, snapshot.imageId)
    const existingId = await findContainerIdByName(replacement.name)
    if (existingId) {
      try {
        await stopAndRemoveContainer(existingId)
      } catch {
        // ignore rollback cleanup failures
      }
    }

    const restored = await docker.createContainer(replacement.options)
    await restored.start()
    const restoredInfo = await restored.inspect()
    await waitForContainerReady(
      restoredInfo.Id,
      snapshot.service === 'api' ? API_HEALTH_TIMEOUT_MS : START_TIMEOUT_MS,
      snapshot.service === 'api',
    )
  }

  async function runDetachedUpdateJob(): Promise<void> {
    const install = await resolveCurrentInstallation()
    if (!install.supported || !install.current || !install.services) {
      throw new AppError(install.reason ?? 'Unsupported installation for auto-update', 409)
    }

    const latest = await getLatestRelease(true)
    if (!hasUpdate(install.current, latest)) {
      await setState({
        status: 'idle',
        message: '',
        currentVersion: install.current.version,
        targetVersion: latest.version,
        finishedAt: new Date(now()).toISOString(),
        error: null,
      })
      return
    }

    const snapshots = {
      api: install.services.api,
      web: install.services.web,
    }
    const replaced = {
      api: false,
      web: false,
    }

    const nextImages = {
      api: latest.services.api.digest
        ? `${OFFICIAL_IMAGES.api}@${latest.services.api.digest}`
        : `${OFFICIAL_IMAGES.api}:latest`,
      web: latest.services.web.digest
        ? `${OFFICIAL_IMAGES.web}@${latest.services.web.digest}`
        : `${OFFICIAL_IMAGES.web}:latest`,
    }

    try {
      await setState({
        status: 'pulling',
        message: 'Pulling updated images...',
        currentVersion: install.current.version,
        targetVersion: latest.version,
        error: null,
      })
      await Promise.all([
        docker.pullImage(`${OFFICIAL_IMAGES.api}:latest`),
        docker.pullImage(`${OFFICIAL_IMAGES.web}:latest`),
      ])

      await setState({
        status: 'replacing_api',
        message: 'Recreating the API container...',
        currentVersion: install.current.version,
        targetVersion: latest.version,
      })
      replaced.api = true
      const newApiContainerId = await replaceContainer(snapshots.api, nextImages.api)

      await setState({
        status: 'waiting_api',
        message: 'Waiting for the updated API to become healthy...',
        currentVersion: install.current.version,
        targetVersion: latest.version,
      })

      await waitForContainerReady(newApiContainerId, API_HEALTH_TIMEOUT_MS, true)

      await setState({
        status: 'replacing_web',
        message: 'Recreating the web container...',
        currentVersion: install.current.version,
        targetVersion: latest.version,
      })
      replaced.web = true
      const newWebContainerId = await replaceContainer(snapshots.web, nextImages.web)
      await waitForContainerReady(newWebContainerId, START_TIMEOUT_MS, false)

      await setState({
        status: 'succeeded',
        message: 'ClawBuddy has been updated successfully.',
        currentVersion: latest.version,
        targetVersion: latest.version,
        finishedAt: new Date(now()).toISOString(),
        error: null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      if (replaced.web) {
        try {
          await rollbackReplacement(snapshots.web)
        } catch {
          // best-effort rollback
        }
      }

      if (replaced.api) {
        try {
          await rollbackReplacement(snapshots.api)
        } catch {
          // best-effort rollback
        }
      }

      await setState({
        status: 'failed',
        message: 'The update failed and ClawBuddy attempted a rollback.',
        currentVersion: install.current.version,
        targetVersion: latest.version,
        finishedAt: new Date(now()).toISOString(),
        error: message,
      })

      throw error
    }
  }

  return {
    getStatus: (force = false) => buildStatus(force),
    async startUpdate(): Promise<SystemUpdateStatusResponse> {
      const install = await resolveCurrentInstallation()
      const currentState = await stateStore.get()

      if (!install.supported || !install.current) {
        throw new AppError(install.reason ?? 'Unsupported installation for auto-update', 409)
      }

      if (isInProgress(currentState.status)) {
        throw new AppError('A system update is already in progress', 409)
      }

      const latest = await getLatestRelease(true)
      if (!hasUpdate(install.current, latest)) {
        throw new AppError('This installation is already up to date', 409)
      }

      await stateStore.set({
        status: 'queued',
        message: 'System update queued.',
        currentVersion: install.current.version,
        targetVersion: latest.version,
        startedAt: new Date(now()).toISOString(),
        finishedAt: null,
        lastCheckedAt: new Date(now()).toISOString(),
        error: null,
      })

      try {
        await launchDetachedUpdater(install)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await stateStore.set({
          status: 'failed',
          message: 'Failed to launch the detached updater.',
          currentVersion: install.current.version,
          targetVersion: latest.version,
          startedAt: new Date(now()).toISOString(),
          finishedAt: new Date(now()).toISOString(),
          lastCheckedAt: new Date(now()).toISOString(),
          error: message,
        })
        throw error
      }

      return {
        supported: true,
        available: true,
        current: install.current,
        latest,
        state: await stateStore.get(),
        canUpdate: false,
        reason: null,
      }
    },
    runDetachedUpdateJob,
  }
}

export const systemUpdateService = createSystemUpdateService()

export {
  DEFAULT_STATE as defaultSystemUpdateState,
  buildCreateSpec,
  buildRelease,
  extractDigestFromRepoDigests,
  hasUpdate,
  isInProgress,
}
