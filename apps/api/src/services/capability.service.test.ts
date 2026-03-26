import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

vi.mock('../env.js', () => ({
  env: {
    ENCRYPTION_SECRET: 'vitest-encryption-secret',
    AI_PROVIDER: 'openai',
    EMBEDDING_PROVIDER: 'openai',
    OPENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    LOCAL_PROVIDER_BASE_URL: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
  },
}))

vi.mock('./crypto.service.js', () => ({
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  decrypt: vi.fn((v: string) => {
    if (v.startsWith('encrypted:')) return v.slice('encrypted:'.length)
    throw new Error('decrypt failed')
  }),
}))

vi.mock('../capabilities/builtin/index.js', () => ({
  BUILTIN_CAPABILITIES: [
    {
      slug: 'test-cap',
      name: 'Test Capability',
      description: 'A test capability',
      icon: 'test-icon',
      category: 'general',
      version: '1.0.0',
      tools: [
        {
          name: 'test_tool',
          description: 'A test tool',
          parameters: { type: 'object', properties: {} },
        },
      ],
      systemPrompt: 'You can use test_tool.',
      sandbox: { dockerImage: 'ubuntu:22.04', packages: [], networkAccess: false },
      configSchema: null,
      installationScript: null,
      authType: null,
      skillType: null,
    },
    {
      slug: 'cap-with-config',
      name: 'Configured Capability',
      description: 'A capability with config',
      icon: 'config-icon',
      category: 'general',
      version: '1.0.0',
      tools: [
        {
          name: 'config_tool',
          description: 'A configured tool',
          parameters: { type: 'object', properties: {} },
        },
      ],
      systemPrompt: 'You can use config_tool.',
      sandbox: { dockerImage: 'ubuntu:22.04' },
      configSchema: [
        {
          key: 'api_key',
          label: 'API Key',
          type: 'password',
          required: true,
          envVar: 'MY_API_KEY',
        },
      ],
      installationScript: null,
      authType: null,
      skillType: null,
    },
  ],
}))

vi.mock('../constants.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    ALWAYS_ON_CAPABILITY_SLUGS: ['test-cap'],
  }
})

vi.mock('./config-validation.service.js', () => ({
  validateCapabilityConfig: vi.fn().mockReturnValue({ valid: true, errors: [] }),
  encryptConfigFields: vi.fn().mockImplementation((_schema: unknown, config: unknown) => config),
  decryptConfigFields: vi.fn().mockImplementation((_schema: unknown, config: unknown) => config),
  maskConfigFields: vi.fn().mockImplementation((_schema: unknown, config: unknown) => config),
  mergeWithExistingConfig: vi
    .fn()
    .mockImplementation((_schema: unknown, newConfig: unknown) => newConfig),
}))

vi.mock('./system-prompt-builder.js', () => ({
  buildSystemPrompt: vi.fn().mockReturnValue('System prompt text'),
}))

// ── Import under test (after mocks) ────────────────────────────────────

const { capabilityService } = await import('./capability.service.js')

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPrisma = createMockPrisma()
  vi.clearAllMocks()
})

describe('capabilityService.syncBuiltinCapabilities', () => {
  test('cleans up removed builtin capabilities', async () => {
    mockPrisma.capability.findUnique.mockResolvedValue({
      id: 'old-id',
      slug: 'file-ops',
      builtin: true,
    })
    mockPrisma.workspace.findMany.mockResolvedValue([])

    await capabilityService.syncBuiltinCapabilities()

    expect(mockPrisma.workspaceCapability.deleteMany).toHaveBeenCalledWith({
      where: { capabilityId: 'old-id' },
    })
    expect(mockPrisma.capability.delete).toHaveBeenCalledWith({ where: { slug: 'file-ops' } })
  })

  test('does not delete non-builtin capabilities with removed slugs', async () => {
    mockPrisma.capability.findUnique.mockResolvedValue({
      id: 'old-id',
      slug: 'file-ops',
      builtin: false,
    })
    mockPrisma.workspace.findMany.mockResolvedValue([])

    await capabilityService.syncBuiltinCapabilities()

    expect(mockPrisma.capability.delete).not.toHaveBeenCalled()
  })

  test('upserts all builtin capabilities', async () => {
    mockPrisma.capability.findUnique.mockResolvedValue(null)
    mockPrisma.workspace.findMany.mockResolvedValue([])

    await capabilityService.syncBuiltinCapabilities()

    // 2 builtin capabilities in our mock
    expect(mockPrisma.capability.upsert).toHaveBeenCalledTimes(2)
    expect(mockPrisma.capability.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'test-cap' },
        create: expect.objectContaining({
          slug: 'test-cap',
          name: 'Test Capability',
          builtin: true,
        }),
        update: expect.objectContaining({ name: 'Test Capability' }),
      }),
    )
  })

  test('calls ensureAlwaysOnCapabilities', async () => {
    mockPrisma.capability.findUnique.mockResolvedValue(null)
    mockPrisma.workspace.findMany.mockResolvedValue([])

    const spy = vi
      .spyOn(capabilityService, 'ensureAlwaysOnCapabilities')
      .mockResolvedValue(undefined)
    await capabilityService.syncBuiltinCapabilities()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('capabilityService.ensureAlwaysOnCapabilities', () => {
  test('creates workspace capability records for always-on capabilities', async () => {
    mockPrisma.workspace.findMany.mockResolvedValue([{ id: 'ws-1' }, { id: 'ws-2' }])
    mockPrisma.capability.findMany.mockResolvedValue([{ id: 'cap-1' }])

    await capabilityService.ensureAlwaysOnCapabilities()

    expect(mockPrisma.workspaceCapability.createMany).toHaveBeenCalledWith({
      data: [
        { workspaceId: 'ws-1', capabilityId: 'cap-1', enabled: true },
        { workspaceId: 'ws-2', capabilityId: 'cap-1', enabled: true },
      ],
      skipDuplicates: true,
    })
  })

  test('does nothing when no workspaces exist', async () => {
    mockPrisma.workspace.findMany.mockResolvedValue([])

    await capabilityService.ensureAlwaysOnCapabilities()

    expect(mockPrisma.workspaceCapability.createMany).not.toHaveBeenCalled()
  })

  test('does nothing when no always-on capabilities exist', async () => {
    mockPrisma.workspace.findMany.mockResolvedValue([{ id: 'ws-1' }])
    mockPrisma.capability.findMany.mockResolvedValue([])

    await capabilityService.ensureAlwaysOnCapabilities()

    expect(mockPrisma.workspaceCapability.createMany).not.toHaveBeenCalled()
  })
})

describe('capabilityService.listAll', () => {
  test('returns all capabilities ordered by category', async () => {
    const caps = [
      { id: '1', slug: 'a-cap', category: 'a' },
      { id: '2', slug: 'b-cap', category: 'b' },
    ]
    mockPrisma.capability.findMany.mockResolvedValue(caps)

    const result = await capabilityService.listAll()

    expect(result).toEqual(caps)
    expect(mockPrisma.capability.findMany).toHaveBeenCalledWith({ orderBy: { category: 'asc' } })
  })
})

describe('capabilityService.getEnabledCapabilitiesForWorkspace', () => {
  test('returns enabled capabilities with config', async () => {
    mockPrisma.workspaceCapability.findMany.mockResolvedValue([
      {
        capability: { id: 'cap-1', slug: 'test-cap', name: 'Test' },
        config: { key: 'value' },
      },
    ])

    const result = await capabilityService.getEnabledCapabilitiesForWorkspace('ws-1')

    expect(result).toEqual([
      { id: 'cap-1', slug: 'test-cap', name: 'Test', config: { key: 'value' } },
    ])
    expect(mockPrisma.workspaceCapability.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', enabled: true },
      include: { capability: true },
    })
  })

  test('returns empty array when no capabilities enabled', async () => {
    mockPrisma.workspaceCapability.findMany.mockResolvedValue([])

    const result = await capabilityService.getEnabledCapabilitiesForWorkspace('ws-1')
    expect(result).toEqual([])
  })
})

describe('capabilityService.getDecryptedCapabilityConfigsForWorkspace', () => {
  test('returns decrypted env vars for capabilities with config', async () => {
    mockPrisma.workspaceCapability.findMany.mockResolvedValue([
      {
        capability: {
          id: 'cap-1',
          slug: 'cap-with-config',
          configSchema: [
            {
              key: 'api_key',
              label: 'API Key',
              type: 'password',
              required: true,
              envVar: 'MY_API_KEY',
            },
          ],
        },
        config: { api_key: 'encrypted:secret-key' },
      },
    ])

    const { decryptConfigFields } = await import('./config-validation.service.js')
    vi.mocked(decryptConfigFields).mockReturnValue({ api_key: 'secret-key' })

    const result = await capabilityService.getDecryptedCapabilityConfigsForWorkspace('ws-1')

    expect(result.get('cap-with-config')).toEqual({ MY_API_KEY: 'secret-key' })
  })

  test('skips capabilities without config schema', async () => {
    mockPrisma.workspaceCapability.findMany.mockResolvedValue([
      {
        capability: { id: 'cap-1', slug: 'test-cap', configSchema: null },
        config: null,
      },
    ])

    const result = await capabilityService.getDecryptedCapabilityConfigsForWorkspace('ws-1')
    expect(result.size).toBe(0)
  })

  test('skips capabilities with empty config', async () => {
    mockPrisma.workspaceCapability.findMany.mockResolvedValue([
      {
        capability: {
          id: 'cap-1',
          slug: 'cap-with-config',
          configSchema: [
            {
              key: 'api_key',
              label: 'API Key',
              type: 'password',
              required: true,
              envVar: 'MY_API_KEY',
            },
          ],
        },
        config: null,
      },
    ])

    const result = await capabilityService.getDecryptedCapabilityConfigsForWorkspace('ws-1')
    expect(result.size).toBe(0)
  })
})

describe('capabilityService.getWorkspaceCapabilitySettings', () => {
  test('returns all capabilities with workspace-specific enabled status', async () => {
    mockPrisma.capability.findMany.mockResolvedValue([
      { id: 'cap-1', slug: 'test-cap', name: 'Test', configSchema: null },
      { id: 'cap-2', slug: 'other-cap', name: 'Other', configSchema: null },
    ])
    mockPrisma.workspaceCapability.findMany.mockResolvedValue([
      { id: 'wc-1', capabilityId: 'cap-1', enabled: true, config: null },
    ])

    const result = await capabilityService.getWorkspaceCapabilitySettings('ws-1')

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      slug: 'test-cap',
      enabled: true,
      alwaysOn: true,
      workspaceCapabilityId: 'wc-1',
    })
    expect(result[1]).toMatchObject({
      slug: 'other-cap',
      enabled: false,
      alwaysOn: false,
      workspaceCapabilityId: null,
    })
  })

  test('filters out hidden capabilities', async () => {
    mockPrisma.capability.findMany.mockResolvedValue([
      { id: 'cap-1', slug: 'sub-agent-delegation', name: 'Hidden', configSchema: null },
      { id: 'cap-2', slug: 'test-cap', name: 'Visible', configSchema: null },
    ])
    mockPrisma.workspaceCapability.findMany.mockResolvedValue([])

    const result = await capabilityService.getWorkspaceCapabilitySettings('ws-1')

    expect(result).toHaveLength(1)
    expect(result[0]!.slug).toBe('test-cap')
  })

  test('masks config fields for capabilities with config schema', async () => {
    const { maskConfigFields } = await import('./config-validation.service.js')
    vi.mocked(maskConfigFields).mockReturnValue({ api_key: '********' })

    mockPrisma.capability.findMany.mockResolvedValue([
      {
        id: 'cap-1',
        slug: 'cap-with-config',
        name: 'Configured',
        configSchema: [{ key: 'api_key', label: 'API Key', type: 'password', required: true }],
      },
    ])
    mockPrisma.workspaceCapability.findMany.mockResolvedValue([
      { id: 'wc-1', capabilityId: 'cap-1', enabled: true, config: { api_key: 'encrypted:secret' } },
    ])

    const result = await capabilityService.getWorkspaceCapabilitySettings('ws-1')

    expect(result[0]!.config).toEqual({ api_key: '********' })
    expect(maskConfigFields).toHaveBeenCalled()
  })
})

describe('capabilityService.enableCapability', () => {
  test('enables a capability by slug', async () => {
    mockPrisma.capability.findUniqueOrThrow.mockResolvedValue({
      id: 'cap-1',
      slug: 'test-cap',
      configSchema: null,
    })
    mockPrisma.workspaceCapability.upsert.mockResolvedValue({
      id: 'wc-1',
      capability: { id: 'cap-1', slug: 'test-cap' },
    })

    const result = await capabilityService.enableCapability('ws-1', 'test-cap')

    expect(mockPrisma.workspaceCapability.upsert).toHaveBeenCalledWith({
      where: { workspaceId_capabilityId: { workspaceId: 'ws-1', capabilityId: 'cap-1' } },
      create: { workspaceId: 'ws-1', capabilityId: 'cap-1', enabled: true, config: undefined },
      update: { enabled: true, config: undefined },
      include: { capability: true },
    })
    expect(result.id).toBe('wc-1')
  })

  test('validates and processes config when provided', async () => {
    const { validateCapabilityConfig, encryptConfigFields } =
      await import('./config-validation.service.js')

    mockPrisma.capability.findUniqueOrThrow.mockResolvedValue({
      id: 'cap-1',
      slug: 'cap-with-config',
      configSchema: [
        {
          key: 'api_key',
          label: 'API Key',
          type: 'password',
          required: true,
          envVar: 'MY_API_KEY',
        },
      ],
    })
    mockPrisma.workspaceCapability.findUnique.mockResolvedValue(null)
    mockPrisma.workspaceCapability.upsert.mockResolvedValue({ id: 'wc-1' })

    await capabilityService.enableCapability('ws-1', 'cap-with-config', { api_key: 'my-key' })

    expect(validateCapabilityConfig).toHaveBeenCalled()
    expect(encryptConfigFields).toHaveBeenCalled()
  })

  test('throws when config validation fails', async () => {
    const { validateCapabilityConfig } = await import('./config-validation.service.js')
    vi.mocked(validateCapabilityConfig).mockReturnValue({
      valid: false,
      errors: ['API Key is required'],
    })

    mockPrisma.capability.findUniqueOrThrow.mockResolvedValue({
      id: 'cap-1',
      slug: 'cap-with-config',
      configSchema: [
        {
          key: 'api_key',
          label: 'API Key',
          type: 'password',
          required: true,
          envVar: 'MY_API_KEY',
        },
      ],
    })

    await expect(
      capabilityService.enableCapability('ws-1', 'cap-with-config', { api_key: '' }),
    ).rejects.toThrow('Config validation failed: API Key is required')
  })

  test('throws when required config is missing', async () => {
    mockPrisma.capability.findUniqueOrThrow.mockResolvedValue({
      id: 'cap-1',
      slug: 'cap-with-config',
      configSchema: [
        {
          key: 'api_key',
          label: 'API Key',
          type: 'password',
          required: true,
          envVar: 'MY_API_KEY',
        },
      ],
    })

    await expect(capabilityService.enableCapability('ws-1', 'cap-with-config')).rejects.toThrow(
      'Configuration is required for this capability',
    )
  })

  test('merges with existing config when re-enabling', async () => {
    const { mergeWithExistingConfig, validateCapabilityConfig } =
      await import('./config-validation.service.js')
    vi.mocked(validateCapabilityConfig).mockReturnValue({ valid: true, errors: [] })

    mockPrisma.capability.findUniqueOrThrow.mockResolvedValue({
      id: 'cap-1',
      slug: 'cap-with-config',
      configSchema: [
        {
          key: 'api_key',
          label: 'API Key',
          type: 'password',
          required: true,
          envVar: 'MY_API_KEY',
        },
      ],
    })
    mockPrisma.workspaceCapability.findUnique.mockResolvedValue({
      id: 'wc-1',
      config: { api_key: 'encrypted:old-key' },
    })
    mockPrisma.workspaceCapability.upsert.mockResolvedValue({ id: 'wc-1' })

    await capabilityService.enableCapability('ws-1', 'cap-with-config', { api_key: '********' })

    expect(mergeWithExistingConfig).toHaveBeenCalled()
  })
})

describe('capabilityService.disableCapability', () => {
  test('disables a capability by workspace and capability ID', async () => {
    mockPrisma.workspaceCapability.update.mockResolvedValue({ id: 'wc-1', enabled: false })

    const result = await capabilityService.disableCapability('ws-1', 'cap-1')

    expect(mockPrisma.workspaceCapability.update).toHaveBeenCalledWith({
      where: { workspaceId_capabilityId: { workspaceId: 'ws-1', capabilityId: 'cap-1' } },
      data: { enabled: false },
    })
    expect(result.enabled).toBe(false)
  })
})

describe('capabilityService.disableCapabilityBySlug', () => {
  test('resolves slug to capability ID and disables', async () => {
    mockPrisma.capability.findUnique.mockResolvedValue({ id: 'cap-1', slug: 'test-cap' })
    mockPrisma.workspaceCapability.update.mockResolvedValue({ id: 'wc-1', enabled: false })

    await capabilityService.disableCapabilityBySlug('ws-1', 'test-cap')

    expect(mockPrisma.workspaceCapability.update).toHaveBeenCalledWith({
      where: { workspaceId_capabilityId: { workspaceId: 'ws-1', capabilityId: 'cap-1' } },
      data: { enabled: false },
    })
  })

  test('does nothing when slug is not found', async () => {
    mockPrisma.capability.findUnique.mockResolvedValue(null)

    await capabilityService.disableCapabilityBySlug('ws-1', 'nonexistent')

    expect(mockPrisma.workspaceCapability.update).not.toHaveBeenCalled()
  })
})

describe('capabilityService.removeCapabilityOverride', () => {
  test('deletes workspace capability record', async () => {
    mockPrisma.workspaceCapability.delete.mockResolvedValue({ id: 'wc-1' })

    await capabilityService.removeCapabilityOverride('ws-1', 'cap-1')

    expect(mockPrisma.workspaceCapability.delete).toHaveBeenCalledWith({
      where: { workspaceId_capabilityId: { workspaceId: 'ws-1', capabilityId: 'cap-1' } },
    })
  })
})

describe('capabilityService.updateCapabilityConfig', () => {
  test('validates, encrypts, and updates config', async () => {
    const { validateCapabilityConfig, encryptConfigFields } =
      await import('./config-validation.service.js')
    vi.mocked(validateCapabilityConfig).mockReturnValue({ valid: true, errors: [] })

    mockPrisma.capability.findUniqueOrThrow.mockResolvedValue({
      id: 'cap-1',
      configSchema: [{ key: 'api_key', label: 'API Key', type: 'password', required: true }],
    })
    mockPrisma.workspaceCapability.findUnique.mockResolvedValue(null)
    mockPrisma.workspaceCapability.update.mockResolvedValue({ id: 'wc-1' })
    mockPrisma.sandboxSession.findMany.mockResolvedValue([])

    await capabilityService.updateCapabilityConfig('ws-1', 'cap-1', { api_key: 'new-key' })

    expect(validateCapabilityConfig).toHaveBeenCalled()
    expect(encryptConfigFields).toHaveBeenCalled()
    expect(mockPrisma.workspaceCapability.update).toHaveBeenCalledWith({
      where: { workspaceId_capabilityId: { workspaceId: 'ws-1', capabilityId: 'cap-1' } },
      data: { config: { api_key: 'new-key' } },
    })
  })

  test('throws when validation fails', async () => {
    const { validateCapabilityConfig } = await import('./config-validation.service.js')
    vi.mocked(validateCapabilityConfig).mockReturnValue({
      valid: false,
      errors: ['API Key is required'],
    })

    mockPrisma.capability.findUniqueOrThrow.mockResolvedValue({
      id: 'cap-1',
      configSchema: [{ key: 'api_key', label: 'API Key', type: 'password', required: true }],
    })

    await expect(
      capabilityService.updateCapabilityConfig('ws-1', 'cap-1', { api_key: '' }),
    ).rejects.toThrow('Config validation failed')
  })

  test('merges with existing config when available', async () => {
    const { validateCapabilityConfig, mergeWithExistingConfig } =
      await import('./config-validation.service.js')
    vi.mocked(validateCapabilityConfig).mockReturnValue({ valid: true, errors: [] })

    mockPrisma.capability.findUniqueOrThrow.mockResolvedValue({
      id: 'cap-1',
      configSchema: [{ key: 'api_key', label: 'API Key', type: 'password', required: true }],
    })
    mockPrisma.workspaceCapability.findUnique.mockResolvedValue({
      id: 'wc-1',
      config: { api_key: 'encrypted:old' },
    })
    mockPrisma.workspaceCapability.update.mockResolvedValue({ id: 'wc-1' })
    mockPrisma.sandboxSession.findMany.mockResolvedValue([])

    await capabilityService.updateCapabilityConfig('ws-1', 'cap-1', { api_key: '********' })

    expect(mergeWithExistingConfig).toHaveBeenCalled()
  })

  test('skips validation when no config schema', async () => {
    const { validateCapabilityConfig } = await import('./config-validation.service.js')

    mockPrisma.capability.findUniqueOrThrow.mockResolvedValue({
      id: 'cap-1',
      configSchema: null,
    })
    mockPrisma.workspaceCapability.update.mockResolvedValue({ id: 'wc-1' })
    mockPrisma.sandboxSession.findMany.mockResolvedValue([])

    await capabilityService.updateCapabilityConfig('ws-1', 'cap-1', { key: 'val' })

    expect(validateCapabilityConfig).not.toHaveBeenCalled()
  })
})

describe('capabilityService.buildToolDefinitions', () => {
  test('builds LLM tool definitions from capabilities', () => {
    const capabilities = [
      {
        slug: 'test-cap',
        toolDefinitions: [
          { name: 'tool_a', description: 'Tool A', parameters: { type: 'object' } },
          { name: 'tool_b', description: 'Tool B', parameters: { type: 'object' } },
        ],
      },
      {
        slug: 'other-cap',
        toolDefinitions: [
          { name: 'tool_c', description: 'Tool C', parameters: { type: 'object' } },
        ],
      },
    ]

    const tools = capabilityService.buildToolDefinitions(capabilities)

    expect(tools).toHaveLength(3)
    expect(tools[0]).toEqual({
      name: 'tool_a',
      description: 'Tool A',
      parameters: { type: 'object' },
    })
    expect(tools[2]).toEqual({
      name: 'tool_c',
      description: 'Tool C',
      parameters: { type: 'object' },
    })
  })

  test('returns empty array for no capabilities', () => {
    expect(capabilityService.buildToolDefinitions([])).toEqual([])
  })
})

describe('capabilityService.buildSystemPrompt', () => {
  test('delegates to buildSystemPromptText', () => {
    const capabilities = [
      { systemPrompt: 'Prompt A', name: 'Cap A' },
      { systemPrompt: 'Prompt B', name: 'Cap B' },
    ]

    const result = capabilityService.buildSystemPrompt(capabilities, 'UTC')

    expect(result).toBe('System prompt text')
  })
})

describe('capabilityService.resolveToolCapability', () => {
  test('returns slug for matching tool', () => {
    const capabilities = [
      {
        slug: 'test-cap',
        toolDefinitions: [{ name: 'test_tool', description: 'Test', parameters: {} }],
      },
      {
        slug: 'other-cap',
        toolDefinitions: [{ name: 'other_tool', description: 'Other', parameters: {} }],
      },
    ]

    expect(capabilityService.resolveToolCapability('test_tool', capabilities)).toBe('test-cap')
    expect(capabilityService.resolveToolCapability('other_tool', capabilities)).toBe('other-cap')
  })

  test('returns null when tool is not found', () => {
    const capabilities = [
      {
        slug: 'test-cap',
        toolDefinitions: [{ name: 'test_tool', description: 'Test', parameters: {} }],
      },
    ]

    expect(capabilityService.resolveToolCapability('nonexistent', capabilities)).toBeNull()
  })

  test('returns null for empty capabilities array', () => {
    expect(capabilityService.resolveToolCapability('any_tool', [])).toBeNull()
  })
})

describe('capabilityService.REQUIRES_API_KEY', () => {
  test('maps web-search to gemini', () => {
    expect(capabilityService.REQUIRES_API_KEY['web-search']).toBe('gemini')
  })
})
