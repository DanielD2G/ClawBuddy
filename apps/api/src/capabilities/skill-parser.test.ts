import { describe, expect, test } from 'vitest'
import { parseSkillFile, parseSkillSource } from './skill-parser.js'

describe('skill-parser', () => {
  test('parses legacy .skill JSON files', () => {
    const result = parseSkillFile({
      name: 'Bash Shell',
      slug: 'bash',
      description: 'Execute bash commands in a sandboxed environment.',
      version: '1.0.0',
      type: 'bash',
      networkAccess: false,
      instructions: 'Use bash carefully.',
      tools: [
        {
          name: 'run_bash',
          description: 'Execute bash commands.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
            },
            required: ['command'],
          },
        },
      ],
    })

    expect(result.format).toBe('json')
    expect(result.storageExtension).toBe('.skill')
    expect(result.skill.slug).toBe('bash')
    expect(result.dbData.systemPrompt).toBe('Use bash carefully.')
  })

  test('parses Markdown skills with OpenCode frontmatter and clawbuddy config', () => {
    const result = parseSkillSource(`---
name: bash
description: Execute bash commands in a sandboxed environment.
compatibility: opencode
metadata:
  audience: operators
clawbuddy:
  displayName: Bash Shell
  version: 1.0.0
  icon: Terminal
  category: general
  type: bash
  networkAccess: false
  installation: apt-get update
  tools:
    - name: run_bash
      description: Execute bash commands.
      parameters:
        type: object
        properties:
          command:
            type: string
            description: Command to execute
        required:
          - command
  inputs:
    workspace:
      type: var
      default: /workspace
---
Use this skill when you need shell access.
`)

    expect(result.format).toBe('markdown')
    expect(result.storageExtension).toBe('.md')
    expect(result.skill.slug).toBe('bash')
    expect(result.skill.name).toBe('Bash Shell')
    expect(result.skill.instructions).toBe('Use this skill when you need shell access.')
    expect(result.dbData.installationScript).toBe('apt-get update')
    expect(result.dbData.skillType).toBe('bash')
  })

  test('requires clawbuddy.type or clawbuddy.tag for Markdown skills', () => {
    expect(() =>
      parseSkillSource(`---
name: bash
description: Execute bash commands in a sandboxed environment.
clawbuddy:
  tools:
    - name: run_bash
      description: Execute bash commands.
      parameters:
        type: object
        properties:
          command:
            type: string
---
Use this skill when you need shell access.
`),
    ).toThrow('clawbuddy.type is required')
  })
})
