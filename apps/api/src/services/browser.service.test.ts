import { describe, expect, test } from 'bun:test'
import { captureOptimizedScreenshot } from './browser.service.js'

describe('captureOptimizedScreenshot', () => {
  test('preserves fullPage when requested', async () => {
    const calls: Array<Record<string, unknown>> = []
    const page = {
      screenshot: async (options: Record<string, unknown>) => {
        calls.push(options)
        return Buffer.from('image-bytes')
      },
    }

    const result = await captureOptimizedScreenshot(page, { fullPage: true })

    expect(result).toBe(Buffer.from('image-bytes').toString('base64'))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.fullPage).toBe(true)
  })

  test('defaults to viewport screenshot when fullPage is not requested', async () => {
    const calls: Array<Record<string, unknown>> = []
    const page = {
      screenshot: async (options: Record<string, unknown>) => {
        calls.push(options)
        return Buffer.from('image-bytes')
      },
    }

    await captureOptimizedScreenshot(page)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.fullPage).toBe(false)
  })
})
