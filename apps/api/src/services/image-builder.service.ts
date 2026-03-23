import Docker from 'dockerode'
import { createHash } from 'crypto'
import { prisma } from '../lib/prisma.js'
import { IMAGE_TAG_HASH_LENGTH, SANDBOX_BASE_DOCKERFILE, SANDBOX_BASE_IMAGE } from '../constants.js'

const docker = new Docker()
const SANDBOX_LAYER_IMAGE_PREFIX = 'clawbuddy-sandbox-layer-'
const SKILL_TEST_IMAGE_PREFIX = 'clawbuddy-skill-test-'

interface BuildResult {
  success: boolean
  logs: string
  tag?: string
}

interface BuildFromDockerfileOptions {
  cacheFrom?: string[]
  onLog?: (line: string) => void
}

type WorkspaceCapabilityRow = {
  capability: {
    slug: string
    installationScript: string | null
  }
}

export const imageBuilderService = {
  createImageTag(prefix: string, ...parts: string[]) {
    const hash = createHash('sha256')
      .update(parts.join('\n'))
      .digest('hex')
      .slice(0, IMAGE_TAG_HASH_LENGTH)

    return `${prefix}${hash}`
  },

  async imageExists(tag: string): Promise<boolean> {
    try {
      await docker.getImage(tag).inspect()
      return true
    } catch {
      return false
    }
  },

  async buildInstallationLayer(
    parentImage: string,
    installationScript: string,
    tag: string,
    onLog?: (line: string) => void,
  ): Promise<BuildResult> {
    const dockerfile = [
      `FROM ${parentImage}`,
      `RUN ${installationScript}`,
      'WORKDIR /workspace',
      'CMD ["sleep", "infinity"]',
    ].join('\n')

    return this.buildFromDockerfile(dockerfile, tag, {
      cacheFrom: [tag, parentImage],
      onLog,
    })
  },

  /**
   * Ensure the base sandbox image exists, building it from the Dockerfile if missing.
   */
  async ensureBaseImage(onLog?: (line: string) => void): Promise<void> {
    if (await this.imageExists(SANDBOX_BASE_IMAGE)) {
      return // already exists
    }

    onLog?.('Building base sandbox image...')

    const result = await this.buildFromDockerfile(SANDBOX_BASE_DOCKERFILE, SANDBOX_BASE_IMAGE, {
      cacheFrom: [SANDBOX_BASE_IMAGE],
      onLog,
    })

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

    const testTag = this.createImageTag(
      SKILL_TEST_IMAGE_PREFIX,
      SANDBOX_BASE_IMAGE,
      installationScript,
    )

    try {
      if (await this.imageExists(testTag)) {
        onLog?.('Reusing cached installation image...')
        return {
          success: true,
          logs: 'Using cached installation image',
          tag: testTag,
        }
      }

      return this.buildInstallationLayer(SANDBOX_BASE_IMAGE, installationScript, testTag, onLog)
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

    const workspaceCapabilities = (await prisma.workspaceCapability.findMany({
      where: {
        workspaceId,
        enabled: true,
        capability: { installationScript: { not: null } },
      },
      include: { capability: true },
      orderBy: { capability: { slug: 'asc' } },
    })) as WorkspaceCapabilityRow[]

    const capabilities = workspaceCapabilities.map((wc: WorkspaceCapabilityRow) => wc.capability)

    // If no skills have installation scripts, use base image
    if (!capabilities.length) {
      return SANDBOX_BASE_IMAGE
    }

    let parentImage = SANDBOX_BASE_IMAGE
    for (const cap of capabilities) {
      const installationScript = cap.installationScript
      if (!installationScript) {
        continue
      }

      const tag = this.createImageTag(
        SANDBOX_LAYER_IMAGE_PREFIX,
        parentImage,
        cap.slug,
        installationScript,
      )

      if (await this.imageExists(tag)) {
        onLog?.(`Reusing cached layer for ${cap.slug}...`)
        parentImage = tag
        continue
      }

      onLog?.(`Building layer for ${cap.slug}...`)
      const result = await this.buildInstallationLayer(parentImage, installationScript, tag, onLog)

      if (!result.success) {
        console.error(`[ImageBuilder] Failed to build skill image:`, result.logs)
        // Fall back to base image
        return SANDBOX_BASE_IMAGE
      }

      parentImage = tag
    }

    return parentImage
  },

  /**
   * Build a Docker image from a Dockerfile string using tar-stream.
   */
  async buildFromDockerfile(
    dockerfile: string,
    tag: string,
    options: BuildFromDockerfileOptions = {},
  ): Promise<BuildResult> {
    // Dynamically import tar-stream to create in-memory tar
    const { pack } = await import('tar-stream')
    const { cacheFrom = [], onLog } = options

    return new Promise<BuildResult>((resolve) => {
      const tarPack = pack()
      tarPack.entry({ name: 'Dockerfile' }, dockerfile)
      tarPack.finalize()

      const logs: string[] = []

      docker.buildImage(
        tarPack as unknown as NodeJS.ReadableStream,
        {
          t: tag,
          rm: true,
          forcerm: true,
          cachefrom: JSON.stringify(cacheFrom),
        },
        (err, stream) => {
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
        },
      )
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
          if (
            tag.startsWith(SANDBOX_LAYER_IMAGE_PREFIX) ||
            tag.startsWith(SKILL_TEST_IMAGE_PREFIX)
          ) {
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
