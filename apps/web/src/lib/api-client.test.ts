import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiClient } from './api-client'

describe('apiClient', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(response: {
    ok?: boolean
    status?: number
    json?: () => Promise<unknown>
    text?: () => Promise<string>
  }) {
    const res = {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: 'OK',
      json: response.json ?? (() => Promise.resolve({})),
      ...response,
    }
    vi.mocked(globalThis.fetch).mockResolvedValue(res as Response)
    return res
  }

  describe('GET requests', () => {
    it('sends GET request to correct URL', async () => {
      mockFetch({ json: () => Promise.resolve({ data: [1, 2, 3] }) })
      const result = await apiClient.get('/sessions')
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: undefined,
      })
      expect(result).toEqual([1, 2, 3])
    })

    it('unwraps data field from response', async () => {
      mockFetch({ json: () => Promise.resolve({ data: { id: '1', name: 'test' } }) })
      const result = await apiClient.get('/sessions/1')
      expect(result).toEqual({ id: '1', name: 'test' })
    })

    it('returns full json when no data field', async () => {
      mockFetch({ json: () => Promise.resolve({ id: '1', name: 'test' }) })
      const result = await apiClient.get('/sessions/1')
      expect(result).toEqual({ id: '1', name: 'test' })
    })
  })

  describe('POST requests', () => {
    it('sends POST request with JSON body', async () => {
      mockFetch({ json: () => Promise.resolve({ data: { id: 'new' } }) })
      const body = { name: 'New Session' }
      await apiClient.post('/sessions', body)
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
    })

    it('sends POST request without body', async () => {
      mockFetch({ json: () => Promise.resolve({ data: null }) })
      await apiClient.post('/sessions/1/start')
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/1/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: undefined,
      })
    })
  })

  describe('error handling', () => {
    it('throws error with message from response body', async () => {
      mockFetch({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: 'Invalid input' }),
      })
      await expect(apiClient.get('/bad')).rejects.toThrow('Invalid input')
    })

    it('falls back to statusText when response has no message', async () => {
      const res = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('not json')),
      }
      vi.mocked(globalThis.fetch).mockResolvedValue(res as unknown as Response)
      await expect(apiClient.get('/fail')).rejects.toThrow('Internal Server Error')
    })

    it('throws generic message when no message and empty error body', async () => {
      mockFetch({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      })
      await expect(apiClient.get('/notfound')).rejects.toThrow('Request failed: 404')
    })
  })

  describe('204 No Content', () => {
    it('returns undefined for 204 responses', async () => {
      mockFetch({ status: 204, json: () => Promise.resolve(undefined) })
      const result = await apiClient.delete('/sessions/1')
      expect(result).toBeUndefined()
    })
  })

  describe('fireAndForget', () => {
    it('does not throw on success', () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response())
      expect(() => apiClient.fireAndForget('POST', '/ping')).not.toThrow()
    })

    it('does not throw on fetch failure', () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(new Error('network error'))
      expect(() => apiClient.fireAndForget('POST', '/ping')).not.toThrow()
    })

    it('sends request with correct method and url', () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response())
      apiClient.fireAndForget('DELETE', '/sessions/1')
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/sessions/1', {
        method: 'DELETE',
        credentials: 'include',
      })
    })
  })
})
