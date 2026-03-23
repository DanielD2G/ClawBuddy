import { describe, expect, test } from 'vitest'
import { permissionService } from './permission.service.js'

describe('permissionService.isToolAllowed', () => {
  test('allows exact docker subcommands when the saved rule ends with wildcard args', () => {
    const allowed = permissionService.isToolAllowed(
      {
        name: 'docker_command',
        arguments: { command: 'ps' },
      } as never,
      ['Docker(ps *)'],
    )

    expect(allowed).toBe(true)
  })

  test('still allows docker subcommands with additional args', () => {
    const allowed = permissionService.isToolAllowed(
      {
        name: 'docker_command',
        arguments: { command: 'ps -a' },
      } as never,
      ['Docker(ps *)'],
    )

    expect(allowed).toBe(true)
  })
})
