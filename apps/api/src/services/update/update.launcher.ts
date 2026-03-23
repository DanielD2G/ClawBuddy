import { randomUUID } from 'node:crypto'
import Docker from 'dockerode'
import { prisma } from '../../lib/prisma.js'
import { getManagedServiceByRole } from './update.swarm.js'

const docker = new Docker()
const UPDATER_CONTAINER_LABEL = 'com.clawbuddy.updater.runner'
const DEFAULT_SHARED_NETWORK_NAME = 'clawbuddy_shared'

function buildUpdaterEnv() {
  return Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}=${value}`)
}

async function hasRunningUpdaterContainer() {
  const containers = await docker.listContainers({
    filters: {
      label: [`${UPDATER_CONTAINER_LABEL}=true`],
    },
  })

  return containers.length > 0
}

export const updateLauncherService = {
  async ensureRunning(reason: string) {
    if (await hasRunningUpdaterContainer()) {
      return
    }

    const appService = await getManagedServiceByRole('app')
    const appImage = appService?.Spec?.TaskTemplate?.ContainerSpec?.Image
    if (!appImage) {
      throw new Error('Managed ClawBuddy app service image is not available')
    }

    const container = await docker.createContainer({
      name: `clawbuddy-updater-${Date.now()}`,
      Image: appImage,
      Cmd: ['bun', 'apps/api/dist/updater.js'],
      Env: [
        ...buildUpdaterEnv(),
        'CLAWBUDDY_UPDATER_ON_DEMAND=true',
        `CLAWBUDDY_UPDATER_ID=${randomUUID()}`,
      ],
      Labels: {
        [UPDATER_CONTAINER_LABEL]: 'true',
        'com.clawbuddy.managed': 'true',
        'com.clawbuddy.service-role': 'updater-runner',
        'com.clawbuddy.update-reason': reason,
      },
      HostConfig: {
        AutoRemove: true,
        Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [DEFAULT_SHARED_NETWORK_NAME]: {},
        },
      },
    })

    await container.start()
  },

  async resumeIfNeeded() {
    const activeRun = await prisma.appUpdateRun.findFirst({
      where: {
        status: { in: ['queued', 'running'] },
      },
      select: { id: true, targetVersion: true },
      orderBy: { createdAt: 'asc' },
    })

    if (!activeRun) {
      return
    }

    await this.ensureRunning(`resume-${activeRun.id}-${activeRun.targetVersion}`)
  },
}
