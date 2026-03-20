import { describe, expect, it } from 'vitest'
import {
  buildCreateSpec,
  createSystemUpdateService,
  extractDigestFromRepoDigests,
  hasUpdate,
  type PersistedSystemUpdateState,
  type SystemUpdateRelease,
} from './system-update.service.js'

type ManagedServiceName = 'api' | 'web'

interface FakeContainerRecord {
  id: string
  name: string
  image: string
  env?: string[]
  labels: Record<string, string>
  healthcheck?: Record<string, unknown>
  networks?: Record<string, { Aliases?: string[] }>
  binds?: string[]
  portBindings?: Record<string, Array<Record<string, string>>>
  running: boolean
  healthStatus?: string
  removed: boolean
}

class MemoryStateStore {
  state: PersistedSystemUpdateState = {
    status: 'idle',
    message: '',
    currentVersion: null,
    targetVersion: null,
    startedAt: null,
    finishedAt: null,
    lastCheckedAt: null,
    error: null,
  }

  async get() {
    return { ...this.state }
  }

  async set(next: PersistedSystemUpdateState) {
    this.state = { ...next }
  }
}

class FakeDockerAdapter {
  containers = new Map<string, FakeContainerRecord>()
  imageInspect = new Map<
    string,
    { RepoDigests?: string[]; Config?: { Labels?: Record<string, string> } }
  >()
  failNextApiReplacement = false

  constructor() {
    this.seedBaseState()
  }

  private seedBaseState() {
    this.imageInspect.set('api-image-old', {
      RepoDigests: ['ghcr.io/danield2g/clawbuddy-api@sha256:api-old'],
      Config: {
        Labels: {
          'org.opencontainers.image.version': '1.0.0',
          'org.opencontainers.image.revision': 'rev-old-api',
        },
      },
    })
    this.imageInspect.set('web-image-old', {
      RepoDigests: ['ghcr.io/danield2g/clawbuddy-web@sha256:web-old'],
      Config: {
        Labels: {
          'org.opencontainers.image.version': '1.0.0',
          'org.opencontainers.image.revision': 'rev-old-web',
        },
      },
    })

    this.containers.set('api-old-container', {
      id: 'api-old-container',
      name: 'clawbuddy-api-1',
      image: 'api-image-old',
      env: ['DATABASE_URL=postgresql://postgres:5432/clawbuddy'],
      labels: {
        'com.docker.compose.project': 'clawbuddy',
        'com.docker.compose.service': 'api',
      },
      healthcheck: { Test: ['CMD', 'true'] },
      networks: {
        clawbuddy_default: { Aliases: ['api'] },
      },
      binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      portBindings: {
        '4000/tcp': [{ HostPort: '4000' }],
      },
      running: true,
      healthStatus: 'healthy',
      removed: false,
    })

    this.containers.set('web-old-container', {
      id: 'web-old-container',
      name: 'clawbuddy-web-1',
      image: 'web-image-old',
      labels: {
        'com.docker.compose.project': 'clawbuddy',
        'com.docker.compose.service': 'web',
      },
      networks: {
        clawbuddy_default: { Aliases: ['web'] },
      },
      portBindings: {
        '80/tcp': [{ HostPort: '4321' }],
      },
      running: true,
      removed: false,
    })
  }

  getContainer(id: string) {
    return {
      inspect: async () => {
        const record = this.containers.get(id)
        if (!record || record.removed) throw new Error(`Container not found: ${id}`)
        return {
          Id: record.id,
          Name: `/${record.name}`,
          Image: record.image,
          Config: {
            Image:
              record.name === 'clawbuddy-api-1'
                ? 'ghcr.io/danield2g/clawbuddy-api:latest'
                : 'ghcr.io/danield2g/clawbuddy-web:latest',
            Env: record.env,
            Cmd: ['bun', 'apps/api/dist/index.js'],
            Entrypoint: null,
            WorkingDir: '/app',
            User: '',
            Tty: false,
            OpenStdin: false,
            StdinOnce: false,
            ExposedPorts: record.name === 'clawbuddy-api-1' ? { '4000/tcp': {} } : { '80/tcp': {} },
            Labels: record.labels,
            Healthcheck: record.healthcheck,
            StopSignal: 'SIGTERM',
          },
          HostConfig: {
            AutoRemove: false,
            Binds: record.binds,
            NetworkMode: 'clawbuddy_default',
            PortBindings: record.portBindings,
            RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
          },
          NetworkSettings: {
            Networks: record.networks,
          },
          State: {
            Running: record.running,
            Health: record.healthStatus ? { Status: record.healthStatus } : undefined,
          },
        }
      },
      start: async () => {
        const record = this.containers.get(id)
        if (!record || record.removed) throw new Error(`Container not found: ${id}`)
        record.running = true
      },
      stop: async () => {
        const record = this.containers.get(id)
        if (!record || record.removed) throw new Error(`Container not found: ${id}`)
        record.running = false
      },
      remove: async () => {
        const record = this.containers.get(id)
        if (!record) throw new Error(`Container not found: ${id}`)
        record.removed = true
      },
    }
  }

  getImage(id: string) {
    return {
      inspect: async () => {
        const image = this.imageInspect.get(id)
        if (!image) throw new Error(`Image not found: ${id}`)
        return {
          Id: id,
          RepoDigests: image.RepoDigests,
          Config: image.Config,
        }
      },
    }
  }

  async listContainers() {
    return [...this.containers.values()]
      .filter((container) => !container.removed)
      .map((container) => ({
        Id: container.id,
        Labels: container.labels,
        Names: [`/${container.name}`],
      }))
  }

  async createContainer(options: Record<string, unknown>) {
    const name = String(options.name)
    const image = String(options.Image)
    const id = `${name}-${this.containers.size + 1}`
    const service: ManagedServiceName = name.includes('web') ? 'web' : 'api'
    const isNewApiImage = service === 'api' && image !== 'api-image-old'
    const healthStatus =
      service === 'api'
        ? this.failNextApiReplacement && isNewApiImage
          ? 'unhealthy'
          : 'healthy'
        : undefined

    this.containers.set(id, {
      id,
      name,
      image,
      env: (options.Env as string[] | undefined) ?? [],
      labels:
        (options.Labels as Record<string, string> | undefined) ??
        ({
          'com.docker.compose.project': 'clawbuddy',
          'com.docker.compose.service': service,
        } as Record<string, string>),
      healthcheck: (options.Healthcheck as Record<string, unknown> | undefined) ?? undefined,
      networks: ((
        options.NetworkingConfig as { EndpointsConfig?: Record<string, { Aliases?: string[] }> }
      )?.EndpointsConfig as Record<string, { Aliases?: string[] }> | undefined) ?? {
        clawbuddy_default: { Aliases: [service] },
      },
      binds:
        ((options.HostConfig as { Binds?: string[] } | undefined)?.Binds as string[] | undefined) ??
        undefined,
      portBindings:
        ((
          options.HostConfig as
            | { PortBindings?: Record<string, Array<Record<string, string>>> }
            | undefined
        )?.PortBindings as Record<string, Array<Record<string, string>>> | undefined) ?? undefined,
      running: false,
      healthStatus,
      removed: false,
    })

    return this.getContainer(id)
  }

  async pullImage(image: string) {
    if (image.includes('clawbuddy-api')) {
      this.imageInspect.set('ghcr.io/danield2g/clawbuddy-api@sha256:api-new', {
        RepoDigests: ['ghcr.io/danield2g/clawbuddy-api@sha256:api-new'],
        Config: {
          Labels: {
            'org.opencontainers.image.version': '1.1.0',
            'org.opencontainers.image.revision': 'rev-new-api',
          },
        },
      })
    }

    if (image.includes('clawbuddy-web')) {
      this.imageInspect.set('ghcr.io/danield2g/clawbuddy-web@sha256:web-new', {
        RepoDigests: ['ghcr.io/danield2g/clawbuddy-web@sha256:web-new'],
        Config: {
          Labels: {
            'org.opencontainers.image.version': '1.1.0',
            'org.opencontainers.image.revision': 'rev-new-web',
          },
        },
      })
    }
  }
}

function makeRelease(version: string, apiDigest: string, webDigest: string): SystemUpdateRelease {
  return {
    version,
    revision: `rev-${version}`,
    digest: apiDigest,
    services: {
      api: {
        image: 'ghcr.io/danield2g/clawbuddy-api:latest',
        version,
        revision: `rev-${version}-api`,
        digest: apiDigest,
      },
      web: {
        image: 'ghcr.io/danield2g/clawbuddy-web:latest',
        version,
        revision: `rev-${version}-web`,
        digest: webDigest,
      },
    },
  }
}

function createFetchStub() {
  return async (input: string | URL) => {
    const url = String(input)

    if (url.includes('/token?')) {
      return new Response(JSON.stringify({ token: 'token' }), { status: 200 })
    }

    if (url.includes('/clawbuddy-api/manifests/latest')) {
      return new Response(JSON.stringify({ config: { digest: 'sha256:api-config' } }), {
        status: 200,
        headers: { 'docker-content-digest': 'sha256:api-new' },
      })
    }

    if (url.includes('/clawbuddy-web/manifests/latest')) {
      return new Response(JSON.stringify({ config: { digest: 'sha256:web-config' } }), {
        status: 200,
        headers: { 'docker-content-digest': 'sha256:web-new' },
      })
    }

    if (url.includes('/clawbuddy-api/blobs/sha256:api-config')) {
      return new Response(
        JSON.stringify({
          config: {
            Labels: {
              'org.opencontainers.image.version': '1.1.0',
              'org.opencontainers.image.revision': 'rev-new-api',
            },
          },
        }),
        { status: 200 },
      )
    }

    if (url.includes('/clawbuddy-web/blobs/sha256:web-config')) {
      return new Response(
        JSON.stringify({
          config: {
            Labels: {
              'org.opencontainers.image.version': '1.1.0',
              'org.opencontainers.image.revision': 'rev-new-web',
            },
          },
        }),
        { status: 200 },
      )
    }

    throw new Error(`Unhandled fetch: ${url}`)
  }
}

describe('system-update helpers', () => {
  it('extracts image digests for a repository', () => {
    expect(
      extractDigestFromRepoDigests(
        [
          'ghcr.io/danield2g/clawbuddy-api@sha256:abc',
          'ghcr.io/danield2g/clawbuddy-web@sha256:def',
        ],
        'ghcr.io/danield2g/clawbuddy-api',
      ),
    ).toBe('sha256:abc')
  })

  it('detects when a newer release exists', () => {
    expect(
      hasUpdate(
        makeRelease('1.0.0', 'sha256:a', 'sha256:b'),
        makeRelease('1.1.0', 'sha256:c', 'sha256:d'),
      ),
    ).toBe(true)
    expect(
      hasUpdate(
        makeRelease('1.1.0', 'sha256:c', 'sha256:d'),
        makeRelease('1.1.0', 'sha256:c', 'sha256:d'),
      ),
    ).toBe(false)
  })

  it('builds a replacement spec that preserves ports, binds and networks', () => {
    const snapshot = {
      service: 'api' as const,
      repository: 'ghcr.io/danield2g/clawbuddy-api',
      imageReference: 'ghcr.io/danield2g/clawbuddy-api:latest',
      imageId: 'api-image-old',
      release: {
        image: 'ghcr.io/danield2g/clawbuddy-api:latest',
        version: '1.0.0',
        revision: 'rev-old-api',
        digest: 'sha256:api-old',
      },
      image: {
        Id: 'api-image-old',
      },
      container: {
        Id: 'api-old-container',
        Name: '/clawbuddy-api-1',
        Image: 'api-image-old',
        Config: {
          Image: 'ghcr.io/danield2g/clawbuddy-api:latest',
          Env: ['DATABASE_URL=postgresql://postgres:5432/clawbuddy'],
          Cmd: ['bun', 'apps/api/dist/index.js'],
          Entrypoint: null,
          WorkingDir: '/app',
          User: '',
          Tty: false,
          OpenStdin: false,
          StdinOnce: false,
          ExposedPorts: { '4000/tcp': {} },
          Labels: {
            'com.docker.compose.project': 'clawbuddy',
            'com.docker.compose.service': 'api',
          },
          Healthcheck: { Test: ['CMD', 'true'] },
          StopSignal: 'SIGTERM',
        },
        HostConfig: {
          Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
          PortBindings: { '4000/tcp': [{ HostPort: '4000' }] },
          RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
          NetworkMode: 'clawbuddy_default',
        },
        NetworkSettings: {
          Networks: {
            clawbuddy_default: { Aliases: ['api'] },
          },
        },
      },
    }

    const spec = buildCreateSpec(snapshot, 'ghcr.io/danield2g/clawbuddy-api@sha256:api-new')
    expect(spec.name).toBe('clawbuddy-api-1')
    expect(spec.options.Image).toBe('ghcr.io/danield2g/clawbuddy-api@sha256:api-new')
    expect((spec.options.HostConfig as { Binds: string[] }).Binds).toContain(
      '/var/run/docker.sock:/var/run/docker.sock',
    )
    expect(
      (spec.options.NetworkingConfig as { EndpointsConfig: Record<string, unknown> })
        .EndpointsConfig,
    ).toHaveProperty('clawbuddy_default')
  })
})

describe('system-update job', () => {
  it('runs a successful rollout and persists the succeeded state', async () => {
    const docker = new FakeDockerAdapter()
    const stateStore = new MemoryStateStore()
    const service = createSystemUpdateService({
      docker,
      stateStore,
      fetchImpl: createFetchStub() as typeof fetch,
      hostname: 'api-old-container',
    })

    await service.runDetachedUpdateJob()

    const state = await stateStore.get()
    expect(state.status).toBe('succeeded')
    expect(state.targetVersion).toBe('1.1.0')
    expect(state.error).toBeNull()
  })

  it('rolls back the api container when the replacement becomes unhealthy', async () => {
    const docker = new FakeDockerAdapter()
    docker.failNextApiReplacement = true
    const stateStore = new MemoryStateStore()
    const service = createSystemUpdateService({
      docker,
      stateStore,
      fetchImpl: createFetchStub() as typeof fetch,
      hostname: 'api-old-container',
    })

    await expect(service.runDetachedUpdateJob()).rejects.toThrow('became unhealthy')

    const state = await stateStore.get()
    expect(state.status).toBe('failed')
    expect(state.error).toContain('became unhealthy')

    const apiContainer = [...docker.containers.values()].find(
      (container) => container.name === 'clawbuddy-api-1' && !container.removed,
    )
    expect(apiContainer?.image).toBe('api-image-old')
  })
})
