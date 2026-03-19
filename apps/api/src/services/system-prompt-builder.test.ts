import { describe, expect, test } from 'bun:test'
import { buildSystemPrompt } from './system-prompt-builder.js'

describe('buildSystemPrompt', () => {
  test('builds a structured prompt with runtime context and capability blocks', () => {
    const prompt = buildSystemPrompt(
      [
        {
          name: 'Browser Automation',
          systemPrompt: 'Use run_browser_script step by step.',
        },
      ],
      'America/New_York',
      new Date('2026-03-18T18:45:00.000Z'),
    )

    expect(prompt).toContain('<role>')
    expect(prompt).toContain('Current date: Wednesday, March 18, 2026')
    expect(prompt).toContain('Current time: 02:45 PM (America/New_York)')
    expect(prompt).toContain('User locale hint: New York')
    expect(prompt).toContain('<instruction_priority>')
    expect(prompt).toContain('<decision_flow>')
    expect(prompt).toContain('<capabilities>')
    expect(prompt).toContain('<capability name="Browser Automation">')
    expect(prompt).toContain('Use run_browser_script step by step.')
  })

  test('omits the capabilities section when nothing is loaded', () => {
    const prompt = buildSystemPrompt([], 'UTC', new Date('2026-03-18T00:00:00.000Z'))

    expect(prompt).not.toContain('<capabilities>')
    expect(prompt).toContain('If a tool fails, explain the failure clearly to the user.')
    expect(prompt).toContain(
      'If the failure came from an obvious mistake in your immediately previous tool call, you may correct it once with the same safe tool.',
    )
  })

  test('escapes capability names when rendering capability blocks', () => {
    const prompt = buildSystemPrompt(
      [{ name: 'Google "Workspace" & Docs', systemPrompt: 'Use the workspace tools.' }],
      'UTC',
      new Date('2026-03-18T00:00:00.000Z'),
    )

    expect(prompt).toContain('<capability name="Google &quot;Workspace&quot; &amp; Docs">')
  })
})
