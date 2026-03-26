import { vi } from 'vitest'

/**
 * Mock factory for agentService.
 * Mirrors: apps/api/src/services/agent.service.ts → agentService
 */
export function createMockAgentService() {
  return {
    runAgentLoop: vi.fn().mockResolvedValue({
      lastMessageId: 'mock-msg-id',
      paused: false,
    }),
  }
}

/**
 * Mock factory for toolExecutorService.
 * Mirrors: apps/api/src/services/tool-executor.service.ts → toolExecutorService
 */
export function createMockToolExecutorService() {
  return {
    execute: vi.fn().mockResolvedValue({
      output: '',
      durationMs: 0,
    }),
  }
}

/**
 * Mock factory for chatService.
 * Mirrors: apps/api/src/services/chat.service.ts → chatService
 */
export function createMockChatService() {
  return {
    createSession: vi.fn().mockResolvedValue({ id: 'mock-session-id' }),
    listSessions: vi.fn().mockResolvedValue([]),
    markAsRead: vi.fn().mockResolvedValue(0),
    getSession: vi.fn().mockResolvedValue(null),
    formatAssistantErrorMessage: vi.fn().mockReturnValue('Error: something went wrong'),
    persistAssistantErrorMessage: vi.fn().mockResolvedValue(null),
    deleteSession: vi.fn().mockResolvedValue({ id: 'mock-session-id' }),
    getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    _sendWithAgentLoop: vi.fn().mockResolvedValue(undefined),
    _sendWithRAG: vi.fn().mockResolvedValue(undefined),
    _autoTitle: vi.fn(),
  }
}

/**
 * Mock factory for sandboxService.
 * Mirrors: apps/api/src/services/sandbox.service.ts → sandboxService
 */
export function createMockSandboxService() {
  return {
    getOrCreateWorkspaceContainer: vi.fn().mockResolvedValue('mock-container-id'),
    execInWorkspace: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    _execInContainerDirect: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    writeFileToContainer: vi.fn().mockResolvedValue(undefined),
    readFileFromContainer: vi.fn().mockResolvedValue(Buffer.from('')),
    stopWorkspaceContainer: vi.fn().mockResolvedValue(undefined),
    getWorkspaceContainerStatus: vi
      .fn()
      .mockResolvedValue({ status: 'stopped', containerId: null }),
    destroySandbox: vi.fn().mockResolvedValue(undefined),
    startWorkspaceContainerWithCapabilities: vi.fn().mockResolvedValue('mock-container-id'),
    cleanupIdleContainers: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Mock factory for browserService.
 * Mirrors: apps/api/src/services/browser.service.ts → browserService
 */
export function createMockBrowserService() {
  return {
    healthCheck: vi.fn().mockResolvedValue(true),
    getOrCreateSession: vi.fn().mockResolvedValue({
      grid: {},
      context: {},
      page: {},
      chatSessionId: 'mock-session-id',
      lastActivityAt: new Date(),
      closeFn: vi.fn().mockResolvedValue(undefined),
    }),
    executeScript: vi.fn().mockResolvedValue({ success: true, result: 'Script completed' }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    cleanupIdleSessions: vi.fn().mockResolvedValue(undefined),
    getActiveSessions: vi.fn().mockReturnValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Mock factory for settingsService.
 * Mirrors: apps/api/src/services/settings.service.ts → settingsService
 */
export function createMockSettingsService() {
  return {
    _invalidateCache: vi.fn(),
    get: vi.fn().mockResolvedValue({
      id: 'singleton',
      aiProvider: 'openai',
      aiModel: 'gpt-4o',
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      advancedModelConfig: false,
      onboardingComplete: true,
      llmProviderOverrides: {},
    }),
    getAIProvider: vi.fn().mockResolvedValue('openai'),
    getEmbeddingProvider: vi.fn().mockResolvedValue('openai'),
    getAIModel: vi.fn().mockResolvedValue('gpt-4o'),
    getResolvedLLMRole: vi.fn().mockResolvedValue({ provider: 'openai', model: 'gpt-4o' }),
    getResolvedRoleProviders: vi.fn().mockResolvedValue({
      primary: 'openai',
      light: 'openai',
      medium: 'openai',
      title: 'openai',
      compact: 'openai',
      explore: 'openai',
      execute: 'openai',
    }),
    getLightModel: vi.fn().mockResolvedValue('gpt-4o-mini'),
    getTitleModel: vi.fn().mockResolvedValue('gpt-4o-mini'),
    getCompactModel: vi.fn().mockResolvedValue('gpt-4o'),
    getMediumModel: vi.fn().mockResolvedValue('gpt-4o'),
    getAdvancedModelConfig: vi.fn().mockResolvedValue(false),
    getExploreModel: vi.fn().mockResolvedValue('gpt-4o-mini'),
    getExecuteModel: vi.fn().mockResolvedValue('gpt-4o'),
    _resolveModel: vi.fn().mockResolvedValue('gpt-4o'),
    getEmbeddingModel: vi.fn().mockResolvedValue('text-embedding-3-small'),
    getContextLimitTokens: vi.fn().mockResolvedValue(128000),
    getTimezone: vi.fn().mockResolvedValue('UTC'),
    getDismissedUpdateVersion: vi.fn().mockResolvedValue(null),
    getMaxAgentIterations: vi.fn().mockResolvedValue(25),
    _getNumericSetting: vi.fn().mockResolvedValue(25),
    getSubAgentExploreMaxIterations: vi.fn().mockResolvedValue(10),
    getSubAgentAnalyzeMaxIterations: vi.fn().mockResolvedValue(10),
    getSubAgentExecuteMaxIterations: vi.fn().mockResolvedValue(15),
    getBrowserGridUrl: vi.fn().mockResolvedValue('http://localhost:3100'),
    getBrowserGridApiKey: vi.fn().mockResolvedValue(null),
    getBrowserGridBrowser: vi.fn().mockResolvedValue('chromium'),
    getBrowserModel: vi.fn().mockResolvedValue(null),
    getApiKey: vi.fn().mockResolvedValue(null),
    getLocalBaseUrl: vi.fn().mockResolvedValue(null),
    getProviderConnectionValue: vi.fn().mockResolvedValue(null),
    isProviderConfigured: vi.fn().mockResolvedValue(false),
    getConfiguredProviders: vi.fn().mockResolvedValue({ llm: [], embedding: [] }),
    setApiKey: vi.fn().mockResolvedValue({ id: 'singleton' }),
    setProviderConnection: vi.fn().mockResolvedValue({ id: 'singleton' }),
    removeApiKey: vi.fn().mockResolvedValue({ id: 'singleton' }),
    removeProviderConnection: vi.fn().mockResolvedValue({ id: 'singleton' }),
    getAvailableProviders: vi.fn().mockResolvedValue({ llm: ['openai'], embedding: ['openai'] }),
    getProviderMetadata: vi.fn().mockReturnValue({}),
    getProviderConnections: vi.fn().mockResolvedValue({}),
    getGoogleCredentials: vi.fn().mockResolvedValue(null),
    isGoogleOAuthConfigured: vi.fn().mockReturnValue(false),
    completeOnboarding: vi.fn().mockResolvedValue({ id: 'singleton' }),
    setBrowserGridApiKey: vi.fn().mockResolvedValue({ id: 'singleton' }),
    setDismissedUpdateVersion: vi.fn().mockResolvedValue({ id: 'singleton' }),
    update: vi.fn().mockResolvedValue({ id: 'singleton' }),
  }
}

/**
 * Mock factory for capabilityService.
 * Mirrors: apps/api/src/services/capability.service.ts → capabilityService
 */
export function createMockCapabilityService() {
  return {
    REQUIRES_API_KEY: { 'web-search': 'gemini' } as Record<string, string>,
    syncBuiltinCapabilities: vi.fn().mockResolvedValue(undefined),
    ensureAlwaysOnCapabilities: vi.fn().mockResolvedValue(undefined),
    listAll: vi.fn().mockResolvedValue([]),
    getEnabledCapabilitiesForWorkspace: vi.fn().mockResolvedValue([]),
    getDecryptedCapabilityConfigsForWorkspace: vi.fn().mockResolvedValue(new Map()),
    getWorkspaceCapabilitySettings: vi.fn().mockResolvedValue([]),
    enableCapability: vi.fn().mockResolvedValue({ id: 'mock-wc-id' }),
    disableCapability: vi.fn().mockResolvedValue({ id: 'mock-wc-id' }),
    disableCapabilityBySlug: vi.fn().mockResolvedValue(undefined),
    removeCapabilityOverride: vi.fn().mockResolvedValue({ id: 'mock-wc-id' }),
    updateCapabilityConfig: vi.fn().mockResolvedValue({ id: 'mock-wc-id' }),
    buildToolDefinitions: vi.fn().mockReturnValue([]),
    buildSystemPrompt: vi.fn().mockReturnValue('You are a helpful assistant.'),
    resolveToolCapability: vi.fn().mockReturnValue(null),
  }
}

/**
 * Mock factory for permissionService.
 * Mirrors: apps/api/src/services/permission.service.ts → permissionService
 */
export function createMockPermissionService() {
  return {
    isToolAllowed: vi.fn().mockReturnValue(true),
  }
}
