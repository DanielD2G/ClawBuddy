import { describe, expect, test, vi, beforeEach } from 'vitest'
import { createMockPrisma, type MockPrisma } from '@test/factories/prisma'

// ── Mocks ───────────────────────────────────────────────────────────────

let mockPrisma: MockPrisma

vi.mock('../lib/prisma.js', () => ({
  get prisma() {
    return mockPrisma
  },
}))

vi.mock('./crypto.service.js', () => ({
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  decrypt: vi.fn((v: string) => {
    if (v.startsWith('encrypted:')) return v.slice('encrypted:'.length)
    throw new Error('decrypt failed')
  }),
}))

vi.mock('../env.js', () => ({
  env: {
    AI_PROVIDER: 'openai',
    EMBEDDING_PROVIDER: 'openai',
    OPENAI_API_KEY: '',
    GEMINI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    LOCAL_PROVIDER_BASE_URL: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    ENCRYPTION_SECRET: 'vitest-encryption-secret',
  },
}))

vi.mock('../config.js', () => ({
  LLM_PROVIDERS: ['openai', 'gemini', 'claude', 'local'],
  EMBEDDING_PROVIDERS: ['openai', 'gemini', 'local'],
  ENV_KEYS: {} as Record<string, string>,
  ENV_BASE_URLS: {} as Record<string, string>,
  DB_KEY_FIELDS: {
    openai: 'openaiApiKey',
    gemini: 'geminiApiKey',
    claude: 'anthropicApiKey',
  } as Record<string, string>,
  PROVIDER_METADATA: {
    openai: { label: 'OpenAI', connectionType: 'apiKey', supports: { llm: true, embedding: true } },
    gemini: {
      label: 'Google Gemini',
      connectionType: 'apiKey',
      supports: { llm: true, embedding: true },
    },
    claude: {
      label: 'Anthropic Claude',
      connectionType: 'apiKey',
      supports: { llm: true, embedding: false },
    },
    local: {
      label: 'Local Provider',
      connectionType: 'baseUrl',
      supports: { llm: true, embedding: true },
    },
  },
}))

vi.mock('./model-discovery.service.js', () => ({
  discoverLLMModels: vi.fn().mockResolvedValue(['gpt-4o', 'gpt-4o-mini']),
  discoverEmbeddingModels: vi.fn().mockResolvedValue(['text-embedding-3-small']),
}))

// ── Import under test (after mocks) ────────────────────────────────────

const { settingsService } = await import('./settings.service.js')

// ── Helpers ─────────────────────────────────────────────────────────────

function makeSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'singleton',
    aiProvider: 'openai',
    aiModel: 'gpt-4o',
    embeddingProvider: 'openai',
    embeddingModel: 'text-embedding-3-small',
    advancedModelConfig: false,
    onboardingComplete: false,
    llmProviderOverrides: {},
    openaiApiKey: null,
    geminiApiKey: null,
    anthropicApiKey: null,
    localBaseUrl: null,
    contextLimitTokens: null,
    maxAgentIterations: null,
    subAgentExploreMaxIterations: null,
    subAgentAnalyzeMaxIterations: null,
    subAgentExecuteMaxIterations: null,
    timezone: null,
    dismissedUpdateVersion: null,
    browserGridUrl: null,
    browserGridApiKey: null,
    browserGridBrowser: null,
    browserModel: null,
    mediumModel: null,
    lightModel: null,
    exploreModel: null,
    executeModel: null,
    titleModel: null,
    compactModel: null,
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  mockPrisma = createMockPrisma()
  settingsService._invalidateCache()
  vi.clearAllMocks()
})

describe('settingsService.get', () => {
  test('returns existing settings from DB', async () => {
    const settings = makeSettings()
    mockPrisma.appSettings.findUnique.mockResolvedValue(settings)

    const result = await settingsService.get()
    expect(result).toEqual(settings)
    expect(mockPrisma.appSettings.findUnique).toHaveBeenCalledWith({ where: { id: 'singleton' } })
  })

  test('creates default settings when none exist', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(null)
    const created = makeSettings()
    mockPrisma.appSettings.create.mockResolvedValue(created)

    const result = await settingsService.get()
    expect(result).toEqual(created)
    expect(mockPrisma.appSettings.create).toHaveBeenCalled()
  })

  test('uses cache on second call within TTL', async () => {
    const settings = makeSettings()
    mockPrisma.appSettings.findUnique.mockResolvedValue(settings)

    await settingsService.get()
    await settingsService.get()

    expect(mockPrisma.appSettings.findUnique).toHaveBeenCalledTimes(1)
  })

  test('invalidateCache forces a fresh DB read', async () => {
    const settings = makeSettings()
    mockPrisma.appSettings.findUnique.mockResolvedValue(settings)

    await settingsService.get()
    settingsService._invalidateCache()
    await settingsService.get()

    expect(mockPrisma.appSettings.findUnique).toHaveBeenCalledTimes(2)
  })
})

describe('settingsService.getAIProvider', () => {
  test('returns aiProvider from settings', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings({ aiProvider: 'gemini' }))
    expect(await settingsService.getAIProvider()).toBe('gemini')
  })
})

describe('settingsService.getEmbeddingProvider', () => {
  test('returns embeddingProvider from settings', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ embeddingProvider: 'gemini' }),
    )
    expect(await settingsService.getEmbeddingProvider()).toBe('gemini')
  })
})

describe('settingsService.getAIModel', () => {
  test('returns aiModel from settings', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings({ aiModel: 'gpt-4o' }))
    expect(await settingsService.getAIModel()).toBe('gpt-4o')
  })
})

describe('settingsService._resolveModel', () => {
  test('uses tier value when advancedModelConfig is false', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ lightModel: 'gpt-4o-mini', advancedModelConfig: false }),
    )
    // titleModel has fallbackTierKey = 'lightModel'
    const result = await settingsService.getTitleModel()
    expect(result).toBe('gpt-4o-mini')
  })

  test('falls back to aiModel when tier value is null', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ lightModel: null, aiModel: 'gpt-4o' }),
    )
    const result = await settingsService.getTitleModel()
    expect(result).toBe('gpt-4o')
  })

  test('uses specific model key when advancedModelConfig is true and model is set', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({
        advancedModelConfig: true,
        titleModel: 'my-title-model',
        lightModel: 'gpt-4o-mini',
      }),
    )
    const result = await settingsService.getTitleModel()
    expect(result).toBe('my-title-model')
  })

  test('uses tier fallback when advancedModelConfig is true but specific model is not set', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({
        advancedModelConfig: true,
        titleModel: null,
        lightModel: 'gpt-4o-mini',
      }),
    )
    const result = await settingsService.getTitleModel()
    expect(result).toBe('gpt-4o-mini')
  })

  test('getLightModel falls back to aiModel when lightModel is null', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ lightModel: null, aiModel: 'gpt-4o' }),
    )
    expect(await settingsService.getLightModel()).toBe('gpt-4o')
  })

  test('getMediumModel returns mediumModel when set', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings({ mediumModel: 'gpt-4o' }))
    expect(await settingsService.getMediumModel()).toBe('gpt-4o')
  })

  test('getCompactModel uses mediumModel as tier fallback', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ mediumModel: 'gpt-4o', compactModel: null }),
    )
    expect(await settingsService.getCompactModel()).toBe('gpt-4o')
  })

  test('getExploreModel uses lightModel as tier fallback', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ lightModel: 'gpt-4o-mini', exploreModel: null }),
    )
    expect(await settingsService.getExploreModel()).toBe('gpt-4o-mini')
  })

  test('getExecuteModel uses mediumModel as tier fallback', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ mediumModel: 'gpt-4o', executeModel: null }),
    )
    expect(await settingsService.getExecuteModel()).toBe('gpt-4o')
  })
})

describe('settingsService.getEmbeddingModel', () => {
  test('returns embeddingModel from settings', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ embeddingModel: 'text-embedding-3-small' }),
    )
    expect(await settingsService.getEmbeddingModel()).toBe('text-embedding-3-small')
  })
})

describe('settingsService.getContextLimitTokens', () => {
  test('returns stored value when set', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings({ contextLimitTokens: 50000 }))
    expect(await settingsService.getContextLimitTokens()).toBe(50000)
  })

  test('returns default when not set', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings({ contextLimitTokens: null }))
    expect(await settingsService.getContextLimitTokens()).toBe(80000)
  })
})

describe('settingsService.getTimezone', () => {
  test('returns stored timezone', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ timezone: 'America/New_York' }),
    )
    expect(await settingsService.getTimezone()).toBe('America/New_York')
  })

  test('falls back to system timezone when null', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings({ timezone: null }))
    const result = await settingsService.getTimezone()
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('settingsService.getDismissedUpdateVersion', () => {
  test('returns stored version', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ dismissedUpdateVersion: 'v1.2.3' }),
    )
    expect(await settingsService.getDismissedUpdateVersion()).toBe('v1.2.3')
  })

  test('returns null when not set', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ dismissedUpdateVersion: null }),
    )
    expect(await settingsService.getDismissedUpdateVersion()).toBeNull()
  })
})

describe('settingsService.getMaxAgentIterations', () => {
  test('returns stored value', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings({ maxAgentIterations: 30 }))
    expect(await settingsService.getMaxAgentIterations()).toBe(30)
  })

  test('returns default when not set', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings({ maxAgentIterations: null }))
    expect(await settingsService.getMaxAgentIterations()).toBe(50)
  })
})

describe('settingsService.getSubAgent iteration limits', () => {
  test('getSubAgentExploreMaxIterations returns default', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    expect(await settingsService.getSubAgentExploreMaxIterations()).toBe(50)
  })

  test('getSubAgentAnalyzeMaxIterations returns default', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    expect(await settingsService.getSubAgentAnalyzeMaxIterations()).toBe(25)
  })

  test('getSubAgentExecuteMaxIterations returns default', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    expect(await settingsService.getSubAgentExecuteMaxIterations()).toBe(50)
  })
})

describe('settingsService.getBrowserGridUrl', () => {
  test('returns env var when set', async () => {
    const origEnv = process.env.BROWSER_GRID_URL
    process.env.BROWSER_GRID_URL = 'http://grid.example.com'
    try {
      expect(await settingsService.getBrowserGridUrl()).toBe('http://grid.example.com')
    } finally {
      process.env.BROWSER_GRID_URL = origEnv
    }
  })

  test('returns stored value when env is not set', async () => {
    const origEnv = process.env.BROWSER_GRID_URL
    delete process.env.BROWSER_GRID_URL
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ browserGridUrl: 'http://custom:9090' }),
    )
    try {
      expect(await settingsService.getBrowserGridUrl()).toBe('http://custom:9090')
    } finally {
      process.env.BROWSER_GRID_URL = origEnv
    }
  })

  test('returns default when nothing is set', async () => {
    const origEnv = process.env.BROWSER_GRID_URL
    delete process.env.BROWSER_GRID_URL
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    try {
      expect(await settingsService.getBrowserGridUrl()).toBe('http://localhost:9090')
    } finally {
      process.env.BROWSER_GRID_URL = origEnv
    }
  })
})

describe('settingsService.getBrowserGridApiKey', () => {
  test('returns env var when set', async () => {
    const origEnv = process.env.BROWSER_GRID_API_KEY
    process.env.BROWSER_GRID_API_KEY = 'env-key'
    try {
      expect(await settingsService.getBrowserGridApiKey()).toBe('env-key')
    } finally {
      process.env.BROWSER_GRID_API_KEY = origEnv
    }
  })

  test('decrypts stored key', async () => {
    const origEnv = process.env.BROWSER_GRID_API_KEY
    delete process.env.BROWSER_GRID_API_KEY
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ browserGridApiKey: 'encrypted:my-key' }),
    )
    try {
      expect(await settingsService.getBrowserGridApiKey()).toBe('my-key')
    } finally {
      process.env.BROWSER_GRID_API_KEY = origEnv
    }
  })

  test('returns null when decryption fails', async () => {
    const origEnv = process.env.BROWSER_GRID_API_KEY
    delete process.env.BROWSER_GRID_API_KEY
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ browserGridApiKey: 'bad-data' }),
    )
    try {
      expect(await settingsService.getBrowserGridApiKey()).toBeNull()
    } finally {
      process.env.BROWSER_GRID_API_KEY = origEnv
    }
  })

  test('returns null when no key stored', async () => {
    const origEnv = process.env.BROWSER_GRID_API_KEY
    delete process.env.BROWSER_GRID_API_KEY
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    try {
      expect(await settingsService.getBrowserGridApiKey()).toBeNull()
    } finally {
      process.env.BROWSER_GRID_API_KEY = origEnv
    }
  })
})

describe('settingsService.getBrowserGridBrowser', () => {
  test('returns stored value', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ browserGridBrowser: 'firefox' }),
    )
    expect(await settingsService.getBrowserGridBrowser()).toBe('firefox')
  })

  test('returns default when not set', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    expect(await settingsService.getBrowserGridBrowser()).toBe('camoufox')
  })
})

describe('settingsService.getApiKey', () => {
  test('returns env key when available', async () => {
    const { ENV_KEYS } = await import('../config.js')
    const original = ENV_KEYS.openai
    ENV_KEYS.openai = 'env-openai-key'
    try {
      expect(await settingsService.getApiKey('openai')).toBe('env-openai-key')
    } finally {
      ENV_KEYS.openai = original
    }
  })

  test('decrypts DB key when env is empty', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ openaiApiKey: 'encrypted:sk-1234' }),
    )
    expect(await settingsService.getApiKey('openai')).toBe('sk-1234')
  })

  test('returns null for unknown provider', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    expect(await settingsService.getApiKey('unknown')).toBeNull()
  })

  test('returns null when DB key is not set', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings({ openaiApiKey: null }))
    expect(await settingsService.getApiKey('openai')).toBeNull()
  })

  test('returns null when decryption fails', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ openaiApiKey: 'corrupt-data' }),
    )
    expect(await settingsService.getApiKey('openai')).toBeNull()
  })
})

describe('settingsService.setApiKey', () => {
  test('encrypts and stores API key', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())

    await settingsService.setApiKey('openai', 'sk-my-key')

    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { openaiApiKey: 'encrypted:sk-my-key' },
    })
  })

  test('stores null for empty key', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())

    await settingsService.setApiKey('openai', '   ')

    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { openaiApiKey: null },
    })
  })

  test('throws for unknown provider', async () => {
    await expect(settingsService.setApiKey('unknown', 'key')).rejects.toThrow('Unknown provider')
  })

  test('invalidates cache after setting', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())

    await settingsService.setApiKey('openai', 'sk-key')

    // Second call should hit DB again (cache was invalidated)
    await settingsService.get()
    expect(mockPrisma.appSettings.findUnique).toHaveBeenCalledTimes(2)
  })
})

describe('settingsService.setProviderConnection', () => {
  test('throws on empty value', async () => {
    await expect(settingsService.setProviderConnection('openai', '  ')).rejects.toThrow(
      'Connection value cannot be empty',
    )
  })

  test('sets localBaseUrl for local provider', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())

    await settingsService.setProviderConnection('local', 'http://localhost:8080')

    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { localBaseUrl: 'http://localhost:8080' },
    })
  })

  test('delegates to setApiKey for non-local providers', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())

    await settingsService.setProviderConnection('openai', 'sk-key')

    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { openaiApiKey: 'encrypted:sk-key' },
    })
  })
})

describe('settingsService.removeApiKey', () => {
  test('sets field to null', async () => {
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())
    await settingsService.removeApiKey('openai')
    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { openaiApiKey: null },
    })
  })

  test('throws for unknown provider', async () => {
    await expect(settingsService.removeApiKey('unknown')).rejects.toThrow('Unknown provider')
  })
})

describe('settingsService.removeProviderConnection', () => {
  test('removes localBaseUrl for local provider', async () => {
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())
    await settingsService.removeProviderConnection('local')
    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { localBaseUrl: null },
    })
  })

  test('delegates to removeApiKey for non-local', async () => {
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())
    await settingsService.removeProviderConnection('gemini')
    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { geminiApiKey: null },
    })
  })
})

describe('settingsService.getLocalBaseUrl', () => {
  test('returns env base URL when set', async () => {
    const { ENV_BASE_URLS } = await import('../config.js')
    const original = ENV_BASE_URLS.local
    ENV_BASE_URLS.local = 'http://env-local:1234'
    try {
      expect(await settingsService.getLocalBaseUrl()).toBe('http://env-local:1234')
    } finally {
      ENV_BASE_URLS.local = original
    }
  })

  test('returns DB value when env is empty', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ localBaseUrl: 'http://db-local:5678' }),
    )
    expect(await settingsService.getLocalBaseUrl()).toBe('http://db-local:5678')
  })

  test('returns null when neither is set', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    expect(await settingsService.getLocalBaseUrl()).toBeNull()
  })
})

describe('settingsService.isProviderConfigured', () => {
  test('returns true when provider has a connection value', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ openaiApiKey: 'encrypted:sk-test' }),
    )
    expect(await settingsService.isProviderConfigured('openai')).toBe(true)
  })

  test('returns false when provider has no connection', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    expect(await settingsService.isProviderConfigured('openai')).toBe(false)
  })
})

describe('settingsService.completeOnboarding', () => {
  test('updates onboardingComplete to true', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings({ onboardingComplete: true }))

    const result = await settingsService.completeOnboarding()
    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { onboardingComplete: true },
    })
    expect(result.onboardingComplete).toBe(true)
  })
})

describe('settingsService.setBrowserGridApiKey', () => {
  test('encrypts and stores browser grid API key', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())

    await settingsService.setBrowserGridApiKey('grid-key')

    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { browserGridApiKey: 'encrypted:grid-key' },
    })
  })

  test('stores null for empty key', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())

    await settingsService.setBrowserGridApiKey('  ')

    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { browserGridApiKey: null },
    })
  })
})

describe('settingsService.setDismissedUpdateVersion', () => {
  test('stores version string', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())

    await settingsService.setDismissedUpdateVersion('v1.2.3')

    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { dismissedUpdateVersion: 'v1.2.3' },
    })
  })

  test('stores null when null is passed', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    mockPrisma.appSettings.update.mockResolvedValue(makeSettings())

    await settingsService.setDismissedUpdateVersion(null)

    expect(mockPrisma.appSettings.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { dismissedUpdateVersion: null },
    })
  })
})

describe('settingsService.getAdvancedModelConfig', () => {
  test('returns advancedModelConfig boolean', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings({ advancedModelConfig: true }))
    expect(await settingsService.getAdvancedModelConfig()).toBe(true)
  })
})

describe('settingsService.getBrowserModel', () => {
  test('returns stored browser model', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings({ browserModel: 'gpt-4o' }))
    expect(await settingsService.getBrowserModel()).toBe('gpt-4o')
  })

  test('returns null when not set', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(makeSettings())
    expect(await settingsService.getBrowserModel()).toBeNull()
  })
})

describe('settingsService.getProviderMetadata', () => {
  test('returns PROVIDER_METADATA', () => {
    const metadata = settingsService.getProviderMetadata()
    expect(metadata).toHaveProperty('openai')
    expect(metadata).toHaveProperty('claude')
  })
})

describe('settingsService.getProviderConnectionValue', () => {
  test('delegates to getLocalBaseUrl for local', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ localBaseUrl: 'http://local:1234' }),
    )
    expect(await settingsService.getProviderConnectionValue('local')).toBe('http://local:1234')
  })

  test('delegates to getApiKey for non-local', async () => {
    mockPrisma.appSettings.findUnique.mockResolvedValue(
      makeSettings({ openaiApiKey: 'encrypted:sk-test' }),
    )
    expect(await settingsService.getProviderConnectionValue('openai')).toBe('sk-test')
  })
})

describe('settingsService.isGoogleOAuthConfigured', () => {
  test('returns false when credentials are empty', () => {
    expect(settingsService.isGoogleOAuthConfigured()).toBe(false)
  })
})

describe('settingsService.getGoogleCredentials', () => {
  test('returns null when credentials are empty', async () => {
    expect(await settingsService.getGoogleCredentials()).toBeNull()
  })
})
