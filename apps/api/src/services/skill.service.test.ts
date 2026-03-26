import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

vi.mock('@prisma/client', () => ({
  Prisma: {},
}))

vi.mock('./storage.service.js', () => ({
  storageService: {
    upload: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(null),
    listObjects: vi.fn().mockResolvedValue([]),
    deleteObject: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('./image-builder.service.js', () => ({
  imageBuilderService: {
    testSkillInstallation: vi.fn().mockResolvedValue({ success: true, logs: '' }),
  },
}))

vi.mock('../capabilities/skill-parser.js', () => ({
  parseSkillFile: vi.fn().mockReturnValue({
    skill: {
      slug: 'test-skill',
      version: '1.0.0',
      installation: null,
    },
    dbData: {
      slug: 'test-skill',
      name: 'Test Skill',
      description: 'A test skill',
      icon: 'test',
      category: 'general',
      version: '1.0.0',
      toolDefinitions: [],
      systemPrompt: 'test',
      networkAccess: false,
      configSchema: null,
      skillType: 'custom',
      installationScript: null,
      source: 'uploaded',
    },
  }),
}))

vi.mock('./tool-discovery.service.js', () => ({
  toolDiscoveryService: {
    indexCapabilities: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Mock fs for seedBundledSkills
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockReturnValue('{}'),
  readdirSync: vi.fn().mockReturnValue([]),
}))

import { skillService } from './skill.service.js'
import { parseSkillFile } from '../capabilities/skill-parser.js'
import { storageService } from './storage.service.js'
import { imageBuilderService } from './image-builder.service.js'

const mockStorageService = vi.mocked(storageService)
const mockImageBuilderService = vi.mocked(imageBuilderService)

describe('skill.service', () => {
  beforeEach(() => {
    mockPrisma = createMockPrisma()
    vi.clearAllMocks()
  })

  // ── uploadSkill ───────────────────────────────────────────────────────

  describe('uploadSkill', () => {
    test('returns error for invalid JSON', async () => {
      const result = await skillService.uploadSkill('not valid json')
      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid JSON in .skill file')
    })

    test('returns error when skill validation fails', async () => {
      vi.mocked(parseSkillFile).mockImplementationOnce(() => {
        throw new Error('Missing required field: name')
      })

      const result = await skillService.uploadSkill('{}')
      expect(result.success).toBe(false)
      expect(result.error).toContain('Skill validation failed')
    })

    test('uploads skill and upserts capability in DB', async () => {
      const result = await skillService.uploadSkill(
        JSON.stringify({ name: 'test', slug: 'test-skill' }),
      )

      expect(result.success).toBe(true)
      expect(result.slug).toBe('test-skill')
      expect(mockStorageService.upload).toHaveBeenCalledWith(
        'skills/test-skill.skill',
        expect.any(Buffer),
        'application/json',
      )
      expect(mockPrisma.capability.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: 'test-skill' },
        }),
      )
    })

    test('handles Buffer input', async () => {
      const result = await skillService.uploadSkill(Buffer.from(JSON.stringify({ name: 'test' })))
      expect(result.success).toBe(true)
    })

    test('tests installation script when present', async () => {
      vi.mocked(parseSkillFile).mockReturnValueOnce({
        skill: {
          slug: 'test-skill',
          version: '1.0.0',
          installation: 'apt-get install -y curl',
        },
        dbData: {
          slug: 'test-skill',
          name: 'Test Skill',
          description: 'test',
          icon: 'test',
          category: 'general',
          version: '1.0.0',
          toolDefinitions: [],
          systemPrompt: '',
          networkAccess: false,
          configSchema: null,
          skillType: 'custom',
          installationScript: 'apt-get install -y curl',
          source: 'uploaded',
        },
      } as ReturnType<typeof parseSkillFile>)

      const onBuildLog = vi.fn()
      const result = await skillService.uploadSkill('{}', onBuildLog)

      expect(mockImageBuilderService.testSkillInstallation).toHaveBeenCalledWith(
        'apt-get install -y curl',
        onBuildLog,
      )
      expect(result.success).toBe(true)
      expect(onBuildLog).toHaveBeenCalledWith('Testing installation script...')
    })

    test('returns error when installation script build fails', async () => {
      vi.mocked(parseSkillFile).mockReturnValueOnce({
        skill: {
          slug: 'test-skill',
          version: '1.0.0',
          installation: 'bad-command',
        },
        dbData: {
          slug: 'test-skill',
          name: 'Test',
          description: '',
          icon: '',
          category: 'general',
          version: '1.0.0',
          toolDefinitions: [],
          systemPrompt: '',
          networkAccess: false,
          configSchema: null,
          skillType: 'custom',
          installationScript: 'bad-command',
          source: 'uploaded',
        },
      } as ReturnType<typeof parseSkillFile>)

      mockImageBuilderService.testSkillInstallation.mockResolvedValueOnce({
        success: false,
        logs: 'Build failed: command not found',
      })

      const result = await skillService.uploadSkill('{}')
      expect(result.success).toBe(false)
      expect(result.error).toBe('Installation script failed to build')
      expect(result.logs).toContain('Build failed')
    })
  })

  // ── deleteSkill ───────────────────────────────────────────────────────

  describe('deleteSkill', () => {
    test('returns error when skill not found', async () => {
      mockPrisma.capability.findUnique.mockResolvedValueOnce(null)

      const result = await skillService.deleteSkill('nonexistent')
      expect(result.success).toBe(false)
      expect(result.error).toBe('Skill not found')
    })

    test('prevents deleting builtin capabilities', async () => {
      mockPrisma.capability.findUnique.mockResolvedValueOnce({
        slug: 'builtin-cap',
        source: 'builtin',
      })

      const result = await skillService.deleteSkill('builtin-cap')
      expect(result.success).toBe(false)
      expect(result.error).toBe('Cannot delete builtin capabilities')
    })

    test('deletes skill from storage and DB', async () => {
      mockPrisma.capability.findUnique.mockResolvedValueOnce({
        slug: 'my-skill',
        source: 'uploaded',
        skillFileKey: 'skills/my-skill.skill',
      })

      const result = await skillService.deleteSkill('my-skill')
      expect(result.success).toBe(true)
      expect(mockStorageService.deleteObject).toHaveBeenCalledWith('skills/my-skill.skill')
      expect(mockPrisma.capability.delete).toHaveBeenCalledWith({
        where: { slug: 'my-skill' },
      })
    })

    test('succeeds even if storage deletion fails', async () => {
      mockPrisma.capability.findUnique.mockResolvedValueOnce({
        slug: 'my-skill',
        source: 'uploaded',
        skillFileKey: 'skills/my-skill.skill',
      })
      mockStorageService.deleteObject.mockRejectedValueOnce(new Error('Storage error'))

      const result = await skillService.deleteSkill('my-skill')
      expect(result.success).toBe(true)
      expect(mockPrisma.capability.delete).toHaveBeenCalled()
    })

    test('handles skill with no skillFileKey', async () => {
      mockPrisma.capability.findUnique.mockResolvedValueOnce({
        slug: 'my-skill',
        source: 'uploaded',
        skillFileKey: null,
      })

      const result = await skillService.deleteSkill('my-skill')
      expect(result.success).toBe(true)
      expect(mockStorageService.deleteObject).not.toHaveBeenCalled()
    })
  })

  // ── listSkills ────────────────────────────────────────────────────────

  describe('listSkills', () => {
    test('lists non-builtin capabilities', async () => {
      const skills = [
        { slug: 'skill-1', source: 'uploaded', category: 'dev' },
        { slug: 'skill-2', source: 'uploaded', category: 'web' },
      ]
      mockPrisma.capability.findMany.mockResolvedValueOnce(skills)

      const result = await skillService.listSkills()
      expect(result).toEqual(skills)
      expect(mockPrisma.capability.findMany).toHaveBeenCalledWith({
        where: { source: { not: 'builtin' } },
        orderBy: { category: 'asc' },
      })
    })

    test('returns empty array when no skills exist', async () => {
      mockPrisma.capability.findMany.mockResolvedValueOnce([])
      const result = await skillService.listSkills()
      expect(result).toEqual([])
    })
  })

  // ── syncSkillsFromStorage ─────────────────────────────────────────────

  describe('syncSkillsFromStorage', () => {
    test('processes .skill files from storage', async () => {
      mockStorageService.listObjects.mockResolvedValueOnce([
        { Key: 'skills/test-skill.skill' },
        { Key: 'skills/readme.txt' }, // should be skipped
      ])

      // Mock download to return an async iterable
      const content = JSON.stringify({ name: 'test', slug: 'test-skill' })
      mockStorageService.download.mockResolvedValueOnce(
        (async function* () {
          yield Buffer.from(content)
        })(),
      )

      await skillService.syncSkillsFromStorage()

      expect(mockStorageService.listObjects).toHaveBeenCalledWith('skills/')
      expect(mockPrisma.capability.upsert).toHaveBeenCalled()
    })

    test('handles storage errors gracefully', async () => {
      mockStorageService.listObjects.mockRejectedValueOnce(new Error('Storage unreachable'))

      // Should not throw
      await expect(skillService.syncSkillsFromStorage()).resolves.not.toThrow()
    })

    test('throws when throwOnError option set', async () => {
      mockStorageService.listObjects.mockRejectedValueOnce(new Error('Storage unreachable'))

      await expect(skillService.syncSkillsFromStorage({ throwOnError: true })).rejects.toThrow(
        'Storage unreachable',
      )
    })
  })
})
