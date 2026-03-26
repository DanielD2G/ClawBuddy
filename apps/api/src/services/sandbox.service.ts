import Docker from 'dockerode'
import { PassThrough } from 'stream'
import path from 'node:path'
import { pack, extract } from 'tar-stream'
import { prisma } from '../lib/prisma.js'
import { logger } from '../lib/logger.js'

const docker = new Docker()

import { imageBuilderService } from './image-builder.service.js'
import {
  SANDBOX_MAX_TIMEOUT_MS,
  SANDBOX_IDLE_TIMEOUT_MS,
  SANDBOX_MEMORY_BYTES,
  SANDBOX_NANOCPUS,
  SANDBOX_PID_LIMIT,
  SANDBOX_DEFAULT_EXEC_TIMEOUT_S,
  EXEC_OUTPUT_MAX_BYTES,
  SANDBOX_TIMEOUT_EXIT_CODE,
  SANDBOX_STOP_TIMEOUT_S,
  SANDBOX_BASE_IMAGE,
  SANDBOX_FALLBACK_IMAGE,
} from '../constants.js'
import { stripNullBytes } from '../lib/sanitize.js'

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

type SandboxSessionContainerRow = {
  containerId: string | null
}

type WorkspaceContainerRow = {
  containerId: string | null
}

async function resolveImage(workspaceId: string): Promise<string> {
  let image: string
  try {
    image = await imageBuilderService.getOrBuildImage(workspaceId)
  } catch (err) {
    logger.warn('[Sandbox] Failed to build custom image, falling back to base', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    image = SANDBOX_BASE_IMAGE
  }

  try {
    await docker.getImage(image).inspect()
  } catch (err) {
    logger.warn('[Sandbox] Image not found, falling back to fallback image', {
      workspaceId,
      image,
      error: err instanceof Error ? err.message : String(err),
    })
    image = SANDBOX_FALLBACK_IMAGE
    try {
      await docker.getImage(image).inspect()
    } catch {
      const DOCKER_PULL_TIMEOUT_MS = 5 * 60 * 1000 // 5 min
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Docker pull for "${image}" timed out after 5 minutes`))
        }, DOCKER_PULL_TIMEOUT_MS)
        docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) {
            clearTimeout(timer)
            return reject(err)
          }
          docker.modem.followProgress(stream, (followErr) => {
            clearTimeout(timer)
            if (followErr) {
              reject(followErr)
            } else {
              resolve()
            }
          })
        })
      })
    }
  }
  return image
}

async function execSimple(container: Docker.Container, cmd: string, user = 'root'): Promise<void> {
  const exec = await container.exec({
    Cmd: ['bash', '-c', cmd],
    AttachStdout: true,
    AttachStderr: true,
    User: user,
  })
  await new Promise<void>((resolve) => {
    exec.start({}, (err, stream) => {
      if (err || !stream) return resolve()
      stream.on('end', () => resolve())
      stream.resume()
    })
  })
}

export const sandboxService = {
  /**
   * Get or create the persistent workspace container.
   * Stores containerId directly on the Workspace model.
   */
  async getOrCreateWorkspaceContainer(
    workspaceId: string,
    options: { networkAccess: boolean; dockerSocket?: boolean },
    envVars?: Record<string, string>,
  ): Promise<string> {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })

    // If we have a running container, verify it's alive
    if (workspace.containerId && workspace.containerStatus === 'running') {
      try {
        const container = docker.getContainer(workspace.containerId)
        const info = await container.inspect()
        if (info.State.Running) return workspace.containerId
      } catch (err) {
        logger.warn('[Sandbox] Running container gone, will recreate', {
          workspaceId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Clean up old container if exists
    if (workspace.containerId) {
      try {
        const old = docker.getContainer(workspace.containerId)
        await old.remove({ force: true })
      } catch (err) {
        logger.warn('[Sandbox] Failed to remove old container', {
          workspaceId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const image = await resolveImage(workspaceId)
    const envList = envVars
      ? Object.entries(envVars)
          .filter(([k]) => !k.startsWith('_'))
          .map(([k, v]) => `${k}=${v}`)
      : []

    const container = await docker.createContainer({
      Image: image,
      Cmd: ['sleep', 'infinity'],
      WorkingDir: '/workspace',
      Env: envList.length ? envList : undefined,
      HostConfig: {
        Memory: SANDBOX_MEMORY_BYTES,
        NanoCpus: SANDBOX_NANOCPUS,
        PidsLimit: SANDBOX_PID_LIMIT,
        NetworkMode: options.networkAccess ? 'bridge' : 'none',
        Binds: [
          `clawbuddy-workspace-${workspaceId}:/workspace`,
          ...(options.dockerSocket ? ['/var/run/docker.sock:/var/run/docker.sock'] : []),
        ],
      },
      Labels: {
        'clawbuddy.workspace': workspaceId,
        'clawbuddy.type': 'workspace',
        'clawbuddy.managed': 'true',
      },
    })

    await container.start()

    if (options.dockerSocket) {
      await execSimple(container, 'chmod 666 /var/run/docker.sock 2>/dev/null || true')
    }

    // Setup shared workspace structure
    await execSimple(
      container,
      'mkdir -p /workspace/__agent__ /workspace/.outputs && chmod 755 /workspace && chmod 777 /workspace/.outputs',
    )

    // Write credential files (AWS, GWS, etc.)
    if (envVars) {
      const filesToMount: Array<{ path: string; content: string; heredocTag: string }> = []
      if (envVars['_AWS_CREDENTIALS_FILE']) {
        filesToMount.push({
          path: '/root/.aws/credentials',
          content: envVars['_AWS_CREDENTIALS_FILE'],
          heredocTag: 'AWSEOF',
        })
      }
      if (envVars['_AWS_CONFIG_FILE']) {
        filesToMount.push({
          path: '/root/.aws/config',
          content: envVars['_AWS_CONFIG_FILE'],
          heredocTag: 'AWSCFGEOF',
        })
      }
      if (envVars['_GWS_CREDENTIALS_FILE']) {
        filesToMount.push({
          path: '/root/.config/gws/credentials.json',
          content: envVars['_GWS_CREDENTIALS_FILE'],
          heredocTag: 'GWSEOF',
        })
      }
      if (filesToMount.length) {
        const dirs = new Set<string>()
        for (const f of filesToMount) {
          const dir = f.path.substring(0, f.path.lastIndexOf('/'))
          dirs.add(dir)
          dirs.add(dir.replace('/root/', '/etc/skel/'))
        }
        const mkdirCmd = `mkdir -p ${[...dirs].join(' ')}`
        const writeCmd = filesToMount
          .map((f) => {
            const skelPath = f.path.replace('/root/', '/etc/skel/')
            return `cat > ${f.path} << '${f.heredocTag}'\n${f.content}\n${f.heredocTag}\ncp ${f.path} ${skelPath}`
          })
          .join('\n')
        await execSimple(container, `${mkdirCmd} && ${writeCmd}`)
      }

      // Set GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE so gws finds it regardless of $HOME
      if (envVars['_GWS_CREDENTIALS_FILE']) {
        await execSimple(
          container,
          'echo "export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/root/.config/gws/credentials.json" >> /etc/profile.d/gws.sh',
        )
      }
    }

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        containerId: container.id,
        containerStatus: 'running',
        containerLastActivityAt: new Date(),
      },
    })

    logger.info(
      `[Sandbox] Created workspace container for ${workspaceId}: ${container.id.slice(0, 12)}`,
      { workspaceId },
    )
    return container.id
  },

  /**
   * Execute a command in the workspace container as root.
   */
  async execInWorkspace(
    workspaceId: string,
    command: string,
    options?: { timeout?: number; workingDir?: string },
  ): Promise<ExecResult> {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })

    if (!workspace.containerId || workspace.containerStatus !== 'running') {
      // Try to restart
      throw new Error('Workspace container is not running')
    }

    try {
      const result = await this._execInContainerDirect(workspace.containerId, command, options)
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { containerLastActivityAt: new Date() },
      })
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('no such container') || msg.includes('is not running')) {
        logger.warn(`[Sandbox] Workspace container gone for ${workspaceId}, recreating...`, {
          workspaceId,
        })
        await this.getOrCreateWorkspaceContainer(workspaceId, { networkAccess: true })
        const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
        return this._execInContainerDirect(ws.containerId!, command, options)
      }
      throw err
    }
  },

  /**
   * Internal: execute a command directly in a container by containerId as root.
   */
  async _execInContainerDirect(
    containerId: string,
    command: string,
    options?: { timeout?: number; workingDir?: string },
  ): Promise<ExecResult> {
    const container = docker.getContainer(containerId)
    const timeoutMs = Math.min(
      (options?.timeout ?? SANDBOX_DEFAULT_EXEC_TIMEOUT_S) * 1000,
      SANDBOX_MAX_TIMEOUT_MS,
    )

    const workingDir = options?.workingDir ?? '/workspace'

    const exec = await container.exec({
      Cmd: ['bash', '-c', `umask 000 && ${command}`],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: workingDir,
      User: 'root',
    })

    return new Promise<ExecResult>((resolve, reject) => {
      exec.start({}, (err, stream) => {
        if (err) return reject(err)
        if (!stream) return reject(new Error('No stream returned'))

        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []

        const stdout = new PassThrough()
        const stderr = new PassThrough()

        stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
        stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

        docker.modem.demuxStream(stream, stdout, stderr)

        const timeout = setTimeout(() => {
          stream.destroy()
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf-8').slice(0, EXEC_OUTPUT_MAX_BYTES),
            stderr: '[TIMEOUT] Command exceeded time limit',
            exitCode: SANDBOX_TIMEOUT_EXIT_CODE,
          })
        }, timeoutMs)

        stream.on('end', async () => {
          clearTimeout(timeout)
          stdout.end()
          stderr.end()

          let exitCode = 0
          try {
            const inspection = await exec.inspect()
            exitCode = inspection.ExitCode ?? 0
          } catch (err) {
            logger.warn('[Sandbox] Failed to inspect exec exit code', {
              error: err instanceof Error ? err.message : String(err),
            })
          }

          const rawStdout = stripNullBytes(Buffer.concat(stdoutChunks).toString('utf-8'))
            .trim()
            .slice(0, EXEC_OUTPUT_MAX_BYTES)
          const rawStderr = stripNullBytes(Buffer.concat(stderrChunks).toString('utf-8'))
            .trim()
            .slice(0, EXEC_OUTPUT_MAX_BYTES)

          resolve({
            stdout: rawStdout,
            stderr: rawStderr || (exitCode !== 0 ? rawStdout : ''),
            exitCode,
          })
        })

        stream.on('error', (err: Error) => {
          clearTimeout(timeout)
          reject(err)
        })
      })
    })
  },

  /**
   * Write a file directly into the workspace container using Docker putArchive.
   * Bypasses shell argument limits — safe for large binary files (screenshots, etc.).
   */
  async writeFileToContainer(workspaceId: string, filePath: string, data: Buffer): Promise<void> {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    if (!workspace.containerId || workspace.containerStatus !== 'running') {
      throw new Error('Workspace container is not running')
    }

    const container = docker.getContainer(workspace.containerId)
    const dir = path.posix.dirname(filePath)
    const filename = path.posix.basename(filePath)

    // Ensure the target directory exists
    await this._execInContainerDirect(
      workspace.containerId,
      `mkdir -p ${JSON.stringify(dir)} && chmod 777 ${JSON.stringify(dir)}`,
      { timeout: 5 },
    )

    // Create a tar archive with the file
    const tarPacker = pack()
    tarPacker.entry({ name: filename, mode: 0o666 }, data)
    tarPacker.finalize()

    // Collect tar stream into a buffer
    const chunks: Buffer[] = []
    for await (const chunk of tarPacker) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const tarBuffer = Buffer.concat(chunks)

    // Put the archive into the container
    await container.putArchive(tarBuffer, { path: dir })

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { containerLastActivityAt: new Date() },
    })
  },

  /**
   * Read a file directly from the workspace container using Docker getArchive.
   * Bypasses stdout size limits — safe for large binary files (screenshots, etc.).
   */
  async readFileFromContainer(workspaceId: string, filePath: string): Promise<Buffer> {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    if (!workspace.containerId || workspace.containerStatus !== 'running') {
      throw new Error('Workspace container is not running')
    }

    const container = docker.getContainer(workspace.containerId)

    // getArchive returns a tar stream containing the requested file
    const archiveStream = await container.getArchive({ path: filePath })

    return new Promise<Buffer>((resolve, reject) => {
      const extractor = extract()
      const chunks: Buffer[] = []

      extractor.on('entry', (_header, stream, next) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', next)
        stream.on('error', reject)
      })

      extractor.on('finish', () => {
        resolve(Buffer.concat(chunks))
      })

      extractor.on('error', reject)

      archiveStream.pipe(extractor)
    })
  },

  /**
   * Stop a workspace container.
   */
  async stopWorkspaceContainer(workspaceId: string) {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    if (workspace.containerId) {
      try {
        const container = docker.getContainer(workspace.containerId)
        await container.stop({ t: SANDBOX_STOP_TIMEOUT_S }).catch((err) =>
          logger.warn('[Sandbox] Failed to stop workspace container', {
            workspaceId,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        await container.remove({ force: true }).catch((err) =>
          logger.warn('[Sandbox] Failed to remove workspace container', {
            workspaceId,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      } catch (err) {
        logger.warn('[Sandbox] Container already gone during stop', {
          workspaceId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { containerStatus: 'stopped', containerId: null },
    })
  },

  /**
   * Get workspace container status.
   */
  async getWorkspaceContainerStatus(
    workspaceId: string,
  ): Promise<{ status: string; containerId: string | null }> {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    if (workspace.containerId && workspace.containerStatus === 'running') {
      try {
        const container = docker.getContainer(workspace.containerId)
        const info = await container.inspect()
        if (!info.State.Running) {
          await prisma.workspace.update({
            where: { id: workspaceId },
            data: { containerStatus: 'stopped', containerId: null },
          })
          return { status: 'stopped', containerId: null }
        }
      } catch (err) {
        logger.warn('[Sandbox] Container inspect failed, marking stopped', {
          workspaceId,
          error: err instanceof Error ? err.message : String(err),
        })
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: { containerStatus: 'stopped', containerId: null },
        })
        return { status: 'stopped', containerId: null }
      }
    }
    return { status: workspace.containerStatus, containerId: workspace.containerId }
  },

  /**
   * Destroy a legacy per-session sandbox.
   */
  async destroySandbox(sandboxSessionId: string) {
    const session = await prisma.sandboxSession.findUniqueOrThrow({
      where: { id: sandboxSessionId },
    })

    if (session.containerId) {
      try {
        const container = docker.getContainer(session.containerId)
        await container.stop({ t: SANDBOX_STOP_TIMEOUT_S }).catch((err) =>
          logger.warn('[Sandbox] Failed to stop sandbox container', {
            sandboxSessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
        await container.remove({ force: true }).catch((err) =>
          logger.warn('[Sandbox] Failed to remove sandbox container', {
            sandboxSessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      } catch (err) {
        logger.warn('[Sandbox] Container already gone during destroy', {
          sandboxSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    await prisma.sandboxSession.update({
      where: { id: sandboxSessionId },
      data: { status: 'stopped', stoppedAt: new Date() },
    })
  },

  /**
   * Start a workspace container with capability env vars already merged.
   */
  async startWorkspaceContainerWithCapabilities(workspaceId: string): Promise<string> {
    const { capabilityService } = await import('./capability.service.js')
    const configEnvVars =
      await capabilityService.getDecryptedCapabilityConfigsForWorkspace(workspaceId)
    if (!configEnvVars.size) {
      return this.getOrCreateWorkspaceContainer(workspaceId, { networkAccess: true })
    }

    const mergedEnvVars: Record<string, string> = {}
    for (const envMap of configEnvVars.values()) {
      Object.assign(mergedEnvVars, envMap)
    }

    return this.getOrCreateWorkspaceContainer(workspaceId, { networkAccess: true }, mergedEnvVars)
  },

  /**
   * Stop workspace containers idle for more than 10 minutes
   * and clean up orphaned Docker containers.
   */
  async cleanupIdleContainers() {
    const idleThreshold = new Date(Date.now() - SANDBOX_IDLE_TIMEOUT_MS)

    // 1. Stop idle workspace containers
    const idleWorkspaces = await prisma.workspace.findMany({
      where: {
        containerStatus: 'running',
        OR: [{ containerLastActivityAt: null }, { containerLastActivityAt: { lt: idleThreshold } }],
      },
    })

    for (const workspace of idleWorkspaces) {
      logger.info(`[Sandbox] Stopping idle workspace container for ${workspace.id}`, {
        workspaceId: workspace.id,
      })
      await this.stopWorkspaceContainer(workspace.id).catch((err) => {
        logger.error(`[Sandbox] Failed to stop idle container for ${workspace.id}`, err, {
          workspaceId: workspace.id,
        })
      })
    }

    // 2. Clean orphaned Docker containers
    try {
      const containers = await docker.listContainers({
        filters: { label: ['clawbuddy.managed=true'] },
      })

      const activeContainerIds = new Set(
        (
          (await prisma.sandboxSession.findMany({
            where: { status: 'running' },
            select: { containerId: true },
          })) as SandboxSessionContainerRow[]
        )
          .map((s: SandboxSessionContainerRow) => s.containerId)
          .filter((containerId): containerId is string => Boolean(containerId)),
      )

      const workspaceContainerIds = new Set(
        (
          (await prisma.workspace.findMany({
            where: { containerStatus: 'running' },
            select: { containerId: true },
          })) as WorkspaceContainerRow[]
        )
          .map((w: WorkspaceContainerRow) => w.containerId)
          .filter((containerId): containerId is string => Boolean(containerId)),
      )

      for (const container of containers) {
        if (!activeContainerIds.has(container.Id) && !workspaceContainerIds.has(container.Id)) {
          const startedAt = container.Created ? container.Created * 1000 : 0
          if (Date.now() - startedAt > SANDBOX_IDLE_TIMEOUT_MS) {
            logger.info(`[Sandbox] Removing orphaned container ${container.Id.slice(0, 12)}`)
            const c = docker.getContainer(container.Id)
            await c.stop({ t: 5 }).catch((err) =>
              logger.warn('[Sandbox] Failed to stop orphaned container', {
                containerId: container.Id.slice(0, 12),
                error: err instanceof Error ? err.message : String(err),
              }),
            )
            await c.remove({ force: true }).catch((err) =>
              logger.warn('[Sandbox] Failed to remove orphaned container', {
                containerId: container.Id.slice(0, 12),
                error: err instanceof Error ? err.message : String(err),
              }),
            )
          }
        }
      }
    } catch (err) {
      logger.error('[Sandbox] Failed to clean orphaned containers', err)
    }
  },
}
