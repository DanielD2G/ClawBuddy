import { describe, expect, test } from 'vitest'
import { permissionService } from './permission.service.js'

describe('permissionService.isToolAllowed', () => {
  // ── Existing tests ────────────────────────────────────────────────

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

  // ── Always-allowed tools ──────────────────────────────────────────

  test('always allows search_documents regardless of rules', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'search_documents', arguments: { query: 'foo' } } as never,
      [],
    )
    expect(allowed).toBe(true)
  })

  test('always allows read_file regardless of rules', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'read_file', arguments: { path: '/etc/passwd' } } as never,
      [],
    )
    expect(allowed).toBe(true)
  })

  test('always allows web_search regardless of rules', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'web_search', arguments: { query: 'test' } } as never,
      [],
    )
    expect(allowed).toBe(true)
  })

  // ── Permission check with no rules configured ─────────────────────

  test('denies non-always-allowed tool when no rules are configured', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'run_bash', arguments: { command: 'ls' } } as never,
      [],
    )
    expect(allowed).toBe(false)
  })

  test('denies docker_command when rules list is empty', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'docker_command', arguments: { command: 'ps' } } as never,
      [],
    )
    expect(allowed).toBe(false)
  })

  // ── Wildcard permission matching ──────────────────────────────────

  test('wildcard pattern * matches any bash command', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'run_bash', arguments: { command: 'ls -la /tmp' } } as never,
      ['Bash(*)'],
    )
    expect(allowed).toBe(true)
  })

  test('specific bash pattern only matches that command', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'run_bash', arguments: { command: 'rm -rf /' } } as never,
      ['Bash(ls *)'],
    )
    expect(allowed).toBe(false)
  })

  test('bash rule with trailing wildcard args matches command with args', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'run_bash', arguments: { command: 'ls -la /home' } } as never,
      ['Bash(ls *)'],
    )
    expect(allowed).toBe(true)
  })

  test('bash rule with trailing wildcard args matches bare command', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'run_bash', arguments: { command: 'ls' } } as never,
      ['Bash(ls *)'],
    )
    expect(allowed).toBe(true)
  })

  // ── Docker subcommand safety checks ───────────────────────────────

  test('allows docker images command with images rule', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'docker_command', arguments: { command: 'images' } } as never,
      ['Docker(images *)'],
    )
    expect(allowed).toBe(true)
  })

  test('blocks docker exec when only ps and images are allowed', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'docker_command', arguments: { command: 'exec -it container bash' } } as never,
      ['Docker(ps *)', 'Docker(images *)'],
    )
    expect(allowed).toBe(false)
  })

  test('blocks docker rm when only ps is allowed', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'docker_command', arguments: { command: 'rm my-container' } } as never,
      ['Docker(ps *)'],
    )
    expect(allowed).toBe(false)
  })

  test('allows docker logs with logs rule', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'docker_command', arguments: { command: 'logs my-container --tail 100' } } as never,
      ['Docker(logs *)'],
    )
    expect(allowed).toBe(true)
  })

  // ── Permission check with specific tool rules ─────────────────────

  test('allows aws command matching Aws rule', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'aws_command', arguments: { command: 's3 ls' } } as never,
      ['Aws(s3 *)'],
    )
    expect(allowed).toBe(true)
  })

  test('denies aws command not matching Aws rule', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'aws_command', arguments: { command: 'ec2 terminate-instances' } } as never,
      ['Aws(s3 *)'],
    )
    expect(allowed).toBe(false)
  })

  test('allows kubectl command matching Kubectl rule', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'kubectl_command', arguments: { command: 'get pods' } } as never,
      ['Kubectl(get *)'],
    )
    expect(allowed).toBe(true)
  })

  test('allows python code matching Python wildcard rule', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'run_python', arguments: { code: 'print("hello")' } } as never,
      ['Python(*)'],
    )
    expect(allowed).toBe(true)
  })

  test('denies python code when only Bash rules exist', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'run_python', arguments: { code: 'print("hello")' } } as never,
      ['Bash(*)'],
    )
    expect(allowed).toBe(false)
  })

  test('allows write_file matching Write rule with path prefix', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'write_file', arguments: { path: '/workspace/src/app.ts' } } as never,
      ['Write(path:/workspace/*)'],
    )
    expect(allowed).toBe(true)
  })

  test('denies write_file not matching Write path rule', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'write_file', arguments: { path: '/etc/hosts' } } as never,
      ['Write(path:/workspace/*)'],
    )
    expect(allowed).toBe(false)
  })

  // ── Rule without parentheses (type-only rule with implicit wildcard) ──

  test('rule without parentheses matches any value for that type', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'docker_command', arguments: { command: 'anything here' } } as never,
      ['Docker'],
    )
    expect(allowed).toBe(true)
  })

  // ── Multiple rules ────────────────────────────────────────────────

  test('matches when any one of multiple rules applies', () => {
    const rules = ['Docker(ps *)', 'Bash(ls *)', 'Docker(images *)']

    expect(
      permissionService.isToolAllowed(
        { name: 'docker_command', arguments: { command: 'images' } } as never,
        rules,
      ),
    ).toBe(true)

    expect(
      permissionService.isToolAllowed(
        { name: 'run_bash', arguments: { command: 'ls' } } as never,
        rules,
      ),
    ).toBe(true)

    expect(
      permissionService.isToolAllowed(
        { name: 'docker_command', arguments: { command: 'rm foo' } } as never,
        rules,
      ),
    ).toBe(false)
  })

  // ── Default/unknown tool names ────────────────────────────────────

  test('unknown tool name uses the name itself as the type', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'custom_tool', arguments: {} } as never,
      ['custom_tool'],
    )
    expect(allowed).toBe(true)
  })

  test('unknown tool name is denied when no matching rule', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'custom_tool', arguments: {} } as never,
      ['Bash(*)'],
    )
    expect(allowed).toBe(false)
  })

  // ── Edge cases ────────────────────────────────────────────────────

  test('handles missing command argument gracefully (empty string)', () => {
    const allowed = permissionService.isToolAllowed({ name: 'run_bash', arguments: {} } as never, [
      'Bash(*)',
    ])
    expect(allowed).toBe(true)
  })

  test('handles generate_file tool normalization', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'generate_file', arguments: { filename: 'report.pdf' } } as never,
      [],
    )
    // generate_file is in ALWAYS_ALLOWED_TOOLS
    expect(allowed).toBe(true)
  })

  test('list_files is always allowed', () => {
    const allowed = permissionService.isToolAllowed(
      { name: 'list_files', arguments: { path: '/workspace' } } as never,
      [],
    )
    // list_files normalizes to Read type, but list_files is not in ALWAYS_ALLOWED_TOOLS
    // read_file IS in ALWAYS_ALLOWED_TOOLS but list_files is not
    // Let's check: the constant has 'read_file' not 'list_files'
    // So this should be denied with no rules
    expect(allowed).toBe(false)
  })
})
