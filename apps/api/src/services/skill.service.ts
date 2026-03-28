import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { parseSkillSource } from '../capabilities/skill-parser.js'
import { storageService } from './storage.service.js'
import { imageBuilderService } from './image-builder.service.js'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { logger } from '../lib/logger.js'

const SKILLS_PREFIX = 'skills/'

function isSkillStorageKey(key: string): boolean {
  return key.endsWith('.skill') || key.endsWith('.md')
}

function skillSlugFromStorageKey(key: string): string {
  return key.replace(/^skills\//, '').replace(/\.(skill|md)$/, '')
}

function collectBundledSkillFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      files.push(...collectBundledSkillFiles(fullPath))
      continue
    }

    if (entry.isFile() && (entry.name === 'SKILL.md' || entry.name.endsWith('.skill'))) {
      files.push(fullPath)
    }
  }

  return files
}

export const skillService = {
  /**
   * Upload and install a skill from a legacy .skill file or a Markdown skill file.
   * If the skill has an installation script, it will be validated
   * by attempting a Docker build first.
   */
  async uploadSkill(
    fileContent: Buffer | string,
    options?: {
      fileName?: string
      onBuildLog?: (line: string) => void
    },
  ): Promise<{
    success: boolean
    error?: string
    logs?: string
    slug?: string
  }> {
    const content = typeof fileContent === 'string' ? fileContent : fileContent.toString('utf-8')

    // Validate and parse
    let parsed: ReturnType<typeof parseSkillSource>
    try {
      parsed = parseSkillSource(content)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: `Skill validation failed: ${message}` }
    }

    const { skill, dbData } = parsed

    // If skill has installation script, test the Docker build
    if (skill.installation) {
      options?.onBuildLog?.('Testing installation script...')
      const buildResult = await imageBuilderService.testSkillInstallation(
        skill.installation,
        options?.onBuildLog,
      )

      if (!buildResult.success) {
        return {
          success: false,
          error: 'Installation script failed to build',
          logs: buildResult.logs,
        }
      }
      options?.onBuildLog?.('Installation script validated successfully.')
    }

    // Upload skill source to MinIO
    const skillKey = `${SKILLS_PREFIX}${skill.slug}${parsed.storageExtension}`
    await storageService.upload(skillKey, Buffer.from(content, 'utf-8'), parsed.contentType)
    const alternateKey = `${SKILLS_PREFIX}${skill.slug}${parsed.storageExtension === '.md' ? '.skill' : '.md'}`
    await storageService.deleteObject(alternateKey).catch(() => undefined)

    // Upsert capability in DB
    await prisma.capability.upsert({
      where: { slug: skill.slug },
      create: {
        ...dbData,
        skillFileKey: skillKey,
        configSchema: dbData.configSchema as Prisma.InputJsonValue | undefined,
        toolDefinitions: dbData.toolDefinitions,
      },
      update: {
        ...dbData,
        skillFileKey: skillKey,
        configSchema: dbData.configSchema as Prisma.InputJsonValue | undefined,
        toolDefinitions: dbData.toolDefinitions,
      },
    })

    // Re-index tool discovery after skill changes
    const { toolDiscoveryService } = await import('./tool-discovery.service.js')
    toolDiscoveryService.indexCapabilities().catch((err) => {
      logger.error('[SkillService] Failed to re-index tool discovery', err)
    })

    return { success: true, slug: skill.slug }
  },

  /**
   * Sync skills from MinIO storage into the database.
   * Called on server startup.
   */
  async syncSkillsFromStorage(options?: { throwOnError?: boolean }) {
    try {
      // First, seed bundled skills from filesystem to MinIO if they don't exist
      await this.seedBundledSkills()

      // List all skill files in MinIO
      const objects = await storageService.listObjects(SKILLS_PREFIX)
      const preferredObjects = new Map<string, string>()

      for (const obj of objects) {
        if (!obj.Key || !isSkillStorageKey(obj.Key)) continue

        const slug = skillSlugFromStorageKey(obj.Key)
        const current = preferredObjects.get(slug)
        if (!current || (obj.Key.endsWith('.md') && current.endsWith('.skill'))) {
          preferredObjects.set(slug, obj.Key)
        }
      }

      for (const key of preferredObjects.values()) {
        const objKey = key

        try {
          const body = await storageService.download(objKey)
          if (!body) continue

          const chunks: Buffer[] = []
          for await (const chunk of body as AsyncIterable<Buffer>) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          }
          const content = Buffer.concat(chunks).toString('utf-8')
          const { dbData } = parseSkillSource(content)

          await prisma.capability.upsert({
            where: { slug: dbData.slug },
            create: {
              ...dbData,
              skillFileKey: objKey,
              configSchema: dbData.configSchema as Prisma.InputJsonValue | undefined,
              toolDefinitions: dbData.toolDefinitions,
            },
            update: {
              name: dbData.name,
              description: dbData.description,
              icon: dbData.icon,
              category: dbData.category,
              version: dbData.version,
              toolDefinitions: dbData.toolDefinitions,
              systemPrompt: dbData.systemPrompt,
              networkAccess: dbData.networkAccess,
              configSchema: dbData.configSchema as Prisma.InputJsonValue | undefined,
              skillType: dbData.skillType,
              installationScript: dbData.installationScript,
              source: dbData.source,
              skillFileKey: objKey,
            },
          })
        } catch (err) {
          logger.error(`[SkillService] Failed to sync skill ${objKey}`, err)
        }
      }
    } catch (err) {
      logger.error('[SkillService] Failed to sync skills from storage', err)
      if (options?.throwOnError) {
        throw err
      }
    }
  },

  /**
   * Seed bundled skill files from the filesystem to MinIO
   * (only if they don't already exist).
   */
  async seedBundledSkills() {
    // In dev: import.meta.dir = src/services/ → ../../skills = apps/api/skills ✓
    // In prod bundle: import.meta.dir = dist/ → ../skills = apps/api/skills ✓
    const baseDir = import.meta.dir ?? process.cwd()
    const isDist = baseDir.endsWith('/dist') || baseDir.includes('/dist/')
    const skillsDir = isDist ? join(baseDir, '..', 'skills') : join(baseDir, '..', '..', 'skills')

    let files: string[]
    try {
      files = collectBundledSkillFiles(skillsDir)
    } catch {
      // skills directory doesn't exist, skip
      return
    }

    for (const filePath of files) {
      const content = readFileSync(filePath, 'utf-8')

      try {
        const parsed = parseSkillSource(content)
        const key = `${SKILLS_PREFIX}${parsed.skill.slug}${parsed.storageExtension}`

        // Check if we need to update: compare version with DB
        const existing = await prisma.capability.findUnique({
          where: { slug: parsed.skill.slug },
          select: { version: true, skillFileKey: true },
        })

        if (
          existing &&
          existing.version === parsed.skill.version &&
          existing.skillFileKey === key
        ) {
          continue
        }

        await storageService.upload(key, Buffer.from(content, 'utf-8'), parsed.contentType)
      } catch (err) {
        logger.error(`[SkillService] Failed to seed bundled skill ${filePath}`, err)
      }
    }
  },

  /**
   * Delete a skill (only non-builtin skills).
   */
  async deleteSkill(slug: string): Promise<{ success: boolean; error?: string }> {
    const capability = await prisma.capability.findUnique({ where: { slug } })
    if (!capability) {
      return { success: false, error: 'Skill not found' }
    }
    if (capability.source === 'builtin') {
      return { success: false, error: 'Cannot delete builtin capabilities' }
    }

    // Remove from MinIO
    if (capability.skillFileKey) {
      try {
        await storageService.deleteObject(capability.skillFileKey)
      } catch {
        // Ignore deletion errors
      }
    }

    // Remove from DB
    await prisma.capability.delete({ where: { slug } })

    // Re-index tool discovery after skill deletion
    const { toolDiscoveryService } = await import('./tool-discovery.service.js')
    toolDiscoveryService.indexCapabilities().catch((err) => {
      logger.error('[SkillService] Failed to re-index tool discovery after delete', err)
    })

    return { success: true }
  },

  /**
   * List all skills (non-builtin capabilities).
   */
  async listSkills() {
    return prisma.capability.findMany({
      where: { source: { not: 'builtin' } },
      orderBy: { category: 'asc' },
    })
  },
}
