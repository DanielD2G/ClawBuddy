import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { parseSkillFile } from '../capabilities/skill-parser.js'
import { storageService } from './storage.service.js'
import { imageBuilderService } from './image-builder.service.js'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { logger } from '../lib/logger.js'

const SKILLS_PREFIX = 'skills/'

export const skillService = {
  /**
   * Upload and install a skill from a .skill file buffer.
   * If the skill has an installation script, it will be validated
   * by attempting a Docker build first.
   */
  async uploadSkill(
    fileContent: Buffer | string,
    onBuildLog?: (line: string) => void,
  ): Promise<{
    success: boolean
    error?: string
    logs?: string
    slug?: string
  }> {
    // Parse the JSON
    let raw: unknown
    try {
      raw = JSON.parse(
        typeof fileContent === 'string' ? fileContent : fileContent.toString('utf-8'),
      )
    } catch {
      return { success: false, error: 'Invalid JSON in .skill file' }
    }

    // Validate and parse
    let parsed: ReturnType<typeof parseSkillFile>
    try {
      parsed = parseSkillFile(raw)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: `Skill validation failed: ${message}` }
    }

    const { skill, dbData } = parsed

    // If skill has installation script, test the Docker build
    if (skill.installation) {
      onBuildLog?.('Testing installation script...')
      const buildResult = await imageBuilderService.testSkillInstallation(
        skill.installation,
        onBuildLog,
      )

      if (!buildResult.success) {
        return {
          success: false,
          error: 'Installation script failed to build',
          logs: buildResult.logs,
        }
      }
      onBuildLog?.('Installation script validated successfully.')
    }

    // Upload .skill file to MinIO
    const skillKey = `${SKILLS_PREFIX}${skill.slug}.skill`
    const content = typeof fileContent === 'string' ? fileContent : fileContent.toString('utf-8')
    await storageService.upload(skillKey, Buffer.from(content, 'utf-8'), 'application/json')

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

      // List all .skill files in MinIO
      const objects = await storageService.listObjects(SKILLS_PREFIX)

      for (const obj of objects) {
        if (!obj.Key?.endsWith('.skill')) continue

        try {
          const body = await storageService.download(obj.Key)
          if (!body) continue

          const chunks: Buffer[] = []
          for await (const chunk of body as AsyncIterable<Buffer>) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          }
          const content = Buffer.concat(chunks).toString('utf-8')
          const raw = JSON.parse(content)
          const { dbData } = parseSkillFile(raw)

          await prisma.capability.upsert({
            where: { slug: dbData.slug },
            create: {
              ...dbData,
              skillFileKey: obj.Key,
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
              skillFileKey: obj.Key,
            },
          })
        } catch (err) {
          logger.error(`[SkillService] Failed to sync skill ${obj.Key}`, err)
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
   * Seed bundled .skill files from the filesystem to MinIO
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
      files = readdirSync(skillsDir).filter((f) => f.endsWith('.skill'))
    } catch {
      // skills directory doesn't exist, skip
      return
    }

    for (const file of files) {
      const key = `${SKILLS_PREFIX}${file}`

      try {
        const content = readFileSync(join(skillsDir, file), 'utf-8')
        const { skill } = parseSkillFile(JSON.parse(content))

        // Check if we need to update: compare version with DB
        const existing = await prisma.capability.findUnique({
          where: { slug: skill.slug },
          select: { version: true },
        })

        if (existing && existing.version === skill.version) continue

        await storageService.upload(key, Buffer.from(content, 'utf-8'), 'application/json')
      } catch (err) {
        logger.error(`[SkillService] Failed to seed bundled skill ${file}`, err)
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
