import { describe, test, expect } from 'bun:test'
import { markdownToTelegramHtml, splitHtmlMessage } from './format-telegram.js'

describe('markdownToTelegramHtml', () => {
  test('escapes HTML entities', () => {
    expect(markdownToTelegramHtml('Tom & Jerry <script>')).toBe(
      'Tom &amp; Jerry &lt;script&gt;',
    )
  })

  test('converts headings to bold', () => {
    expect(markdownToTelegramHtml('### My heading')).toBe('<b>My heading</b>')
    expect(markdownToTelegramHtml('# H1')).toBe('<b>H1</b>')
    expect(markdownToTelegramHtml('## H2')).toBe('<b>H2</b>')
  })

  test('converts bold **text**', () => {
    expect(markdownToTelegramHtml('This is **bold** text')).toBe(
      'This is <b>bold</b> text',
    )
  })

  test('converts italic *text*', () => {
    expect(markdownToTelegramHtml('This is *italic* text')).toBe(
      'This is <i>italic</i> text',
    )
  })

  test('converts bullet points and does not treat them as italic', () => {
    const input = '* First item\n* Second item\n- Third item'
    const result = markdownToTelegramHtml(input)
    expect(result).toBe('• First item\n• Second item\n• Third item')
  })

  test('converts inline code', () => {
    expect(markdownToTelegramHtml('Use `foo()` here')).toBe(
      'Use <code>foo()</code> here',
    )
  })

  test('escapes HTML inside inline code', () => {
    expect(markdownToTelegramHtml('Use `<div>` tag')).toBe(
      'Use <code>&lt;div&gt;</code> tag',
    )
  })

  test('converts fenced code blocks', () => {
    const input = '```js\nconsole.log(1)\n```'
    expect(markdownToTelegramHtml(input)).toBe('<pre>console.log(1)</pre>')
  })

  test('escapes HTML inside code blocks', () => {
    const input = '```\n<div class="a">\n```'
    expect(markdownToTelegramHtml(input)).toBe(
      '<pre>&lt;div class="a"&gt;</pre>',
    )
  })

  test('does not apply formatting inside code blocks', () => {
    const input = '```\n**not bold** *not italic*\n```'
    const result = markdownToTelegramHtml(input)
    expect(result).not.toContain('<b>')
    expect(result).not.toContain('<i>')
    expect(result).toContain('**not bold** *not italic*')
  })

  test('converts links', () => {
    expect(markdownToTelegramHtml('[Google](https://google.com)')).toBe(
      '<a href="https://google.com">Google</a>',
    )
  })

  test('handles combined formatting', () => {
    const input =
      '### 1. **Tensión Militar**\nEl presidente **Petro** denunció.\n* **El incidente:** Se halló una bomba.\n* **Contexto:** EE.UU. y Ecuador.'
    const result = markdownToTelegramHtml(input)

    expect(result).toContain('<b>1. <b>Tensión Militar</b></b>')
    expect(result).toContain('<b>Petro</b>')
    expect(result).toContain('• <b>El incidente:</b>')
    expect(result).toContain('• <b>Contexto:</b>')
    expect(result).not.toContain('###')
    expect(result).not.toContain('**')
  })
})

describe('splitHtmlMessage', () => {
  test('returns single part if under limit', () => {
    const parts = splitHtmlMessage('Hello world', 4096)
    expect(parts).toEqual(['Hello world'])
  })

  test('splits at newline boundaries', () => {
    const line = 'A'.repeat(50)
    const input = `${line}\n${line}\n${line}`
    const parts = splitHtmlMessage(input, 105)
    expect(parts.length).toBe(2)
    expect(parts[0]).toBe(`${line}\n${line}`)
  })

  test('closes and reopens tags at split boundaries', () => {
    const longText = 'word '.repeat(500)
    const input = `<b>${longText}</b>`
    const parts = splitHtmlMessage(input, 200)

    expect(parts.length).toBeGreaterThan(1)
    // First part should end with </b>
    expect(parts[0]).toEndWith('</b>')
    // Second part should start with <b>
    expect(parts[1]).toStartWith('<b>')
  })
})
