import { describe, it, expect } from 'vitest'
import { parseRichBlocks } from './rich-block-parser'

describe('parseRichBlocks', () => {
  it('returns text segment for plain text', () => {
    const result = parseRichBlocks('Hello world')
    expect(result).toEqual([{ type: 'text', text: 'Hello world' }])
  })

  it('parses a rich-map block', () => {
    const input = '```rich-map\n{"address":"123 Main St","label":"Home"}\n```'
    const result = parseRichBlocks(input)
    expect(result).toEqual([{ type: 'rich-map', address: '123 Main St', label: 'Home' }])
  })

  it('parses a rich-product block', () => {
    const input = '```rich-product\n{"name":"Widget","price":9.99,"currency":"USD"}\n```'
    const result = parseRichBlocks(input)
    expect(result).toEqual([
      {
        type: 'rich-product',
        name: 'Widget',
        price: 9.99,
        image: undefined,
        currency: 'USD',
        url: undefined,
      },
    ])
  })

  it('parses a rich-image block', () => {
    const input = '```rich-image\n{"src":"https://example.com/img.png","alt":"photo"}\n```'
    const result = parseRichBlocks(input)
    expect(result).toEqual([
      { type: 'rich-image', src: 'https://example.com/img.png', alt: 'photo' },
    ])
  })

  it('parses a rich-youtube block with videoId', () => {
    const input =
      '```rich-youtube\n{"videoId":"dQw4w9WgXcQ","title":"Never Gonna Give You Up"}\n```'
    const result = parseRichBlocks(input)
    expect(result).toEqual([
      { type: 'rich-youtube', videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up' },
    ])
  })

  it('parses a rich-youtube block with URL fallback', () => {
    const input = '```rich-youtube\n{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}\n```'
    const result = parseRichBlocks(input)
    expect(result).toEqual([{ type: 'rich-youtube', videoId: 'dQw4w9WgXcQ', title: undefined }])
  })

  it('parses a rich-html block (no JSON parsing)', () => {
    const input = '```rich-html\n<div>Hello</div>\n```'
    const result = parseRichBlocks(input)
    expect(result).toEqual([{ type: 'rich-html', html: '<div>Hello</div>' }])
  })

  it('handles malformed JSON gracefully by keeping as text', () => {
    const input = '```rich-map\n{invalid json}\n```'
    const result = parseRichBlocks(input)
    expect(result).toEqual([{ type: 'text', text: input }])
  })

  it('handles missing required fields by keeping as text', () => {
    const input = '```rich-map\n{"label":"no address"}\n```'
    const result = parseRichBlocks(input)
    expect(result).toEqual([{ type: 'text', text: input }])
  })

  it('handles unknown block type by keeping as text', () => {
    const input = '```rich-unknown\n{"foo":"bar"}\n```'
    const result = parseRichBlocks(input)
    expect(result).toEqual([{ type: 'text', text: input }])
  })

  it('handles empty input', () => {
    const result = parseRichBlocks('')
    expect(result).toEqual([{ type: 'text', text: '' }])
  })

  it('handles whitespace-only input', () => {
    const result = parseRichBlocks('   ')
    expect(result).toEqual([{ type: 'text', text: '   ' }])
  })

  it('mixes text and rich blocks', () => {
    const input = 'Before\n```rich-map\n{"address":"123 Main"}\n```\nAfter'
    const result = parseRichBlocks(input)
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ type: 'text', text: 'Before\n' })
    expect(result[1]).toEqual({ type: 'rich-map', address: '123 Main', label: undefined })
    expect(result[2]).toEqual({ type: 'text', text: '\nAfter' })
  })

  it('parses multiple rich blocks', () => {
    const input = '```rich-map\n{"address":"A"}\n```\n```rich-image\n{"src":"http://img.png"}\n```'
    const result = parseRichBlocks(input)
    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('rich-map')
    expect(result[1].type).toBe('rich-image')
  })

  it('returns empty html block as text for empty rich-html', () => {
    const input = '```rich-html\n   \n```'
    const result = parseRichBlocks(input)
    expect(result).toEqual([{ type: 'text', text: input }])
  })
})
