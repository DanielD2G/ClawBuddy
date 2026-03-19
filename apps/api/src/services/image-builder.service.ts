import Docker from 'dockerode'
import { createHash } from 'crypto'
import { prisma } from '../lib/prisma.js'
import { IMAGE_TAG_HASH_LENGTH, SANDBOX_BASE_DOCKERFILE, SANDBOX_BASE_IMAGE } from '../constants.js'

const docker = new Docker()

interface BuildResult {
  success: boolean
  logs: string
  tag?: string
}

export const imageBuilderService = {
  /**
   * Ensure the base sandbox image exists, building it from the Dockerfile if missing.
   */
  async ensureBaseImage(onLog?: (line: string) => void): Promise<void> {
    try {
      await docker.getImage(SANDBOX_BASE_IMAGE).inspect()
      return // already exists
    } catch {
      // Image doesn't exist — build it
    }

    onLog?.('Building base sandbox image...')

    const result = await this.buildFromDockerfile(
      SANDBOX_BASE_DOCKERFILE,
      SANDBOX_BASE_IMAGE,
      onLog,
    )

    if (!result.success) {
      throw new Error(`Failed to build base sandbox image: ${result.logs}`)
    }

    onLog?.('Base sandbox image built successfully')
  },

  /**
   * Test a skill's installation script by attempting a Docker build.
   * Returns success/failure with build logs.
   */
  async testSkillInstallation(
    installationScript: string,
    onLog?: (line: string) => void,
  ): Promise<BuildResult> {
    await this.ensureBaseImage(onLog)

    const testTag = `clawbuddy-skill-test-${Date.now()}`
    const dockerfile = [
      `FROM ${SANDBOX_BASE_IMAGE}`,
      'USER root',
      `RUN ${installationScript}`,
      'USER sandbox',
    ].join('\n')

    try {
      const result = await this.buildFromDockerfile(dockerfile, testTag, onLog)

      // Clean up test image on success
      if (result.success) {
        try {
          await docker.getImage(testTag).remove({ force: true })
        } catch {
          // Ignore cleanup errors
        }
      }

      return result
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { success: false, logs: `Build error: ${error}` }
    }
  },

  /**
   * Build or retrieve the skill image for a workspace, containing all
   * workspace-enabled capabilities with installation scripts.
   */
  async getOrBuildImage(workspaceId: string, onLog?: (line: string) => void): Promise<string> {
    await this.ensureBaseImage(onLog)

    const workspaceCapabilities = await prisma.workspaceCapability.findMany({
      where: {
        workspaceId,
        enabled: true,
        capability: { installationScript: { not: null } },
      },
      include: { capability: true },
      orderBy: { capability: { slug: 'asc' } },
    })

    const capabilities = workspaceCapabilities.map((wc) => wc.capability)

    // If no skills have installation scripts, use base image
    if (!capabilities.length) {
      return SANDBOX_BASE_IMAGE
    }

    // Generate deterministic tag from installation scripts
    const hash = createHash('sha256')
      .update(capabilities.map((c) => `${c.slug}:${c.installationScript}`).join('\n'))
      .digest('hex')
      .slice(0, IMAGE_TAG_HASH_LENGTH)
    const tag = `clawbuddy-sandbox-skills-${hash}`

    // Check if image already exists
    try {
      await docker.getImage(tag).inspect()
      return tag
    } catch {
      // Image doesn't exist, build it
    }

    // Generate Dockerfile
    const dockerfileLines = [`FROM ${SANDBOX_BASE_IMAGE}`, 'USER root', '']
    for (const cap of capabilities) {
      if (cap.installationScript) {
        dockerfileLines.push(`# Skill: ${cap.slug}`)
        dockerfileLines.push(`RUN ${cap.installationScript}`)
        dockerfileLines.push('')
      }
    }
    dockerfileLines.push('USER sandbox')
    dockerfileLines.push('CMD ["sleep", "infinity"]')

    const dockerfile = dockerfileLines.join('\n')
    const result = await this.buildFromDockerfile(dockerfile, tag, onLog)

    if (!result.success) {
      console.error(`[ImageBuilder] Failed to build skill image:`, result.logs)
      // Fall back to base image
      return SANDBOX_BASE_IMAGE
    }

    return tag
  },

  /**
   * Build a Docker image from a Dockerfile string using tar-stream.
   */
  async buildFromDockerfile(
    dockerfile: string,
    tag: string,
    onLog?: (line: string) => void,
  ): Promise<BuildResult> {
    // Dynamically import tar-stream to create in-memory tar
    const { pack } = await import('tar-stream')

    return new Promise<BuildResult>((resolve) => {
      const tarPack = pack()
      tarPack.entry({ name: 'Dockerfile' }, dockerfile)
      tarPack.finalize()

      const logs: string[] = []

      docker.buildImage(tarPack as unknown as NodeJS.ReadableStream, { t: tag }, (err, stream) => {
        if (err) {
          resolve({
            success: false,
            logs: `Docker build error: ${err.message}`,
          })
          return
        }

        if (!stream) {
          resolve({ success: false, logs: 'No build stream returned' })
          return
        }

        stream.on('data', (chunk: Buffer) => {
          const lines = chunk.toString('utf-8').trim().split('\n')
          for (const line of lines) {
            try {
              const json = JSON.parse(line)
              if (json.stream) {
                const text = json.stream.replace(/\n$/, '')
                if (text) {
                  logs.push(text)
                  onLog?.(text)
                }
              }
              if (json.error) {
                logs.push(`ERROR: ${json.error}`)
                onLog?.(`ERROR: ${json.error}`)
              }
            } catch {
              if (line.trim()) {
                logs.push(line)
                onLog?.(line)
              }
            }
          }
        })

        stream.on('end', () => {
          const hasError = logs.some((l) => l.startsWith('ERROR:'))
          resolve({
            success: !hasError,
            logs: logs.join('\n'),
            tag: hasError ? undefined : tag,
          })
        })

        stream.on('error', (err: Error) => {
          resolve({
            success: false,
            logs: [...logs, `Stream error: ${err.message}`].join('\n'),
          })
        })
      })
    })
  },

  /**
   * Remove old skill images to free disk space.
   */
  async invalidateImages() {
    try {
      const images = await docker.listImages()
      for (const img of images) {
        const tags = img.RepoTags ?? []
        for (const tag of tags) {
          if (tag.startsWith('clawbuddy-sandbox-skills-')) {
            try {
              await docker.getImage(tag).remove({ force: true })
            } catch {
              // Ignore removal errors
            }
          }
        }
      }
    } catch (err) {
      console.error('[ImageBuilder] Failed to invalidate images:', err)
    }
  },
}
