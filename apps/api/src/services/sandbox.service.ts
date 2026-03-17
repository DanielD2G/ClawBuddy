import Docker from 'dockerode'
import { PassThrough } from 'stream'
import { prisma } from '../lib/prisma.js'

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
} from '../constants.js'
import { stripNullBytes } from '../lib/sanitize.js'

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function resolveImage(workspaceId: string): Promise<string> {
  let image: string
  try {
    image = await imageBuilderService.getOrBuildImage(workspaceId)
  } catch {
    image = 'agentbuddy-sandbox-base'
  }

  try {
    await docker.getImage(image).inspect()
  } catch {
    image = 'ubuntu:22.04'
    try {
      await docker.getImage(image).inspect()
    } catch {
      await new Promise<void>((resolve, reject) => {
        docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err)
          docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()))
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
      } catch {
        // Container is gone, will recreate below
      }
    }

    // Clean up old container if exists
    if (workspace.containerId) {
      try {
        const old = docker.getContainer(workspace.containerId)
        await old.remove({ force: true })
      } catch { /* already gone */ }
    }

    const image = await resolveImage(workspaceId)
    const envList = envVars
      ? Object.entries(envVars).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `${k}=${v}`)
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
          `agentbuddy-workspace-${workspaceId}:/workspace`,
          ...(options.dockerSocket ? ['/var/run/docker.sock:/var/run/docker.sock'] : []),
        ],
      },
      Labels: {
        'agentbuddy.workspace': workspaceId,
        'agentbuddy.type': 'workspace',
        'agentbuddy.managed': 'true',
      },
    })

    await container.start()

    if (options.dockerSocket) {
      await execSimple(container, 'chmod 666 /var/run/docker.sock 2>/dev/null || true')
    }

    // Setup shared workspace structure
    await execSimple(container, 'mkdir -p /workspace/__agent__ /workspace/users /workspace/.outputs && chmod 755 /workspace /workspace/users && chmod 777 /workspace/.outputs')

    // Write credential files (AWS, GWS, etc.)
    if (envVars) {
      const filesToMount: Array<{ path: string; content: string; heredocTag: string }> = []
      if (envVars['_AWS_CREDENTIALS_FILE']) {
        filesToMount.push({ path: '/root/.aws/credentials', content: envVars['_AWS_CREDENTIALS_FILE'], heredocTag: 'AWSEOF' })
      }
      if (envVars['_AWS_CONFIG_FILE']) {
        filesToMount.push({ path: '/root/.aws/config', content: envVars['_AWS_CONFIG_FILE'], heredocTag: 'AWSCFGEOF' })
      }
      if (envVars['_GWS_CREDENTIALS_FILE']) {
        filesToMount.push({ path: '/root/.config/gws/credentials.json', content: envVars['_GWS_CREDENTIALS_FILE'], heredocTag: 'GWSEOF' })
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
        await execSimple(container, 'echo "export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/root/.config/gws/credentials.json" >> /etc/profile.d/gws.sh')
      }
    }

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { containerId: container.id, containerStatus: 'running', containerLastActivityAt: new Date() },
    })

    console.log(`[Sandbox] Created workspace container for ${workspaceId}: ${container.id.slice(0, 12)}`)
    return container.id
  },

  /**
   * Create a Linux user inside the workspace container for a conversation.
   * Returns the username. Idempotent — if user already exists, returns existing.
   */
  async ensureConversationUser(
    workspaceId: string,
    chatSessionId: string,
  ): Promise<string> {
    const session = await prisma.chatSession.findUniqueOrThrow({
      where: { id: chatSessionId },
    })

    if (session.linuxUser) return session.linuxUser

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    if (!workspace.containerId || workspace.containerStatus !== 'running') {
      throw new Error('Workspace container is not running')
    }

    const container = docker.getContainer(workspace.containerId)
    const username = `conv-${chatSessionId.slice(0, 8)}`
    const homeDir = `/workspace/users/${username}`

    // Create user with home dir, bash shell, and sudo access (idempotent)
    await execSimple(
      container,
      `id ${username} 2>/dev/null || (useradd -m -d ${homeDir} -s /bin/bash ${username} && mkdir -p ${homeDir} && chown ${username}:${username} ${homeDir})`,
    )
    // Grant passwordless sudo
    await execSimple(
      container,
      `echo '${username} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${username} 2>/dev/null || true`,
    )

    // Copy credentials from skel if available (AWS, GWS, etc.)
    await execSimple(
      container,
      [
        `if [ -d /etc/skel/.aws ]; then cp -r /etc/skel/.aws ${homeDir}/.aws 2>/dev/null; chown -R ${username}:${username} ${homeDir}/.aws 2>/dev/null; fi`,
        `if [ -d /etc/skel/.config/gws ]; then mkdir -p ${homeDir}/.config/gws; cp -r /etc/skel/.config/gws/* ${homeDir}/.config/gws/ 2>/dev/null; chown -R ${username}:${username} ${homeDir}/.config 2>/dev/null; fi`,
      ].join(' || true\n') + ' || true',
    )

    await prisma.chatSession.update({
      where: { id: chatSessionId },
      data: { linuxUser: username },
    })

    console.log(`[Sandbox] Created user ${username} for session ${chatSessionId} in workspace ${workspaceId}`)
    return username
  },

  /**
   * Execute a command in the workspace container as a specific user.
   */
  async execInWorkspace(
    workspaceId: string,
    command: string,
    username: string,
    options?: { timeout?: number; workingDir?: string },
  ): Promise<ExecResult> {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })

    if (!workspace.containerId || workspace.containerStatus !== 'running') {
      // Try to restart
      throw new Error('Workspace container is not running')
    }

    try {
      const result = await this._execInContainerDirect(workspace.containerId, command, username, options)
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { containerLastActivityAt: new Date() },
      })
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('no such container') || msg.includes('is not running')) {
        console.warn(`[Sandbox] Workspace container gone for ${workspaceId}, recreating...`)
        await this.getOrCreateWorkspaceContainer(workspaceId, { networkAccess: true })
        await this.ensureConversationUser(workspaceId, '') // users will be recreated on next exec
        const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
        return this._execInContainerDirect(ws.containerId!, command, username, options)
      }
      throw err
    }
  },

  /**
   * Internal: execute a command directly in a container by containerId.
   */
  async _execInContainerDirect(
    containerId: string,
    command: string,
    user?: string,
    options?: { timeout?: number; workingDir?: string },
  ): Promise<ExecResult> {
    const container = docker.getContainer(containerId)
    const timeoutMs = Math.min(
      (options?.timeout ?? SANDBOX_DEFAULT_EXEC_TIMEOUT_S) * 1000,
      SANDBOX_MAX_TIMEOUT_MS,
    )

    const workingDir = options?.workingDir ?? '/workspace'

    const exec = await container.exec({
      Cmd: ['bash', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: workingDir,
      User: user || undefined,
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
          } catch {
            // Fallback
          }

          const rawStdout = stripNullBytes(Buffer.concat(stdoutChunks).toString('utf-8')).trim().slice(0, EXEC_OUTPUT_MAX_BYTES)
          const rawStderr = stripNullBytes(Buffer.concat(stderrChunks).toString('utf-8')).trim().slice(0, EXEC_OUTPUT_MAX_BYTES)

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
   * Stop a workspace container.
   */
  async stopWorkspaceContainer(workspaceId: string) {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    if (workspace.containerId) {
      try {
        const container = docker.getContainer(workspace.containerId)
        await container.stop({ t: SANDBOX_STOP_TIMEOUT_S }).catch(() => {})
        await container.remove({ force: true }).catch(() => {})
      } catch { /* already gone */ }
    }
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { containerStatus: 'stopped', containerId: null },
    })
    // Clear linuxUser from all sessions in this workspace
    await prisma.chatSession.updateMany({
      where: { workspaceId },
      data: { linuxUser: null },
    })
  },

  /**
   * Get workspace container status.
   */
  async getWorkspaceContainerStatus(workspaceId: string): Promise<{ status: string; containerId: string | null }> {
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
      } catch {
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
        await container.stop({ t: SANDBOX_STOP_TIMEOUT_S }).catch(() => {})
        await container.remove({ force: true }).catch(() => {})
      } catch {
        // Container may already be gone
      }
    }

    await prisma.sandboxSession.update({
      where: { id: sandboxSessionId },
      data: { status: 'stopped', stoppedAt: new Date() },
    })
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
        OR: [
          { containerLastActivityAt: null },
          { containerLastActivityAt: { lt: idleThreshold } },
        ],
      },
    })

    for (const workspace of idleWorkspaces) {
      console.log(`[Sandbox] Stopping idle workspace container for ${workspace.id}`)
      await this.stopWorkspaceContainer(workspace.id).catch((err) => {
        console.error(`[Sandbox] Failed to stop idle container for ${workspace.id}:`, err)
      })
    }

    // 2. Clean orphaned Docker containers
    try {
      const containers = await docker.listContainers({
        filters: { label: ['agentbuddy.managed=true'] },
      })

      const activeContainerIds = new Set(
        (await prisma.sandboxSession.findMany({
          where: { status: 'running' },
          select: { containerId: true },
        })).map((s) => s.containerId).filter(Boolean),
      )

      const workspaceContainerIds = new Set(
        (await prisma.workspace.findMany({
          where: { containerStatus: 'running' },
          select: { containerId: true },
        })).map((w) => w.containerId).filter(Boolean),
      )

      for (const container of containers) {
        if (!activeContainerIds.has(container.Id) && !workspaceContainerIds.has(container.Id)) {
          const startedAt = container.Created ? container.Created * 1000 : 0
          if (Date.now() - startedAt > SANDBOX_IDLE_TIMEOUT_MS) {
            console.log(`[Sandbox] Removing orphaned container ${container.Id.slice(0, 12)}`)
            const c = docker.getContainer(container.Id)
            await c.stop({ t: 5 }).catch(() => {})
            await c.remove({ force: true }).catch(() => {})
          }
        }
      }
    } catch (err) {
      console.error('[Sandbox] Failed to clean orphaned containers:', err)
    }
  },
}
