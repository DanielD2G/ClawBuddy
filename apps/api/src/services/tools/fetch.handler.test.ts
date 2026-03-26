import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────────

vi.mock('../settings.service.js', () => ({
  settingsService: {
    getApiKey: vi.fn().mockResolvedValue('test-gemini-key'),
  },
}))

vi.mock('../../lib/html-to-markdown.js', () => ({
  htmlToMarkdown: vi.fn().mockImplementation((html: string) => `MD:${html}`),
  htmlToText: vi.fn().mockImplementation((html: string) => `TEXT:${html}`),
}))

vi.mock('../../lib/url-safety.js', () => ({
  isPrivateHost: vi.fn().mockReturnValue(false),
}))

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn(),
}))

import { executeWebFetch, executeWebSearch } from './fetch.handler.js'
import { isPrivateHost } from '../../lib/url-safety.js'
import { settingsService } from '../settings.service.js'
import { GoogleGenerativeAI } from '@google/generative-ai'

// Helper to create a mock fetch Response
function mockFetchResponse(body: string, contentType: string, status = 200) {
  const mockReader = {
    read: vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(body) })
      .mockResolvedValueOnce({ done: true, value: undefined }),
    cancel: vi.fn(),
  }
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({ 'content-type': contentType }),
    body: { getReader: () => mockReader },
  } as unknown as Response
}

describe('executeWebFetch', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    fetchSpy?.mockRestore()
  })

  test('fetches a URL and returns JSON output', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockFetchResponse('Hello World', 'text/plain'))

    const toolCall = {
      id: 'tc-1',
      name: 'web_fetch',
      arguments: { url: 'https://example.com/data.txt' },
    }
    const result = await executeWebFetch(toolCall)

    expect(result.error).toBeUndefined()
    const parsed = JSON.parse(result.output)
    expect(parsed.status).toBe(200)
    expect(parsed.body).toBe('Hello World')
  })

  test('converts HTML to markdown when format is markdown', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockFetchResponse('<h1>Title</h1>', 'text/html'))

    const toolCall = {
      id: 'tc-1',
      name: 'web_fetch',
      arguments: { url: 'https://example.com', format: 'markdown' },
    }
    const result = await executeWebFetch(toolCall)

    const parsed = JSON.parse(result.output)
    expect(parsed.body).toBe('MD:<h1>Title</h1>')
  })

  test('converts HTML to text when format is text', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockFetchResponse('<p>Hello</p>', 'text/html'))

    const toolCall = {
      id: 'tc-1',
      name: 'web_fetch',
      arguments: { url: 'https://example.com', format: 'text' },
    }
    const result = await executeWebFetch(toolCall)

    const parsed = JSON.parse(result.output)
    expect(parsed.body).toBe('TEXT:<p>Hello</p>')
  })

  test('returns error for invalid URL', async () => {
    const toolCall = {
      id: 'tc-1',
      name: 'web_fetch',
      arguments: { url: 'not-a-url' },
    }
    const result = await executeWebFetch(toolCall)

    expect(result.error).toBe('Invalid URL')
  })

  test('blocks private/internal addresses', async () => {
    vi.mocked(isPrivateHost).mockReturnValueOnce(true)

    const toolCall = {
      id: 'tc-1',
      name: 'web_fetch',
      arguments: { url: 'http://192.168.1.1/admin' },
    }
    const result = await executeWebFetch(toolCall)

    expect(result.error).toBe('Requests to private/internal addresses are blocked')
  })

  test('returns error on fetch failure', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network timeout'))

    const toolCall = {
      id: 'tc-1',
      name: 'web_fetch',
      arguments: { url: 'https://example.com' },
    }
    const result = await executeWebFetch(toolCall)

    expect(result.error).toBe('Fetch failed: Network timeout')
  })

  test('rejects non-http protocols', async () => {
    const toolCall = {
      id: 'tc-1',
      name: 'web_fetch',
      arguments: { url: 'ftp://example.com/file' },
    }
    const result = await executeWebFetch(toolCall)

    expect(result.error).toBe('Only http/https URLs are supported')
  })

  test('rejects invalid format parameter', async () => {
    const toolCall = {
      id: 'tc-1',
      name: 'web_fetch',
      arguments: { url: 'https://example.com', format: 'xml' },
    }
    const result = await executeWebFetch(toolCall)

    expect(result.error).toContain('Invalid format')
  })
})

describe('executeWebSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('returns error when query is empty', async () => {
    const toolCall = { id: 'tc-1', name: 'web_search', arguments: { query: '' } }
    const result = await executeWebSearch(toolCall)

    expect(result.error).toBe('Search query is required')
  })

  test('returns error when Gemini API key is missing', async () => {
    vi.mocked(settingsService.getApiKey).mockResolvedValueOnce(null)

    const toolCall = { id: 'tc-1', name: 'web_search', arguments: { query: 'test' } }
    const result = await executeWebSearch(toolCall)

    expect(result.error).toContain('Gemini API key')
  })

  test('performs search and returns text with sources', async () => {
    vi.mocked(GoogleGenerativeAI).mockImplementation(
      () =>
        ({
          getGenerativeModel: vi.fn().mockReturnValue({
            generateContent: vi.fn().mockResolvedValue({
              response: {
                text: () => 'Search result text',
                candidates: [
                  {
                    groundingMetadata: {
                      groundingChunks: [{ web: { uri: 'https://example.com', title: 'Example' } }],
                    },
                  },
                ],
              },
            }),
          }),
        }) as never,
    )

    const toolCall = { id: 'tc-1', name: 'web_search', arguments: { query: 'test query' } }
    const result = await executeWebSearch(toolCall)

    expect(result.output).toContain('Search result text')
    expect(result.output).toContain('**Sources:**')
    expect(result.output).toContain('Example')
  })

  test('handles search API error', async () => {
    vi.mocked(GoogleGenerativeAI).mockImplementation(
      () =>
        ({
          getGenerativeModel: vi.fn().mockReturnValue({
            generateContent: vi.fn().mockRejectedValue(new Error('API rate limit')),
          }),
        }) as never,
    )

    const toolCall = { id: 'tc-1', name: 'web_search', arguments: { query: 'test' } }
    const result = await executeWebSearch(toolCall)

    expect(result.error).toContain('Web search failed')
    expect(result.error).toContain('API rate limit')
  })
})
